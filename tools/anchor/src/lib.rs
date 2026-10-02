//! Anchors the Brain's signed Merkle batch roots outside the server that wrote them.
//!
//! The audit log signs each batch, but whoever holds the signing key and the log file could rewrite both.
//! Copying every root into an append-only file in a separate repository makes that rewrite visible:
//! `verify` fails when the log disagrees with an anchor that was already published.

use ed25519_dalek::pkcs8::DecodePublicKey;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// A signed batch as the API writes it. Field order of the signed payload matters (see `payload`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub first_sequence: u64,
    pub last_sequence: u64,
    pub root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_root: Option<String>,
    pub sealed_at: String,
    #[serde(default)]
    pub signature: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Payload<'a> {
    first_sequence: u64,
    last_sequence: u64,
    root: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_root: &'a Option<String>,
    sealed_at: &'a str,
}

/// The exact bytes the API signed: the same keys, in the same order, as `batchPayload` in packages/audit.
fn payload(batch: &Batch) -> Vec<u8> {
    serde_json::to_vec(&Payload {
        first_sequence: batch.first_sequence,
        last_sequence: batch.last_sequence,
        root: &batch.root,
        previous_root: &batch.previous_root,
        sealed_at: &batch.sealed_at,
    })
    .expect("payload serializes")
}

fn sha256_hex(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

/// The Merkle root over a batch's entry hashes, built as packages/audit builds it: each pair hashed as "left:right",
/// and an odd last hash paired with itself.
pub fn merkle_root(leaves: &[String]) -> Option<String> {
    let mut level = leaves.to_vec();
    while level.len() > 1 {
        level = level.chunks(2).map(|pair| sha256_hex(&format!("{}:{}", pair[0], pair.get(1).unwrap_or(&pair[0])))).collect();
    }
    level.pop()
}

/// Object keys sorted, as packages/audit's `canonical` sorts them for hash version 2. It uses `localeCompare`, which
/// agrees with this character order for the camelCase keys the API writes; a key where they ever differed would show
/// as a changed entry, never as a pass.
fn canonical(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            Value::Object(keys.into_iter().map(|key| (key.clone(), canonical(&map[key]))).collect())
        }
        other => other.clone(),
    }
}

/// The hash packages/audit gives an entry: SHA-256 of these fields as JSON, in this order. Numbers keep the text the
/// log was written with, so they hash exactly as they did in TypeScript.
pub fn entry_hash(entry: &Value) -> Option<String> {
    let version = entry.get("hashVersion").filter(|v| v.as_u64().is_some_and(|n| n > 0));
    let mut fields = serde_json::Map::new();
    if let Some(version) = version {
        fields.insert("hashVersion".into(), version.clone());
    }
    for name in ["sequence", "timestamp", "type", "actor"] {
        fields.insert(name.into(), entry.get(name)?.clone());
    }
    let data = entry.get("data")?;
    let sorted = version.and_then(Value::as_u64) == Some(2);
    fields.insert("data".into(), if sorted { canonical(data) } else { data.clone() });
    fields.insert("previousHash".into(), entry.get("previousHash")?.clone());
    serde_json::to_string(&Value::Object(fields)).ok().map(|json| sha256_hex(&json))
}

fn is_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn load_key(path: &Path) -> Result<VerifyingKey, String> {
    let pem = fs::read_to_string(path).map_err(|e| format!("cannot read public key: {e}"))?;
    if pem.contains("PRIVATE KEY") {
        return Err("give the PUBLIC key; this tool never needs the private key".into());
    }
    VerifyingKey::from_public_key_pem(&pem).map_err(|e| format!("not an Ed25519 public key: {e}"))
}

/// Reads the API's JSONL audit log and checks all of it: every entry's hash against its content, the chain between
/// entries, each batch's signature and root chain, and each batch's root against the entries it covers. Returns the
/// batches; the first problem found is the error.
pub fn read_batches(log: &Path, key: &VerifyingKey) -> Result<Vec<Batch>, String> {
    let text = fs::read_to_string(log).map_err(|e| format!("cannot read audit log: {e}"))?;
    if !text.is_empty() && !text.ends_with('\n') {
        return Err("audit log ends with an incomplete record".into());
    }
    let mut hashes: Vec<String> = Vec::new();
    let mut batches: Vec<Batch> = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let at = |problem: String| format!("audit log line {}: {problem}", index + 1);
        let record: Value = serde_json::from_str(line).map_err(|_| at("not JSON".into()))?;
        match record.get("kind").and_then(Value::as_str) {
            Some("entry") => hashes.push(check_entry(&record["value"], &hashes).map_err(at)?),
            Some("batch") => {
                let batch: Batch = serde_json::from_value(record["value"].clone())
                    .map_err(|e| at(format!("bad batch: {e}")))?;
                check_batch(&batch, batches.last(), key).map_err(at)?;
                let covered = hashes.get(batch.first_sequence as usize - 1..batch.last_sequence as usize)
                    .ok_or_else(|| at(format!("batch covers entries {}-{}, which are not all in the log",
                        batch.first_sequence, batch.last_sequence)))?;
                if merkle_root(covered).as_deref() != Some(batch.root.as_str()) {
                    return Err(at(format!("batch {} (entries {}-{}) does not match its entries: they were changed",
                        batches.len() + 1, batch.first_sequence, batch.last_sequence)));
                }
                batches.push(batch);
            }
            _ => continue,
        }
    }
    Ok(batches)
}

