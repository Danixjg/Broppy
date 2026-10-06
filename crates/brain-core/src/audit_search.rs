use indexmap::IndexSet;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::LazyLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    actor: String,
    #[serde(rename = "type")]
    kind: String,
    data: Value,
    timestamp: Option<f64>,
    #[serde(default)]
    payload: String,
    trace: Option<usize>,
}

#[derive(Deserialize)]
struct User {
    id: String,
    email: String,
    name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    doc_id: String,
    title: String,
}

#[derive(Default, Deserialize, Serialize)]
struct Filters {
    #[serde(skip_serializing_if = "Option::is_none")]
    user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    space: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    doc: Option<String>,
}

#[derive(Default, Deserialize)]
struct Params {
    q: Option<String>,
    user: Option<String>,
    source: Option<String>,
    space: Option<String>,
    doc: Option<String>,
    from: Option<String>,
    to: Option<String>,
}

#[derive(Deserialize)]
struct PlanInput {
    #[serde(default)]
    entries: Vec<Entry>,
    params: Params,
    users: Vec<User>,
    #[serde(default)]
    documents: Vec<Document>,
    now: Option<i64>,
}

#[derive(Deserialize)]
struct SearchInput {
    entries: Vec<Entry>,
    q: String,
    filters: Filters,
    from: Option<f64>,
    to: Option<f64>,
}

fn words(text: &str) -> String {
    static NON_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9]+").unwrap());
    NON_WORD
        .replace_all(&text.to_lowercase(), " ")
        .trim()
        .into()
}

fn named_document(q: &str, tokens: &IndexSet<String>, documents: &[Document]) -> Option<String> {
    if let Some(doc) = documents.iter().find(|doc| {
        q.contains(&doc.doc_id.to_lowercase())
            || tokens.contains(
                &doc.doc_id
                    .split_once(':')
                    .map(|(_, id)| id)
                    .unwrap_or(&doc.doc_id)
                    .to_lowercase(),
            )
    }) {
        return Some(doc.doc_id.clone());
    }
    let padded = format!(" {} ", words(q));
    let mut best: Option<(&Document, usize)> = None;
    for doc in documents {
        let title = words(&doc.title);
        if title.len() > 3
            && padded.contains(&format!(" {title} "))
            && best.is_none_or(|(_, len)| title.len() > len)
        {
            best = Some((doc, title.len()));
        }
    }
    best.map(|(doc, _)| doc.doc_id.clone())
}

fn token_set(q: &str) -> IndexSet<String> {
    static TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[a-z0-9_-]+").unwrap());
    TOKEN
        .find_iter(q)
        .map(|hit| hit.as_str().to_owned())
        .collect()
}

fn plan(input: PlanInput) -> Result<Value, String> {
    static DATE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"[0-9]{4}-[0-9]{2}-[0-9]{2}").unwrap());
    static USER: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?-u:\b)users?[\t\n\x0b\x0c\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]+['"‘“]?([a-z0-9@._-]+)"#).unwrap()
    });
    static USER_TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9@._-]+").unwrap());
    let question = input.params.q.as_deref().unwrap_or("");
    if question.encode_utf16().count() > 500 {
        return Err("Invalid query".into());
    }
    let q = question.to_lowercase();
    let tokens = token_set(&q);
    let dates: Vec<_> = DATE
        .find_iter(&q)
        .map(|hit| hit.as_str().to_owned())
        .collect();
    let from_value = input.params.from.clone().or_else(|| {
        (!q.contains("before "))
            .then(|| dates.first().cloned())
            .flatten()
    });
    let to_value = input
        .params
        .to
        .clone()
        .or_else(|| dates.get(1).cloned())
        .or_else(|| {
            (!q.contains("since ") && !q.contains("after "))
                .then(|| dates.first().cloned())
                .flatten()
        });
    let window = if dates.is_empty() && input.params.from.is_none() && input.params.to.is_none() {
        crate::query::dispatch("query.relativeWindow", json!({"text": q, "now": input.now}))?
    } else {
        Value::Null
    };
    let user_words: Vec<_> = USER_TOKEN.split(&q).collect();
    let user = input
        .params
        .user
        .or_else(|| {
            input
                .users
                .iter()
                .find(|user| {
                    [&user.id, &user.email, &user.name]
                        .iter()
                        .any(|value| user_words.contains(&value.to_lowercase().as_str()))
                })
                .map(|user| user.id.clone())
        })
        .or_else(|| USER.captures(&q).map(|capture| capture[1].into()));
    let source = input.params.source.or_else(|| {
        ["slack", "jira", "confluence", "drive"]
            .into_iter()
            .find(|source| tokens.contains(*source))
            .map(str::to_owned)
    });
    let spaces = input
        .entries
        .iter()
        .flat_map(|entry| [entry.data.get("space"), entry.data.get("project")])
        .flatten()
        .filter_map(Value::as_str)
        .collect::<IndexSet<_>>();
    let mut best_space: Option<&str> = None;
    for space in spaces {
        if tokens.contains(&space.to_lowercase())
            && best_space
                .is_none_or(|best| space.encode_utf16().count() > best.encode_utf16().count())
        {
            best_space = Some(space);
        }
    }
    let space = input.params.space.or_else(|| best_space.map(str::to_owned));
    let doc = input
        .params
        .doc
        .or_else(|| named_document(&q, &tokens, &input.documents));
    Ok(
        json!({"q": q, "filters": Filters { user, source, space, doc }, "fromValue": from_value, "toValue": to_value, "window": window}),
    )
}

