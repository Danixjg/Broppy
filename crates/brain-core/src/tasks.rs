use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::LazyLock;

const DAY: i64 = 86_400_000;
const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];
const WEEKDAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const SPACE: &str = r"[\t\n\x0b\x0c\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
const VERBS: &str = "raise|fix|update|create|migrate|add|remove|review|send|write|deploy|increase|rotate|schedule|draft|prepare|file|close|open|check|run|test|ship|set up|confirm|approve|document|restart|revert|roll back|investigate|resolve|backfill|patch|upgrade|provision|cut over|sign off";

fn re(pattern: &str) -> Regex {
    Regex::new(
        &pattern
            .replace("(?i)", "(?i-u)")
            .replace(r"\b", r"(?-u:\b)")
            .replace(r"\s", &format!("(?u:{SPACE})"))
            .replace("[-–—]", "(?u:[-–—])")
            .replace(r"\d", "[0-9]"),
    )
    .unwrap()
}

struct Rules {
    cue: Regex,
    commit: Regex,
    hedge: Regex,
    verb: Regex,
    whitespace: Regex,
    mention: Regex,
    title_words: Regex,
    tags: Regex,
    ending: Regex,
    article: Regex,
    leading_article: Regex,
}

static RULES: LazyLock<Rules> = LazyLock::new(|| Rules {
    cue: re(
        r"(?i)^\s*(?:agreed|decision|decided|action(?:\s+items?)?|todo|to-do|next\s+steps?|owner)\s*:\s*",
    ),
    commit: re(
        r"(?i)\b(?:will|i'll|we'll|going\s+to|needs?\s+to|has\s+to|must|should|to\s+be\s+done)\b",
    ),
    hedge: re(
        r"(?i)\b(?:maybe|perhaps|might|could\s+we|should\s+we|wondering|not\s+sure|if\s+we)\b",
    ),
    verb: re(&format!(r"(?i)\b({VERBS})(?:s|es)?\b")),
    whitespace: re(r"\s+"),
    mention: re(r"<@([UW][A-Z0-9]+)(?:\|[^>]*)?>"),
    title_words: re(r"(?i)\b(?:will|i'll|we'll|needs?\s+to|has\s+to|must|should|to)\b"),
    tags: re(r"<[^>]+>"),
    ending: re(r"(?i)\b(?:before|by|until|due|on)\b|[.;,]|\s[-–—]\s"),
    article: re(r"(?i)\b(?:the|a|an)\b"),
    leading_article: re(r"(?i)^\s*(?:the|a|an)\s+"),
});

fn normalized(text: &str) -> String {
    RULES
        .whitespace
        .replace_all(text, " ")
        .trim_matches(' ')
        .to_string()
}

fn reference(milliseconds: Option<i64>) -> Result<DateTime<Utc>, String> {
    milliseconds
        .and_then(DateTime::from_timestamp_millis)
        .ok_or_else(|| "Invalid time value".to_string())
}

fn date(year: i32, month: u32, day: u32) -> Option<NaiveDate> {
    let year = if (0..100).contains(&year) {
        year + 1900
    } else {
        year
    };
    NaiveDate::from_ymd_opt(year, month, 1)?.checked_add_signed(Duration::days(day as i64 - 1))
}