/// Checks one entry against the ones before it, and returns its hash.
fn check_entry(entry: &Value, before: &[String]) -> Result<String, String> {
    let sequence = entry.get("sequence").and_then(Value::as_u64).ok_or("entry has no sequence")?;
    let expected = before.len() as u64 + 1;
    if sequence != expected {
        return Err(format!("entry {sequence} found where entry {expected} was expected: entries were deleted or reordered"));
    }
    let previous = before.last().map_or(GENESIS, String::as_str);
    if entry.get("previousHash").and_then(Value::as_str) != Some(previous) {
        return Err(format!("entry {sequence} does not follow entry {}: the chain is broken", sequence - 1));
    }
    let stored = entry.get("hash").and_then(Value::as_str).filter(|h| is_hash(h)).ok_or("entry has no hash")?;
    if entry_hash(entry).as_deref() != Some(stored) {
        return Err(format!("entry {sequence} was changed: its hash no longer matches its content"));
    }
    Ok(stored.to_string())
}

fn check_batch(batch: &Batch, previous: Option<&Batch>, key: &VerifyingKey) -> Result<(), String> {
    if !is_hash(&batch.root) || batch.first_sequence < 1 || batch.last_sequence < batch.first_sequence {
        return Err("malformed batch".into());
    }
    let expected_first = previous.map_or(1, |p| p.last_sequence + 1);
    if batch.first_sequence != expected_first {
        return Err(format!("batch starts at {} but {} was expected", batch.first_sequence, expected_first));
    }
    let expected_root = previous.map_or(GENESIS, |p| p.root.as_str());
    if batch.previous_root.as_deref().is_some_and(|r| r != expected_root) {
        return Err("batch does not continue the previous root".into());
    }
    let signature = batch.signature.as_deref().ok_or("batch is not signed")?;
    let bytes = hex::decode(signature).map_err(|_| "signature is not hex")?;
    let signature = Signature::from_slice(&bytes).map_err(|_| "signature has the wrong length")?;
    key.verify(&payload(batch), &signature).map_err(|_| "signature does not verify".to_string())
}

fn read_anchors(path: &Path) -> Result<Vec<Batch>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path).map_err(|e| format!("cannot read anchors: {e}"))?;
    text.lines()
        .enumerate()
        .map(|(i, l)| serde_json::from_str(l).map_err(|_| format!("anchors line {} is not valid", i + 1)))
        .collect()
}

/// Where the live log and the anchors disagree. Empty means the anchors are a prefix of the log.
pub fn divergences(batches: &[Batch], anchors: &[Batch]) -> Vec<String> {
    let mut problems = Vec::new();
    for (index, anchor) in anchors.iter().enumerate() {
        match batches.get(index) {
            None => problems.push(format!(
                "anchored batch {} (sequences {}-{}) is missing from the log: batches were deleted",
                index + 1, anchor.first_sequence, anchor.last_sequence
            )),
            Some(batch) if batch.root != anchor.root || batch.first_sequence != anchor.first_sequence
                || batch.last_sequence != anchor.last_sequence || batch.sealed_at != anchor.sealed_at =>
                problems.push(format!(
                    "batch {} (sequences {}-{}) differs from its anchor: the log was rewritten",
                    index + 1, anchor.first_sequence, anchor.last_sequence
                )),
            Some(_) => {}
        }
    }
    problems
}

/// Appends batches the anchors don't have yet. Anchors are never rewritten; a mismatch aborts without writing.
pub fn publish(log: &Path, key: &VerifyingKey, anchors_path: &Path) -> Result<usize, String> {
    let batches = read_batches(log, key)?;
    let anchors = read_anchors(anchors_path)?;
    let problems = divergences(&batches, &anchors);
    if !problems.is_empty() {
        return Err(format!("refusing to publish:\n  {}", problems.join("\n  ")));
    }
    let fresh = &batches[anchors.len()..];
    if fresh.is_empty() {
        return Ok(0);
    }
    let mut out = String::new();
    for batch in fresh {
        out.push_str(&serde_json::to_string(batch).expect("batch serializes"));
        out.push('\n');
    }
    use std::io::Write;
    let mut file = fs::OpenOptions::new().create(true).append(true).open(anchors_path)
        .map_err(|e| format!("cannot write anchors: {e}"))?;
    file.write_all(out.as_bytes()).and_then(|_| file.sync_all()).map_err(|e| format!("cannot write anchors: {e}"))?;
    Ok(fresh.len())
}

/// Ok(n) when the log still matches the n anchored batches.
pub fn verify(log: &Path, key: &VerifyingKey, anchors_path: &Path) -> Result<usize, Vec<String>> {
    let batches = read_batches(log, key).map_err(|e| vec![e])?;
    let anchors = read_anchors(anchors_path).map_err(|e| vec![e])?;
    let problems = divergences(&batches, &anchors);
    if problems.is_empty() { Ok(anchors.len()) } else { Err(problems) }
}
