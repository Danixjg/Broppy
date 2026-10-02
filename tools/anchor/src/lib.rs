//! Anchors the Brain's signed Merkle batch roots outside the server that wrote them.
//!
//! The audit log signs each batch, but whoever holds the signing key and the log file could rewrite both.
//! Copying every root into an append-only file in a separate repository makes that rewrite visible:
//! `verify` fails when the log disagrees with an anchor that was already published.

use ed25519_dalek::pkcs8::DecodePublicKey;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
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

/// Reads the batches from the API's JSONL audit log and checks each signature and the root chain.
pub fn read_batches(log: &Path, key: &VerifyingKey) -> Result<Vec<Batch>, String> {
    let text = fs::read_to_string(log).map_err(|e| format!("cannot read audit log: {e}"))?;
    if !text.is_empty() && !text.ends_with('\n') {
        return Err("audit log ends with an incomplete record".into());
    }
    let mut batches: Vec<Batch> = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let record: serde_json::Value =
            serde_json::from_str(line).map_err(|_| format!("audit log line {} is not JSON", index + 1))?;
        if record.get("kind").and_then(|k| k.as_str()) != Some("batch") {
            continue;
        }
        let batch: Batch = serde_json::from_value(record["value"].clone())
            .map_err(|e| format!("audit log line {}: bad batch: {e}", index + 1))?;
        check_batch(&batch, batches.last(), key).map_err(|e| format!("audit log line {}: {e}", index + 1))?;
        batches.push(batch);
    }
    Ok(batches)
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
