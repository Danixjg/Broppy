use std::fs;
use std::path::PathBuf;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

fn setup() -> (tempfile::TempDir, PathBuf, ed25519_dalek::VerifyingKey) {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("audit.jsonl");
    fs::copy(fixture("audit.jsonl"), &log).unwrap();
    (dir, log, brain_anchor::load_key(&fixture("test.pub")).unwrap())
}

#[test]
fn verifies_batches_signed_by_the_typescript_audit_log() {
    let (_dir, log, key) = setup();
    assert_eq!(brain_anchor::read_batches(&log, &key).unwrap().len(), 3);
}

#[test]
fn publishes_once_then_only_new_batches() {
    let (dir, log, key) = setup();
    let anchors = dir.path().join("anchors.jsonl");
    assert_eq!(brain_anchor::publish(&log, &key, &anchors).unwrap(), 3);
    assert_eq!(brain_anchor::publish(&log, &key, &anchors).unwrap(), 0);
    assert_eq!(brain_anchor::verify(&log, &key, &anchors).unwrap(), 3);
}

#[test]
fn a_rewritten_root_is_caught_and_never_published() {
    let (dir, log, key) = setup();
    let anchors = dir.path().join("anchors.jsonl");
    brain_anchor::publish(&log, &key, &anchors).unwrap();
    let before = fs::read_to_string(&anchors).unwrap();
    // Rewrite the log, as someone holding the file would: the root changes, so the signature breaks.
    let first_root = before.lines().next().unwrap().split("\"root\":\"").nth(1).unwrap()[..64].to_string();
    fs::write(&log, fs::read_to_string(&log).unwrap().replace(&first_root, &"a".repeat(64))).unwrap();
    assert!(brain_anchor::read_batches(&log, &key).is_err());
    assert!(brain_anchor::publish(&log, &key, &anchors).is_err());
    assert_eq!(fs::read_to_string(&anchors).unwrap(), before);
}

#[test]
fn deleted_batches_are_caught_even_when_the_rest_still_verifies() {
    let (dir, log, key) = setup();
    let anchors = dir.path().join("anchors.jsonl");
    brain_anchor::publish(&log, &key, &anchors).unwrap();
    // A log that simply stops after batch 2 is internally valid; only the anchor shows the loss.
    let text = fs::read_to_string(&log).unwrap();
    let last_batch = text.lines().filter(|l| l.contains("\"kind\":\"batch\"")).last().unwrap().to_string();
    let kept: Vec<String> = text.lines().filter(|l| *l != last_batch).map(String::from).collect();
    fs::write(&log, kept.join("\n") + "\n").unwrap();
    let problems = brain_anchor::verify(&log, &key, &anchors).unwrap_err();
    assert!(problems[0].contains("deleted"), "{problems:?}");
}

#[test]
fn refuses_a_private_key() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("k.pem");
    fs::write(&path, "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n").unwrap();
    assert!(brain_anchor::load_key(&path).unwrap_err().contains("PUBLIC"));
}

fn rewrite(log: &PathBuf, mut change: impl FnMut(usize, &mut serde_json::Value) -> bool) {
    let lines: Vec<String> = fs::read_to_string(log).unwrap().lines().enumerate().filter_map(|(i, line)| {
        let mut record: serde_json::Value = serde_json::from_str(line).unwrap();
        change(i, &mut record).then(|| serde_json::to_string(&record).unwrap())
    }).collect();
    fs::write(log, lines.join("\n") + "\n").unwrap();
}

#[test]
fn a_changed_entry_is_caught_even_when_its_batch_record_is_untouched() {
    let (_dir, log, key) = setup();
    rewrite(&log, |_, record| {
        if record["value"]["type"] == "query_received" && record["value"]["data"]["question"].as_str().is_some_and(|q| q.contains("Café")) {
            record["value"]["data"]["question"] = "What does PAY-101 need?".into();
        }
        true
    });
    let error = brain_anchor::read_batches(&log, &key).unwrap_err();
    assert!(error.contains("was changed"), "{error}");
}

#[test]
fn an_entry_rewritten_with_fresh_hashes_still_fails_its_batch_root() {
    let (_dir, log, key) = setup();
    // Someone who edits an entry and recomputes every later hash keeps the chain intact, but not the signed root.
    let mut previous = String::new();
    let mut edited = false;
    rewrite(&log, |_, record| {
        if record["kind"] == "entry" {
            let value = &mut record["value"];
            if !edited && value["type"] == "answer_returned" {
                value["data"]["answer"] = "Nothing to report.".into();
                edited = true;
            }
            if edited {
                value["previousHash"] = previous.clone().into();
                value["hash"] = brain_anchor::entry_hash(value).unwrap().into();
            }
            previous = value["hash"].as_str().unwrap().to_string();
        }
        true
    });
    let error = brain_anchor::read_batches(&log, &key).unwrap_err();
    assert!(error.contains("does not match its entries"), "{error}");
}

#[test]
fn a_deleted_entry_is_caught() {
    let (_dir, log, key) = setup();
    rewrite(&log, |_, record| !(record["kind"] == "entry" && record["value"]["sequence"] == 40));
    let error = brain_anchor::read_batches(&log, &key).unwrap_err();
    assert!(error.contains("deleted or reordered"), "{error}");
}