fn mentions_document(entry: &Entry, doc: &str) -> bool {
    entry.data.get("docId").and_then(Value::as_str) == Some(doc)
        || entry
            .data
            .get("chunkIds")
            .and_then(Value::as_array)
            .is_some_and(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .any(|id| id.starts_with(&format!("{doc}:")))
            })
        || entry
            .data
            .get("documents")
            .and_then(Value::as_array)
            .is_some_and(|docs| {
                docs.iter()
                    .any(|item| item.get("docId").and_then(Value::as_str) == Some(doc))
            })
}

fn search(input: SearchInput) -> Result<Vec<usize>, String> {
    static DENIED: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?-u:\b)(denied|deny|rejected)(?-u:\b)").unwrap());
    static ALLOWED: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?-u:\b)(allowed|allow|approved)(?-u:\b)").unwrap());
    if input.from.zip(input.to).is_some_and(|(from, to)| from > to) {
        return Err("Invalid date range".into());
    }
    let matches_filter = |filter: Option<&str>, value: Option<&Value>| {
        filter
            .is_none_or(|filter| filter.is_empty() || value.and_then(Value::as_str) == Some(filter))
    };
    let matching = input
        .entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| {
            input
                .filters
                .user
                .as_deref()
                .is_none_or(|user| user.is_empty() || entry.actor == user)
                && input
                    .from
                    .is_none_or(|from| entry.timestamp.is_some_and(|time| time >= from))
                && input
                    .to
                    .is_none_or(|to| entry.timestamp.is_some_and(|time| time <= to))
        })
        .collect::<Vec<_>>();
    let relevant = matching
        .iter()
        .filter(|(_, entry)| {
            matches_filter(input.filters.source.as_deref(), entry.data.get("source"))
                && (matches_filter(input.filters.space.as_deref(), entry.data.get("space"))
                    || matches_filter(input.filters.space.as_deref(), entry.data.get("project")))
                && input
                    .filters
                    .doc
                    .as_deref()
                    .is_none_or(|doc| doc.is_empty() || mentions_document(entry, doc))
        })
        .map(|(index, _)| *index)
        .collect::<IndexSet<_>>();
    let traces = relevant
        .iter()
        .filter_map(|index| input.entries[*index].trace)
        .collect::<IndexSet<_>>();
    let allowed = if DENIED.is_match(&input.q) {
        Some(false)
    } else if ALLOWED.is_match(&input.q) {
        Some(true)
    } else {
        None
    };
    let has_filters = input.from.is_some()
        || input.to.is_some()
        || input.filters.user.is_some()
        || input.filters.source.is_some()
        || input.filters.space.is_some()
        || input.filters.doc.is_some();
    let ignored = [
        "show", "me", "all", "the", "events", "event", "for", "where", "were", "with", "by",
        "about",
    ];
    let terms = token_set(&input.q)
        .into_iter()
        .filter(|term| !ignored.contains(&term.as_str()))
        .collect::<Vec<_>>();
    Ok(matching
        .into_iter()
        .filter(|(index, entry)| {
            (relevant.contains(index) || entry.trace.is_some_and(|trace| traces.contains(&trace)))
                && allowed.is_none_or(|allowed| {
                    entry.data.get("allowed").and_then(Value::as_bool) == Some(allowed)
                })
                && (has_filters
                    || input.q.is_empty()
                    || terms.iter().all(|term| match term.as_str() {
                        "denied" | "deny" | "rejected" => {
                            entry.data.get("allowed").and_then(Value::as_bool) == Some(false)
                        }
                        "allowed" | "allow" | "approved" => {
                            entry.data.get("allowed").and_then(Value::as_bool) == Some(true)
                        }
                        _ => format!("{} {} {}", entry.kind, entry.actor, entry.payload)
                            .to_lowercase()
                            .contains(term),
                    }))
        })
        .map(|(index, _)| index)
        .collect())
}