fn parse_due(text: &str, milliseconds: Option<i64>) -> Result<Option<String>, String> {
    static ISO: LazyLock<Regex> = LazyLock::new(|| re(r"\b(\d{4})-(\d{2})-(\d{2})\b"));
    static DAY_MONTH: LazyLock<Regex> = LazyLock::new(|| {
        re(&format!(
            r"(?i)\b(\d{{1,2}})(?:st|nd|rd|th)?\s+({})[a-z]*\b",
            MONTHS.join("|")
        ))
    });
    static MONTH_DAY: LazyLock<Regex> = LazyLock::new(|| {
        re(&format!(
            r"(?i)\b({})[a-z]*\s+(\d{{1,2}})(?:st|nd|rd|th)?\b",
            MONTHS.join("|")
        ))
    });
    static TOMORROW: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\btomorrow\b"));
    static TODAY: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\b(?:today|eod)\b"));
    static WEEKDAY: LazyLock<Regex> = LazyLock::new(|| {
        re(&format!(
            r"(?i)\b(?:by|due|on|before|until)?\s*({})[a-z]*\b",
            WEEKDAYS.join("|")
        ))
    });
    static DATE_CUE: LazyLock<Regex> =
        LazyLock::new(|| re(r"(?i)\b(?:by|due|on|before|until|next|this)\b"));
    if let Some(hit) = ISO.find(text) {
        return Ok(Some(hit.as_str().to_string()));
    }
    let named = DAY_MONTH
        .captures(text)
        .map(|hit| (hit[1].parse::<u32>().unwrap(), hit[2].to_ascii_lowercase()))
        .or_else(|| {
            MONTH_DAY
                .captures(text)
                .map(|hit| (hit[2].parse::<u32>().unwrap(), hit[1].to_ascii_lowercase()))
        });
    if let Some((day, month)) = named {
        if (1..=31).contains(&day) {
            let reference = reference(milliseconds)?;
            let month = MONTHS.iter().position(|name| *name == month).unwrap() as u32 + 1;
            let Some(mut result) = date(reference.year(), month, day) else {
                return Ok(None);
            };
            if result.month() != month {
                return Ok(None);
            }
            let timestamp = result
                .and_hms_opt(0, 0, 0)
                .unwrap()
                .and_utc()
                .timestamp_millis();
            if timestamp < reference.timestamp_millis() - 30 * DAY {
                result = date(reference.year() + 1, month, day).ok_or("Invalid time value")?;
            }
            return Ok(Some(result.format("%Y-%m-%d").to_string()));
        }
    }
    if TOMORROW.is_match(text) {
        let reference = reference(milliseconds)?;
        return Ok(Some(
            reference
                .checked_add_signed(Duration::days(1))
                .ok_or("Invalid time value")?
                .format("%Y-%m-%d")
                .to_string(),
        ));
    }
    if TODAY.is_match(text) {
        return Ok(Some(
            reference(milliseconds)?.format("%Y-%m-%d").to_string(),
        ));
    }
    if let Some(hit) = WEEKDAY.captures(text) {
        if DATE_CUE.is_match(text) {
            let reference = reference(milliseconds)?;
            let target = WEEKDAYS
                .iter()
                .position(|name| *name == hit[1].to_ascii_lowercase())
                .unwrap() as i64;
            let ahead = (target - reference.weekday().num_days_from_sunday() as i64 + 7) % 7;
            let ahead = if ahead == 0 { 7 } else { ahead };
            return Ok(Some(
                reference
                    .checked_add_signed(Duration::days(ahead))
                    .ok_or("Invalid time value")?
                    .format("%Y-%m-%d")
                    .to_string(),
            ));
        }
    }
    Ok(None)
}

fn format_due(due: &str) -> String {
    static ISO: LazyLock<Regex> = LazyLock::new(|| re(r"^(\d{4})-(\d{2})-(\d{2})$"));
    let parsed = ISO.captures(due).and_then(|hit| {
        let year = hit[1].parse::<i32>().ok()?;
        let month = hit[2].parse::<u32>().ok()?;
        let day = hit[3].parse::<u32>().ok()?;
        if !(1..=31).contains(&day) {
            return None;
        }
        NaiveDate::from_ymd_opt(year, month, 1)?.checked_add_signed(Duration::days(day as i64 - 1))
    });
    parsed
        .map(|date| date.format("%a %-d %b").to_string())
        .unwrap_or_else(|| "undefined NaN undefined".to_string())
}

