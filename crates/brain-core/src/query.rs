use indexmap::IndexMap;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::LazyLock;

const DAY: i64 = 86_400_000;
const LIMIT: f64 = 8_640_000_000_000_000.0;
const SPACE: &str = r"[\t\n\x0b\x0c\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";

fn re(pattern: &str) -> Regex {
    Regex::new(&pattern.replace(r"\b", r"(?-u:\b)")).unwrap()
}

fn normalize(text: &str) -> String {
    static WHITESPACE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(&format!("{SPACE}+")).unwrap());
    WHITESPACE
        .replace_all(text, " ")
        .trim_matches(' ')
        .to_string()
}

#[derive(Deserialize)]
struct WindowInput {
    text: String,
    now: Option<i64>,
}

fn relative_window(text: &str, now: Option<i64>) -> Option<(i64, i64)> {
    static YESTERDAY: LazyLock<Regex> = LazyLock::new(|| re(r"\byesterday\b"));
    static TODAY: LazyLock<Regex> = LazyLock::new(|| re(r"\btoday\b"));
    static WEEK: LazyLock<Regex> = LazyLock::new(|| re(r"\b(?:last|past) week\b"));
    static DAYS: LazyLock<Regex> = LazyLock::new(|| re(r"\b(?:last|past) (\d+) days?\b"));
    let now = now?;
    let midnight = now.div_euclid(DAY) * DAY;
    let q = text.to_lowercase();
    let range = if YESTERDAY.is_match(&q) {
        (midnight as f64 - DAY as f64, midnight as f64 - 1.0)
    } else if TODAY.is_match(&q) {
        (midnight as f64, midnight as f64 + DAY as f64 - 1.0)
    } else if WEEK.is_match(&q) {
        (midnight as f64 - 7.0 * DAY as f64, now as f64)
    } else {
        let days = DAYS.captures(&q)?;
        (
            midnight as f64 - days[1].parse::<f64>().ok()? * DAY as f64,
            now as f64,
        )
    };
    (range.0.abs() <= LIMIT).then_some((range.0 as i64, range.1 as i64))
}

#[derive(Deserialize)]
struct PlanInput {
    question: String,
    now: Option<i64>,
}

fn platform_boundary(character: Option<char>) -> bool {
    !character.is_some_and(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn plan(input: PlanInput) -> Value {
    static PLATFORM: LazyLock<Regex> =
        LazyLock::new(|| Regex::new("(?i-u)slack|jira|confluence|drive").unwrap());
    let mut sources = Vec::<String>::new();
    let mut search = String::new();
    let mut copied = 0;
    for hit in PLATFORM.find_iter(&input.question) {
        if !platform_boundary(input.question[..hit.start()].chars().next_back())
            || !platform_boundary(input.question[hit.end()..].chars().next())
        {
            continue;
        }
        let source = hit.as_str().to_ascii_lowercase();
        if !sources.contains(&source) {
            sources.push(source);
        }
        search.push_str(&input.question[copied..hit.start()]);
        search.push(' ');
        copied = hit.end();
    }
    search.push_str(&input.question[copied..]);
    let mut output = json!({"searchText": normalize(&search), "sources": sources});
    if let Some((from, to)) = relative_window(&input.question, input.now) {
        output["window"] = json!({"from": from, "to": to});
    }
    output
}

#[derive(Deserialize)]
struct Candidate {
    source: Option<String>,
    score: f64,
    linked: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BalanceInput {
    candidates: Vec<Candidate>,
    named: Vec<String>,
    per_named: f64,
}

fn balance(input: BalanceInput) -> Vec<usize> {
    let mut queues = IndexMap::<Option<String>, VecDeque<usize>>::new();
    let mut best = IndexMap::<Option<String>, f64>::new();
    for (index, candidate) in input.candidates.iter().enumerate() {
        queues
            .entry(candidate.source.clone())
            .or_default()
            .push_back(index);
        if !candidate.linked {
            let score = best.entry(candidate.source.clone()).or_insert(0.0);
            *score = score.max(candidate.score);
        }
    }
    let top = best.values().copied().fold(0.0_f64, f64::max);
    let mut ordered = Vec::with_capacity(input.candidates.len());
    for source in &input.named {
        if let Some(queue) = queues.get_mut(&Some(source.clone())) {
            let mut taken = 0_usize;
            let mut index = 0;
            while (taken as f64) < input.per_named && index < queue.len() {
                if input.candidates[queue[index]].linked {
                    index += 1;
                } else {
                    ordered.push(queue.remove(index).unwrap());
                    taken += 1;
                }
            }
        }
    }
    let relevant = |source: &Option<String>| best.get(source).copied().unwrap_or(0.0) >= top / 2.0;
    let mut turns: Vec<_> = queues
        .keys()
        .filter(|source| relevant(source))
        .cloned()
        .collect();
    turns.sort_by_key(|source| {
        source
            .as_ref()
            .is_some_and(|source| input.named.contains(source))
    });
    loop {
        let before = ordered.len();
        for source in &turns {
            if let Some(index) = queues.get_mut(source).unwrap().pop_front() {
                ordered.push(index);
            }
        }
        if ordered.len() == before {
            break;
        }
    }
    let mut rest: Vec<_> = queues
        .into_iter()
        .filter(|(source, _)| !relevant(source))
        .flat_map(|(_, queue)| queue)
        .collect();
    rest.sort_by(|&a, &b| {
        input.candidates[b]
            .score
            .total_cmp(&input.candidates[a].score)
    });
    ordered.extend(rest);
    ordered
}

pub fn dispatch(operation: &str, input: Value) -> Result<Value, String> {
    match operation {
        "query.relativeWindow" => {
            let input: WindowInput =
                serde_json::from_value(input).map_err(|error| error.to_string())?;
            Ok(relative_window(&input.text, input.now)
                .map(|(from, to)| json!({"from": from, "to": to}))
                .unwrap_or(Value::Null))
        }
        "query.plan" => Ok(plan(
            serde_json::from_value(input).map_err(|error| error.to_string())?,
        )),
        "query.balance" => Ok(json!(balance(
            serde_json::from_value(input).map_err(|error| error.to_string())?
        ))),
        _ => Err(format!("Unknown query operation: {operation}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_boundaries_and_order() {
        let result = dispatch("query.plan", json!({"question":"slackline drive-through SLACK _Jira, slack éDrive","now":1792051200000_i64})).unwrap();
        assert_eq!(result["sources"], json!(["slack", "jira", "drive"]));
        assert_eq!(result["searchText"], "slackline drive-through _ , é");
    }

    #[test]
    fn utc_windows_reject_ranges_outside_date_limits() {
        let now = 1_792_051_200_000_i64;
        assert_eq!(
            dispatch(
                "query.relativeWindow",
                json!({"text":"yesterday", "now":now})
            )
            .unwrap(),
            json!({"from":1791936000000_i64,"to":1792022399999_i64})
        );
        assert_eq!(
            dispatch(
                "query.relativeWindow",
                json!({"text":"last 99999999999 days", "now":now})
            )
            .unwrap(),
            Value::Null
        );
    }

    #[test]
    fn named_slots_exclude_linked_candidates() {
        let output = dispatch(
            "query.balance",
            json!({"candidates":[
            {"source":"slack","score":0.9,"linked":false},
            {"source":"slack","score":0.8,"linked":true},
            {"source":"jira","score":0.7,"linked":false},
            {"source":"slack","score":0.2,"linked":false}
        ],"named":["slack"],"perNamed":2}),
        )
        .unwrap();
        assert_eq!(output, json!([0, 3, 2, 1]));
    }
}