pub fn dispatch(operation: &str, input: Value) -> Result<Value, String> {
    match operation {
        "auditSearch.plan" => plan(
            serde_json::from_value(input)
                .map_err(|error| format!("Invalid audit search input: {error}"))?,
        ),
        "auditSearch.search" => Ok(json!(search(
            serde_json::from_value(input)
                .map_err(|error| format!("Invalid audit search input: {error}"))?
        )?)),
        _ => Err(format!("Unknown audit search operation: {operation}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(actor: &str, timestamp: i64, data: Value, trace: Option<usize>) -> Value {
        json!({"actor":actor,"type":"access_decision","timestamp":timestamp,"data":data,"trace":trace})
    }

    #[test]
    fn trace_expansion_keeps_user_date_and_denial_constraints() {
        let entries = vec![
            entry(
                "ravi",
                100,
                json!({"source":"jira","allowed":false}),
                Some(0),
            ),
            entry("ravi", 100, json!({"allowed":false}), Some(0)),
            entry("other", 100, json!({"allowed":false}), Some(0)),
            entry("ravi", 1, json!({"allowed":false}), Some(0)),
            entry("ravi", 100, json!({"allowed":true}), Some(0)),
            entry("ravi", 100, json!({"allowed":false}), Some(1)),
        ];
        let result = dispatch("auditSearch.search",json!({"entries":entries,"q":"denied","filters":{"user":"ravi","source":"jira"},"from":50})).unwrap();
        assert_eq!(result, json!([0, 1]));
    }

    #[test]
    fn unknown_users_remain_filters_and_space_names_match_whole_tokens() {
        let result = dispatch("auditSearch.plan",json!({"entries":[entry("ravi",0,json!({"space":"PAY"}),None),entry("ravi",0,json!({"project":"payment-gateway"}),None)],"params":{"q":"user 'missing' payment-gateway"},"users":[],"now":0})).unwrap();
        assert_eq!(
            result["filters"],
            json!({"user":"missing","space":"payment-gateway"})
        );
    }

    #[test]
    fn query_validation_counts_utf16_and_full_document_titles_choose_longest() {
        assert_eq!(
            dispatch(
                "auditSearch.plan",
                json!({"entries":[],"params":{"q":"😀".repeat(251)},"users":[],"now":0})
            ),
            Err("Invalid query".into())
        );
        let result = dispatch("auditSearch.plan",json!({"entries":[],"params":{"q":"show migration plan extended"},"users":[],"documents":[{"docId":"drive:short","title":"Migration plan"},{"docId":"drive:long","title":"Migration plan extended"}],"now":0})).unwrap();
        assert_eq!(result["filters"]["doc"], json!("drive:long"));
    }

    #[test]
    fn free_text_uses_the_node_json_bytes() {
        let mut value = entry("ravi", 100, json!({"number":1e21}), None);
        value["payload"] = json!("{\"number\":1e+21}");
        let result = dispatch(
            "auditSearch.search",
            json!({"entries":[value],"q":"1e 21","filters":{}}),
        )
        .unwrap();
        assert_eq!(result, json!([0]));
    }
}