fn find_assignee(text: &str, people: &[Value]) -> Option<(Value, String, Option<usize>)> {
    if let Some(hit) = RULES.mention.captures(text) {
        let index = people.iter().position(|person| person["slackId"] == hit[1]);
        let person = index
            .map(|index| people[index].clone())
            .unwrap_or_else(|| json!({"slackId": &hit[1], "name": &hit[1]}));
        return Some((person, hit[0].to_string(), index));
    }
    let mut best: Option<(Value, String, Option<usize>, usize)> = None;
    for (index, person) in people.iter().enumerate() {
        let Some(name) = person["name"].as_str() else {
            continue;
        };
        let pattern = format!(r"(?i)\b{}\b", regex::escape(name));
        let regex = if name.is_ascii() {
            re(&pattern)
        } else {
            Regex::new(&pattern.replace(r"\b", r"(?-u:\b)")).unwrap()
        };
        if let Some(hit) = regex.find(text) {
            if best.as_ref().is_none_or(|best| hit.start() < best.3) {
                best = Some((
                    person.clone(),
                    hit.as_str().to_string(),
                    Some(index),
                    hit.start(),
                ));
            }
        }
    }
    best.map(|(person, matched, index, _)| (person, matched, index))
}

fn title(sentence: &str, matched: Option<&str>) -> String {
    let mut text = RULES.cue.replace(sentence, "").to_string();
    if let Some(matched) = matched {
        text = text.replacen(matched, " ", 1);
    }
    text = RULES.tags.replace_all(&text, " ").to_string();
    text = RULES.title_words.replace_all(&text, " ").to_string();
    if let Some(hit) = RULES.verb.captures(&text) {
        text = format!("{} {}", &hit[1], &text[hit.get(0).unwrap().end()..]);
    }
    if let Some(hit) = RULES.ending.find(&text) {
        text.truncate(hit.start());
    }
    text = RULES.leading_article.replace(&text, "").to_string();
    text = RULES.article.replace_all(&text, " ").to_string();
    text = normalized(&text);
    match text.chars().next() {
        Some(first) if first.len_utf16() == 2 => text,
        Some(first) => format!("{}{}", first.to_uppercase(), &text[first.len_utf8()..]),
        None => "Follow up".to_string(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScoreInput {
    text: String,
    people: Vec<Value>,
    posted_at: Option<i64>,
    threshold: Option<f64>,
    author_slack_id: Option<String>,
}

fn score(input: ScoreInput) -> Result<Value, String> {
    let sentence = normalized(&input.text);
    static FIRST_PERSON: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^(?:agreed:\s*)?i(?:\s+will|'ll|\s+am\s+going\s+to)\b").unwrap()
    });
    let first_person = FIRST_PERSON.is_match(&sentence);
    let assignee = if first_person {
        input.author_slack_id.as_ref().map(|author| {
            let index = input
                .people
                .iter()
                .position(|person| person["slackId"].as_str() == Some(author));
            let person = index
                .map(|index| input.people[index].clone())
                .unwrap_or_else(|| json!({"slackId": author, "name": author}));
            (person, String::new(), index)
        })
    } else {
        find_assignee(&sentence, &input.people)
    };
    let due = parse_due(&sentence, input.posted_at)?;
    let mut signals = Vec::new();
    let mut add = |name: &str, weight: f64| signals.push(json!({"name": name, "weight": weight}));
    if RULES.cue.is_match(&sentence) {
        add("agreement cue", 0.45);
    }
    if first_person && input.author_slack_id.is_some() {
        add("author commitment", 0.3);
    }
    if assignee.is_some() {
        add("names an owner", 0.2);
    }
    if RULES.verb.is_match(&sentence) {
        add("action verb", 0.15);
    }
    if due.is_some() {
        add("has a date", 0.15);
    }
    if RULES.commit.is_match(&sentence) && assignee.is_some() {
        add("commitment wording", 0.1);
    }
    if sentence.contains('?') {
        add("is a question", -0.4);
    }
    if RULES.hedge.is_match(&sentence) {
        add("hedged wording", -0.3);
    }
    let total: f64 = signals
        .iter()
        .map(|signal| signal["weight"].as_f64().unwrap())
        .sum();
    let clamped = if total <= 0.0 { 0.0 } else { total.min(1.0) };
    let score = (clamped * 100.0).round() / 100.0;
    let mut result = json!({
        "score": score, "signals": signals, "sentence": sentence,
        "title": title(&sentence, assignee.as_ref().map(|(_, matched, _)| matched.as_str())),
        "suggest": input.threshold.is_some_and(|threshold| score >= threshold) && assignee.is_some()
    });
    if let Some((person, _, index)) = assignee {
        result["assignee"] = person;
        if let Some(index) = index {
            result["assigneeIndex"] = json!(index);
        }
    }
    if let Some(due) = due {
        result["due"] = json!(due);
    }
    Ok(result)
}

pub fn dispatch(operation: &str, input: Value) -> Result<Value, String> {
    match operation {
        "tasks.parseDue" => Ok(parse_due(
            input["text"].as_str().ok_or("Missing text")?,
            input["reference"].as_i64(),
        )?
        .map(Value::String)
        .unwrap_or(Value::Null)),
        "tasks.formatDue" => Ok(Value::String(format_due(
            input["due"].as_str().ok_or("Missing due")?,
        ))),
        "tasks.score" => score(serde_json::from_value(input).map_err(|error| error.to_string())?),
        _ => Err(format!("Unknown tasks operation: {operation}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const POSTED: i64 = 1_791_195_720_000;

    #[test]
    fn agreement_fixture_keeps_explanation_owner_title_and_date() {
        let result = dispatch("tasks.score", json!({"text":"Agreed: Maya raises the replica storage quota before the final wave. Due Fri 16 Oct.","people":[{"slackId":"UMAYA","name":"Maya"}],"postedAt":POSTED,"threshold":0.6})).unwrap();
        assert_eq!(result["title"], "Raise replica storage quota");
        assert_eq!(result["due"], "2026-10-16");
        assert_eq!(result["score"], 0.95);
        assert_eq!(result["suggest"], true);
        assert_eq!(result["assignee"]["slackId"], "UMAYA");
        assert_eq!(format_due("2026-10-16"), "Fri 16 Oct");
    }

    #[test]
    fn questions_and_missing_owners_do_not_suggest() {
        for text in [
            "Could we maybe have Maya raise the quota?",
            "Agreed: raise the replica storage quota by Fri 16 Oct",
        ] {
            let result = dispatch("tasks.score", json!({"text":text,"people":[{"slackId":"UMAYA","name":"Maya"}],"postedAt":POSTED,"threshold":0.6})).unwrap();
            assert_eq!(result["suggest"], false);
        }
    }

    #[test]
    fn messages_without_signals_score_positive_zero() {
        let result = dispatch(
            "tasks.score",
            json!({"text":"will be doing things","people":[],"postedAt":POSTED,"threshold":0.6}),
        )
        .unwrap();
        assert!(result["score"].as_f64().unwrap().is_sign_positive());
        assert_eq!(result["score"], 0.0);
    }

    #[test]
    fn scoring_preserves_ascii_case_folding_and_utf16_title_capitalization() {
        let result = dispatch("tasks.score", json!({"text":"Deciſion: Maya muſt reſtart the server","people":[{"slackId":"UMAYA","name":"Maya"}],"postedAt":POSTED,"threshold":0.6})).unwrap();
        assert_eq!(result["score"], 0.2);
        assert_eq!(result["suggest"], false);
        assert_eq!(result["title"], "Deciſion: muſt reſtart server");
        assert_eq!(title("𐐨foo", None), "𐐨foo");
    }

    #[test]
    fn due_precedence_and_invalid_named_dates() {
        assert_eq!(
            parse_due("tomorrow and 2026-99-99", Some(POSTED)).unwrap(),
            Some("2026-99-99".to_string())
        );
        assert_eq!(parse_due("on 31 Feb tomorrow", Some(POSTED)).unwrap(), None);
        assert_eq!(
            parse_due("by Monday", Some(POSTED)).unwrap(),
            Some("2026-10-12".to_string())
        );
        assert_eq!(
            parse_due("by Friday", Some(POSTED)).unwrap(),
            Some("2026-10-09".to_string())
        );
    }
}
