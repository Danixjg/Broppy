use super::*;

fn check(output: &str, text: &str) -> Value {
    dispatch("grounding.checkAnswer", json!({
            "output": output,
            "allowed": [["jira:DB-12:0", { "docId": "jira:DB-12", "chunkId": "jira:DB-12:0", "title": "Migration status" }]],
            "evidence": [["jira:DB-12:0", text]]
        })).unwrap()
}

#[test]
fn lexical_contract_preserves_numbers_synonyms_and_clauses() {
    assert_eq!(
        dispatch("grounding.splitClauses", json!({ "sentence": "A.\n" })).unwrap(),
        json!(["A."])
    );
    for (word, number) in [
        ("3", "3"),
        ("Three", "3"),
        ("third", "3"),
        ("3rd", "3"),
        ("0003.50%", "3.50%"),
        ("003rd", "003"),
    ] {
        assert_eq!(
            dispatch("grounding.numberValue", json!({ "word": word })).unwrap(),
            json!(number)
        );
    }
    assert_eq!(
        dispatch("grounding.numberValue", json!({ "word": "wave" })).unwrap(),
        Value::Null
    );
    assert_eq!(
        dispatch("grounding.numberValue", json!({ "word": "٣" })).unwrap(),
        Value::Null
    );
    for (a, b) in [
        ("raises", "raise"),
        ("completed", "complete"),
        ("escalations", "escalate"),
        ("begins", "starts"),
        ("fixed", "resolved"),
    ] {
        assert_eq!(
            dispatch("grounding.sameWord", json!({ "a": a, "b": b })).unwrap(),
            json!(true)
        );
    }
    for (a, b) in [("call", "page"), ("rollback", "failover"), ("less", "more")] {
        assert_eq!(
            dispatch("grounding.sameWord", json!({ "a": a, "b": b })).unwrap(),
            json!(false)
        );
    }
    assert_eq!(
        dispatch(
            "grounding.splitClauses",
            json!({ "sentence": "Waves 1 and 2 are done, and wave 3 is waiting on DB-15" })
        )
        .unwrap(),
        json!(["Waves 1", "2 are done", "wave 3 is waiting on DB-15"])
    );
    assert_eq!(
        dispatch(
            "grounding.fold",
            json!({ "text": "\u{FEFF}STEP\u{202F}ONE\u{2011}\u{201C}quoted\u{201D} " })
        )
        .unwrap(),
        json!("step one-\"quoted\"")
    );
}

#[test]
fn faithful_rewording_retains_ordered_support_and_full_report() {
    let source =
        "DB-12 (in progress): Waves one and two are complete, and wave three waits on DB-15.";
    let result = check(
        "Waves 1 and 2 are done, and wave 3 is waiting on DB-15. [jira:DB-12:0]",
        source,
    );
    assert_eq!(
        result["answer"]["text"],
        "Waves 1 and 2 are done, and wave 3 is waiting on DB-15. [jira:DB-12:0]"
    );
    assert_eq!(result["report"]["lines"][0]["kind"], "reworded");
    assert_eq!(
        result["answer"]["check"]["lines"][0]["support"],
        json!([source])
    );
    assert_eq!(result["report"]["removed"], json!([]));
}

#[test]
fn copied_fragments_cannot_drop_negation_or_hedging() {
    let source = "Do not restart the payment service during the cutover. The vendor may slip the release to Friday.";
    for (claim, detail) in [
        (
            "Restart the payment service during the cutover.",
            "drops the passage's \"not\" before \"restart\"",
        ),
        ("slip the release to Friday.", "drops the passage's \"may\""),
    ] {
        let result = check(&format!("{claim} [jira:DB-12:0]"), source);
        assert_eq!(result["report"]["removed"][0]["reason"], "changed_meaning");
        assert_eq!(result["report"]["removed"][0]["detail"], detail);
        assert_eq!(
            result["answer"],
            json!({ "text": NO_RESULT, "citations": [] })
        );
    }
    assert_eq!(
        check(
            "The vendor might slip the release to Friday. [jira:DB-12:0]",
            source
        )["report"]["lines"][0]["kind"],
        "reworded"
    );
}

#[test]
fn numbers_must_stay_bound_to_neighbors_and_failure_priority_is_stable() {
    let source = "Waves one and two are complete, and wave three waits on DB-15.";
    let result = check("Waves one and three are complete. [jira:DB-12:0]", source);
    assert_eq!(result["report"]["removed"][0]["reason"], "new_fact");
    assert_eq!(
        result["report"]["removed"][0]["detail"],
        "\"three\" isn't tied to the same words in the passage"
    );
    let result = check(
        "Ravi raises four quotas after the final wave. [jira:DB-12:0]",
        "Maya raises five quotas before the final wave.",
    );
    assert_eq!(result["report"]["removed"][0]["reason"], "new_fact");
    assert_eq!(
        result["report"]["removed"][0]["detail"],
        "the passage doesn't have \"four\""
    );
}

