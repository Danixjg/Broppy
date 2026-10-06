use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn digest(bytes: &str) -> String {
    hex::encode(Sha256::digest(bytes.as_bytes()))
}

fn pair(left: &str, right: &str) -> String {
    digest(&format!("{left}:{right}"))
}

fn hash(value: &Value) -> Option<&str> {
    value.as_str().filter(|value| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn integer(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    ((0.0..=MAX_SAFE_INTEGER).contains(&number) && number.fract() == 0.0).then_some(number as u64)
}

fn root(mut leaves: Vec<String>) -> Result<String, String> {
    if leaves.is_empty() {
        return Err("Empty Merkle batch".to_string());
    }
    while leaves.len() > 1 {
        leaves = leaves
            .chunks(2)
            .map(|chunk| pair(&chunk[0], chunk.get(1).unwrap_or(&chunk[0])))
            .collect();
    }
    Ok(leaves.pop().unwrap())
}

fn leaves(entries: &[Value]) -> Vec<String> {
    entries
        .iter()
        .map(|entry| entry["hash"].as_str().unwrap_or_default().to_string())
        .collect()
}

fn first_broken(entries: &[Value], payloads: &[Value]) -> Option<usize> {
    let mut previous = GENESIS;
    for (index, entry) in entries.iter().enumerate() {
        if integer(&entry["sequence"]) != Some(index as u64 + 1)
            || entry["previousHash"] != previous
        {
            return Some(index + 1);
        }
        let Some(entry_hash) = hash(&entry["hash"]) else {
            return Some(index + 1);
        };
        let Some(payload) = payloads.get(index).and_then(Value::as_str) else {
            return Some(index + 1);
        };
        if digest(payload) != entry_hash {
            return Some(index + 1);
        }
        previous = entry_hash;
    }
    None
}

fn verify_batches(entries: &[Value], batches: &[Value]) -> bool {
    let mut next_sequence = 1_u64;
    let mut previous_root = GENESIS;
    for batch in batches {
        let Some(last_sequence) = integer(&batch["lastSequence"]) else {
            return false;
        };
        let Some(batch_root) = hash(&batch["root"]) else {
            return false;
        };
        if integer(&batch["firstSequence"]) != Some(next_sequence)
            || last_sequence < next_sequence
            || last_sequence > entries.len() as u64
            || batch
                .get("previousRoot")
                .is_some_and(|root| root != previous_root)
        {
            return false;
        }
        if root(leaves(
            &entries[next_sequence as usize - 1..last_sequence as usize],
        ))
        .ok()
        .as_deref()
            != Some(batch_root)
        {
            return false;
        }
        previous_root = batch_root;
        next_sequence = last_sequence + 1;
    }
    true
}

fn proof(entries: &[Value], batches: &[Value], sequence: u64) -> Option<Value> {
    if sequence == 0 || sequence > entries.len() as u64 {
        return None;
    }
    let batch = batches.iter().find(|batch| {
        integer(&batch["firstSequence"]).is_some_and(|first| sequence >= first)
            && integer(&batch["lastSequence"]).is_some_and(|last| sequence <= last)
    })?;
    let first = integer(&batch["firstSequence"])?;
    let last = integer(&batch["lastSequence"])?;
    if first == 0 || last > entries.len() as u64 {
        return None;
    }
    let mut level = leaves(&entries[first as usize - 1..last as usize]);
    let mut index = (sequence - first) as usize;
    let mut siblings = Vec::new();
    while level.len() > 1 {
        let sibling_index = index ^ 1;
        siblings.push(json!({
            "hash": level.get(sibling_index).unwrap_or(&level[index]),
            "position": if sibling_index < index { "left" } else { "right" }
        }));
        level = level
            .chunks(2)
            .map(|chunk| pair(&chunk[0], chunk.get(1).unwrap_or(&chunk[0])))
            .collect();
        index /= 2;
    }
    let entry = &entries[sequence as usize - 1];
    Some(
        json!({"sequence":sequence, "firstSequence":first, "lastSequence":last,
        "entry":entry, "leaf":entry["hash"], "root":batch["root"], "siblings":siblings}),
    )
}

fn verify_proof(item: &Value, trusted: &Value, payload: &Value) -> bool {
    let trusted_root = if trusted.is_string() {
        hash(trusted)
    } else {
        hash(&trusted["root"])
    };
    let Some(trusted_root) = trusted_root else {
        return false;
    };
    let Some(leaf) = hash(&item["leaf"]) else {
        return false;
    };
    if item["root"] != trusted_root
        || (!trusted.is_string()
            && (item["firstSequence"] != trusted["firstSequence"]
                || item["lastSequence"] != trusted["lastSequence"]))
    {
        return false;
    }
    let Some(sequence) = integer(&item["sequence"]) else {
        return false;
    };
    let Some(first) = integer(&item["firstSequence"]) else {
        return false;
    };
    let Some(last) = integer(&item["lastSequence"]) else {
        return false;
    };
    let Some(siblings) = item["siblings"].as_array() else {
        return false;
    };
    let Some(payload) = payload.as_str() else {
        return false;
    };
    let entry = &item["entry"];
    if first == 0
        || sequence < first
        || sequence > last
        || integer(&entry["sequence"]) != Some(sequence)
        || entry["hash"] != leaf
        || hash(&entry["previousHash"]).is_none()
        || digest(payload) != leaf
    {
        return false;
    }
    let mut current = leaf.to_string();
    let mut index = sequence - first;
    let mut width = last - first + 1;
    let mut depth = 0;
    while width > 1 {
        let Some(sibling) = siblings.get(depth) else {
            return false;
        };
        let Some(sibling_hash) = hash(&sibling["hash"]) else {
            return false;
        };
        let position = if index % 2 == 1 { "left" } else { "right" };
        if sibling["position"] != position
            || (index % 2 == 0 && index + 1 == width && sibling_hash != current)
        {
            return false;
        }
        current = if position == "left" {
            pair(sibling_hash, &current)
        } else {
            pair(&current, sibling_hash)
        };
        index /= 2;
        width = width.div_ceil(2);
        depth += 1;
    }
    depth == siblings.len() && current == trusted_root
}

fn parse_records(content: &str) -> Result<Value, String> {
    let mut entries = Vec::new();
    let mut batches = Vec::new();
    if !content.is_empty() && !content.ends_with('\n') {
        return Err("Incomplete audit record".to_string());
    }
    let mut next_sequence = 1_u64;
    let mut next_batch_sequence = 1_u64;
    for line in content
        .strip_suffix('\n')
        .unwrap_or_default()
        .split('\n')
        .filter(|_| !content.is_empty())
    {
        let record: Value = serde_json::from_str(line).map_err(|_| "Invalid audit record")?;
        let value = &record["value"];
        match record["kind"].as_str() {
            Some("entry") => {
                if integer(&value["sequence"]) != Some(next_sequence) {
                    return Err("Invalid audit record order".to_string());
                }
                next_sequence += 1;
                entries.push(value.clone());
            }
            Some("batch") => {
                let last = integer(&value["lastSequence"]).ok_or("Invalid audit record order")?;
                if integer(&value["firstSequence"]) != Some(next_batch_sequence)
                    || last >= next_sequence
                {
                    return Err("Invalid audit record order".to_string());
                }
                next_batch_sequence = last + 1;
                batches.push(value.clone());
            }
            _ => return Err("Invalid audit record".to_string()),
        }
    }
    Ok(json!({"entries": entries, "batches": batches}))
}

pub fn dispatch(operation: &str, input: Value) -> Result<Value, String> {
    match operation {
        "audit.digest" => Ok(json!(digest(
            input["payload"].as_str().ok_or("Missing payload")?
        ))),
        "audit.root" => {
            let leaves: Vec<String> = serde_json::from_value(input["leaves"].clone())
                .map_err(|error| error.to_string())?;
            Ok(json!(root(leaves)?))
        }
        "audit.firstBroken" => {
            let entries = input["entries"].as_array().ok_or("Missing entries")?;
            let payloads = input["payloads"].as_array().ok_or("Missing payloads")?;
            Ok(json!(first_broken(entries, payloads)))
        }
        "audit.verifyBatches" => Ok(json!(verify_batches(
            input["entries"].as_array().ok_or("Missing entries")?,
            input["batches"].as_array().ok_or("Missing batches")?
        ))),
        "audit.proof" => Ok(integer(&input["sequence"])
            .and_then(|sequence| {
                proof(
                    input["entries"].as_array()?,
                    input["batches"].as_array()?,
                    sequence,
                )
            })
            .unwrap_or(Value::Null)),
        "audit.verifyProof" => Ok(json!(verify_proof(
            &input["proof"],
            &input["trusted"],
            &input["payload"]
        ))),
        "audit.parseRecords" => parse_records(input["content"].as_str().ok_or("Missing content")?),
        _ => Err(format!("Unknown audit operation: {operation}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Vec<Value>, Vec<Value>, Vec<Value>) {
        let mut previous = GENESIS.to_string();
        let mut entries = Vec::new();
        let mut payloads = Vec::new();
        for sequence in 1..=5 {
            let payload = format!("entry {sequence}");
            let hash = digest(&payload);
            entries.push(json!({"sequence": sequence, "hash": hash, "previousHash": previous}));
            payloads.push(json!(payload));
            previous = hash;
        }
        let batches = vec![
            json!({"firstSequence":1,"lastSequence":5,"root":root(leaves(&entries)).unwrap(),"previousRoot":GENESIS}),
        ];
        (entries, batches, payloads)
    }

    #[test]
    fn sha256_hashes_exact_serialized_bytes() {
        assert_eq!(
            digest("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_ne!(digest("{\"a\":1,\"b\":2}"), digest("{\"b\":2,\"a\":1}"));
        assert_eq!(root(Vec::new()).unwrap_err(), "Empty Merkle batch");
    }

    #[test]
    fn chain_identifies_content_and_sequence_tampering() {
        let (mut entries, batches, mut payloads) = fixture();
        assert_eq!(first_broken(&entries, &payloads), None);
        assert!(verify_batches(&entries, &batches));
        payloads[2] = json!("changed content");
        assert_eq!(first_broken(&entries, &payloads), Some(3));
        entries[1]["sequence"] = json!(9);
        assert_eq!(first_broken(&entries, &payloads), Some(2));
    }

    #[test]
    fn proofs_validate_odd_duplication_positions_payload_and_trusted_ranges() {
        let (entries, batches, payloads) = fixture();
        for sequence in 1..=5 {
            let item = proof(&entries, &batches, sequence).unwrap();
            assert!(verify_proof(
                &item,
                &batches[0],
                &payloads[sequence as usize - 1]
            ));
        }
        let mut item = proof(&entries, &batches, 5).unwrap();
        item["siblings"][0]["hash"] = json!(GENESIS);
        assert!(!verify_proof(&item, &batches[0], &payloads[4]));
        item = proof(&entries, &batches, 5).unwrap();
        item["siblings"][0]["position"] = json!("left");
        assert!(!verify_proof(&item, &batches[0], &payloads[4]));
        let mut trusted = batches[0].clone();
        trusted["firstSequence"] = json!(2);
        assert!(!verify_proof(
            &proof(&entries, &batches, 5).unwrap(),
            &trusted,
            &payloads[4]
        ));
        assert!(!verify_proof(
            &proof(&entries, &batches, 5).unwrap(),
            &batches[0],
            &json!("changed")
        ));
    }

    #[test]
    fn records_reject_truncation_and_out_of_order_batches() {
        assert_eq!(
            parse_records("{\"kind\":\"entry\"").unwrap_err(),
            "Incomplete audit record"
        );
        assert_eq!(
            parse_records("{\"kind\":\"entry\",\"value\":{\"sequence\":2}}\n").unwrap_err(),
            "Invalid audit record order"
        );
        assert_eq!(
            parse_records(
                "{\"kind\":\"batch\",\"value\":{\"firstSequence\":1,\"lastSequence\":1}}\n"
            )
            .unwrap_err(),
            "Invalid audit record order"
        );
        assert_eq!(
            parse_records("").unwrap(),
            json!({"entries":[],"batches":[]})
        );
    }
}