#[test]
fn issue_status_is_bound_to_its_own_label() {
    let source = "DB-12 (in progress): The final wave is blocked by DB-15.";
    let result = check("DB-12 is blocked. [jira:DB-12:0]", source);
    assert_eq!(result["report"]["removed"][0]["reason"], "changed_meaning");
    assert_eq!(
        result["report"]["removed"][0]["detail"],
        "says db-12 is blocked, but the passage says in progress"
    );
    assert_eq!(
        check("DB-12 is ongoing. [jira:DB-12:0]", source)["report"]["lines"][0]["kind"],
        "reworded"
    );
}

#[test]
fn citation_scope_and_answer_audit_omit_rejected_text() {
    let result = dispatch("grounding.checkAnswer", json!({
            "output": "Maya raises the quota. [jira:DB-12:0]\nMaya raises the quota. [slack:migration:0] [jira:DB-12:0]\nRestart all regions.\nMaya raises the quota. [slack:hidden:0]",
            "allowed": [
                ["jira:DB-12:0", { "chunkId": "jira:DB-12:0", "title": "DB-12" }],
                ["slack:migration:0", { "chunkId": "slack:migration:0", "title": "Migration" }]
            ],
            "evidence": [
                ["jira:DB-12:0", "DB-12 is in progress."],
                ["slack:migration:0", "Maya raises the quota."],
                ["slack:hidden:0", "Maya raises the quota."]
            ]
        })).unwrap();
    assert_eq!(
        result["answer"]["text"],
        "Maya raises the quota. [slack:migration:0]"
    );
    assert_eq!(
        result["answer"]["citations"],
        json!([{ "chunkId": "slack:migration:0", "title": "Migration" }])
    );
    assert_eq!(
        result["answer"]["check"]["removed"],
        json!([{ "reason": "wrong_source" }, { "reason": "no_citation" }, { "reason": "unknown_citation" }])
    );
    assert_eq!(
        result["report"]["removed"][0]["detail"],
        "backed by slack:migration:0, not the passage it cites"
    );
    assert!(!result["answer"].to_string().contains("Restart all regions"));
}

#[test]
fn malformed_input_is_a_boundary_error() {
    assert!(dispatch(
        "grounding.checkAnswer",
        json!({ "output": "claim", "allowed": [[1, {}]], "evidence": [] })
    )
    .is_err());
    assert!(dispatch("grounding.fold", json!({ "text": 1 })).is_err());
    assert!(dispatch("grounding.unknown", Value::Null).is_err());
}

#[test]
fn action_roles_and_timing_cannot_be_reversed() {
    for (source, claim) in [
        (
            "Maya assigns David to rotate production keys.",
            "David assigns Maya to rotate production keys.",
        ),
        (
            "Maya will rotate production keys.",
            "Maya rotated production keys.",
        ),
        (
            "She assigns him to rotate production keys.",
            "He assigns her to rotate production keys.",
        ),
        (
            "Maya does not assign David to rotate production keys.",
            "Maya assigns David not to rotate production keys.",
        ),
        (
            "Maya won't rotate production keys.",
            "Maya doesn't rotate production keys.",
        ),
        (
            "Agreed: Maya will rotate production keys.",
            "Maya rotates production keys now.",
        ),
        (
            "maya assigns david to rotate production keys.",
            "david assigns maya to rotate production keys.",
        ),
    ] {
        let result = check(&format!("{claim} [jira:DB-12:0]"), source);
        assert_eq!(
            result["answer"],
            json!({ "text": NO_RESULT, "citations": [] }),
            "{claim}"
        );
        assert_eq!(result["report"]["removed"].as_array().unwrap().len(), 1);
    }
}

#[test]
fn faithful_passive_roles_and_timing_are_retained() {
    for (source, claim) in [
        (
            "Maya assigns David to rotate production keys.",
            "David is assigned by Maya to rotate production keys.",
        ),
        (
            "Maya will rotate production keys.",
            "Production keys will be rotated by Maya.",
        ),
        (
            "Maya rotated production keys.",
            "Production keys were rotated by Maya.",
        ),
        (
            "She assigns him to rotate production keys.",
            "He is assigned by her to rotate production keys.",
        ),
        (
            "Maya won't rotate production keys.",
            "Production keys will not be rotated by Maya.",
        ),
    ] {
        let result = check(&format!("{claim} [jira:DB-12:0]"), source);
        assert_eq!(result["report"]["lines"][0]["kind"], "reworded", "{claim}");
        assert_eq!(result["report"]["removed"], json!([]));
        assert_eq!(
            check(&format!("{source} [jira:DB-12:0]"), source)["report"]["lines"][0]["kind"],
            "quoted"
        );
    }
}
