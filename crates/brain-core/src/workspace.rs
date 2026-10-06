use crate::retrieval::query_terms;
use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::LazyLock;

const DAY: f64 = 86_400_000.0;

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Source {
    Slack,
    Jira,
    Confluence,
    Drive,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    doc_id: String,
    source: Source,
    title: String,
    content: String,
    url: String,
    version: f64,
    metadata: IndexMap<String, String>,
    links: Vec<String>,
    timestamp: Option<f64>,
    #[serde(default)]
    slack_messages: Vec<Value>,
}

impl Document {
    fn meta(&self, key: &str) -> Option<&str> {
        self.metadata.get(key).map(String::as_str)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    key: String,
    name: String,
    master_doc_id: String,
    doc_ids: Vec<String>,
}

#[derive(Serialize)]
struct Score {
    score: f64,
    reasons: Vec<String>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    #[serde(default)]
    docs: Vec<Document>,
    #[serde(default)]
    issues: Vec<Document>,
    #[serde(default)]
    projects: Vec<Project>,
    #[serde(default)]
    project_order: Vec<Vec<String>>,
    doc: Option<Document>,
    master: Option<Document>,
    now: Option<f64>,
    #[serde(default)]
    text: String,
    #[serde(default)]
    live: bool,
    person: Option<Person>,
    project: Option<ProjectName>,
    #[serde(default)]
    entries: Vec<SummaryEntry>,
    #[serde(default)]
    batches: Vec<SummaryBatch>,
    #[serde(default)]
    verifies: bool,
}

#[derive(Deserialize)]
struct Person {
    name: String,
    groups: Vec<String>,
    role: String,
}
#[derive(Deserialize)]
struct ProjectName {
    name: String,
}
#[derive(Deserialize)]
struct SummaryEntry {
    #[serde(rename = "type")]
    kind: String,
    name: String,
    timestamp: Option<f64>,
    allowed: Option<bool>,
}
#[derive(Deserialize)]
struct SummaryBatch {
    timestamp: Option<f64>,
}

fn whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn sentences(text: &str) -> Vec<String> {
    let mut output = Vec::new();
    let mut start = 0;
    let mut previous = None;
    for (at, c) in text.char_indices() {
        if whitespace(c) && previous.is_some_and(|p| matches!(p, '.' | '!' | '?')) {
            let sentence = text[start..at].trim_matches(whitespace);
            if !sentence.is_empty() {
                output.push(sentence.to_owned());
            }
            start = at + c.len_utf8();
        }
        previous = Some(c);
    }
    let sentence = text[start..].trim_matches(whitespace);
    if !sentence.is_empty() {
        output.push(sentence.to_owned());
    }
    output
}

fn normalize_sentence(text: &str) -> String {
    let mut output = String::new();
    let mut in_space = false;
    for c in text.to_lowercase().chars() {
        if whitespace(c) {
            if !in_space {
                output.push(' ');
            }
            in_space = true;
        } else {
            output.push(c);
            in_space = false;
        }
    }
    output
}

fn projects_for(docs: &[Document]) -> Vec<Project> {
    static MASTER: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"[\t\n\x0b\x0c\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]+(?i-u:master page)$").unwrap()
    });
    let by_id: IndexMap<_, _> = docs.iter().map(|doc| (doc.doc_id.as_str(), doc)).collect();
    docs.iter()
        .filter(|doc| {
            doc.source == Source::Confluence
                && doc.meta("label") == Some("master")
                && doc.meta("space").is_some_and(|key| !key.is_empty())
        })
        .map(|master| {
            let key = master.meta("space").unwrap();
            let mut members = IndexSet::new();
            members.insert(master.doc_id.as_str());
            members.extend(master.links.iter().map(String::as_str));
            for doc in docs {
                if if doc.source == Source::Confluence {
                    doc.meta("space") == Some(key)
                } else {
                    doc.source != Source::Drive && doc.meta("project") == Some(key)
                } {
                    members.insert(doc.doc_id.as_str());
                }
            }
            for id in members.iter().copied().collect::<Vec<_>>() {
                if let Some(doc) = by_id.get(id).filter(|doc| doc.source == Source::Jira) {
                    for link in &doc.links {
                        if by_id
                            .get(link.as_str())
                            .is_some_and(|doc| matches!(doc.source, Source::Drive | Source::Slack))
                        {
                            members.insert(link.as_str());
                        }
                    }
                }
            }
            let mut doc_ids: Vec<_> = members
                .into_iter()
                .filter(|id| by_id.contains_key(id))
                .map(str::to_owned)
                .collect();
            doc_ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            Project {
                key: key.into(),
                name: MASTER.replace(&master.title, "").into_owned(),
                master_doc_id: master.doc_id.clone(),
                doc_ids,
            }
        })
        .collect()
}

fn round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

fn latest_score(doc: &Document, now: Option<f64>, master: Option<&Document>) -> Score {
    let mut reasons = Vec::new();
    let status = doc.meta("status").unwrap_or("");
    let points = match status {
        "final" => 40,
        "in review" => 20,
        "draft" => 8,
        _ => 0,
    };
    let mut score = points as f64;
    if points != 0 {
        reasons.push(format!("{status} (+{points})"));
    }
    if let Some(age) = now
        .zip(doc.timestamp)
        .map(|(now, timestamp)| ((now - timestamp) / DAY).max(0.0))
    {
        let recency = (30.0 - age).max(0.0);
        if recency != 0.0 {
            let days = round(age);
            let edited = if days == 0.0 {
                "today".into()
            } else {
                format!("{days} day{} ago", if days == 1.0 { "" } else { "s" })
            };
            reasons.push(format!("edited {edited} (+{})", round(recency)));
            score += recency;
        }
    }
    let version = doc.version.min(10.0);
    score += version;
    reasons.push(format!("version {} (+{version})", doc.version));
    if master.is_some_and(|master| master.links.contains(&doc.doc_id)) {
        score += 15.0;
        reasons.push("linked to the master page (+15)".into());
    }
    Score {
        score: round(score * 100.0) / 100.0,
        reasons,
    }
}

fn best<'a>(
    docs: impl Iterator<Item = &'a Document>,
    now: Option<f64>,
    master: Option<&Document>,
) -> Option<Value> {
    let mut best: Option<(&Document, Score)> = None;
    for doc in
        docs.filter(|doc| doc.source == Source::Drive && doc.meta("status") != Some("superseded"))
    {
        let score = latest_score(doc, now, master);
        if best.as_ref().is_none_or(|(_, old)| score.score > old.score) {
            best = Some((doc, score));
        }
    }
    best.map(
        |(doc, score)| json!({"docId": doc.doc_id, "score": score.score, "reasons": score.reasons}),
    )
}

fn latest_for(input: &Input) -> Vec<Value> {
    let mut output = best(input.docs.iter(), input.now, None)
        .into_iter()
        .collect::<Vec<_>>();
    for project in &input.projects {
        let master = input
            .docs
            .iter()
            .find(|doc| doc.doc_id == project.master_doc_id);
        if let Some(mut found) = best(
            input
                .docs
                .iter()
                .filter(|doc| project.doc_ids.contains(&doc.doc_id)),
            input.now,
            master,
        ) {
            found["project"] = json!(project.key);
            output.push(found);
        }
    }
    output
}

fn normalize_title(title: &str) -> String {
    static LABEL: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?-u:\b)(copy|draft|final|v[0-9]+)(?-u:\b)").unwrap());
    static WORDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9]+").unwrap());
    WORDS
        .replace_all(&LABEL.replace_all(&title.to_lowercase(), ""), " ")
        .trim()
        .into()
}

fn only(from: &Document, than: &Document) -> Vec<String> {
    let theirs: IndexSet<_> = sentences(&than.content)
        .iter()
        .map(|sentence| normalize_sentence(sentence))
        .collect();
    sentences(&from.content)
        .into_iter()
        .filter(|sentence| !theirs.contains(&normalize_sentence(sentence)))
        .collect()
}

fn duplicates_for(input: &Input) -> Vec<Value> {
    let files: Vec<_> = input
        .docs
        .iter()
        .filter(|doc| doc.source == Source::Drive)
        .collect();
    let words: IndexMap<_, IndexSet<_>> = files
        .iter()
        .map(|doc| {
            (
                doc.doc_id.as_str(),
                query_terms(&doc.content).into_iter().collect(),
            )
        })
        .collect();
    let mut output = Vec::new();
    for (index, a) in files.iter().enumerate() {
        for b in &files[index + 1..] {
            let superseded = [a, b]
                .into_iter()
                .filter(|doc| doc.meta("status") == Some("superseded"))
                .count();
            let mut reasons = Vec::new();
            if superseded == 1 && normalize_title(&a.title) == normalize_title(&b.title) {
                reasons.push("same title".into());
            }
            let words_a = &words[a.doc_id.as_str()];
            let words_b = &words[b.doc_id.as_str()];
            let intersection = words_a.intersection(words_b).count();
            let shared =
                intersection as f64 / (words_a.len() + words_b.len() - intersection).max(1) as f64;
            if shared >= 0.6 {
                reasons.push(format!(
                    "{}% of their words are shared",
                    round(shared * 100.0)
                ));
            }
            if reasons.is_empty() || superseded == 2 {
                continue;
            }
            let keep_a = if superseded == 1 {
                a.meta("status") != Some("superseded")
            } else {
                latest_score(a, input.now, None).score >= latest_score(b, input.now, None).score
            };
            let (keep, other) = if keep_a { (a, b) } else { (b, a) };
            if superseded == 1 {
                reasons.push("the other is marked superseded".into());
            }
            output.push(json!({"keep": keep.doc_id, "other": other.doc_id, "reasons": reasons, "onlyInKeep": only(keep, other), "onlyInOther": only(other, keep)}));
        }
    }
    output
}

fn agreement_summary(sentence: &str) -> Option<String> {
    static AGREEMENT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?i-u:agreed[:,]|decision:|decided:|approved:|ok,? let's|let's go with)[\t\n\x0b\x0c\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*").unwrap()
    });
    let phrase = AGREEMENT.find(sentence)?;
    let rest = sentence[phrase.end()..]
        .trim_end_matches(['.', '!', '?'])
        .trim_matches(whitespace);
    (!rest.is_empty()).then(|| rest.to_owned())
}

fn tracked(sentence: &str, issues: &[&Document]) -> bool {
    let needle = normalize_sentence(sentence);
    issues
        .iter()
        .any(|issue| normalize_sentence(&issue.content).contains(&needle))
}

struct IssueProjects<'a> {
    linked: IndexMap<&'a str, Vec<(usize, &'a str)>>,
    present: IndexSet<Option<&'a str>>,
    ranks: IndexMap<&'a str, usize>,
}

impl<'a> IssueProjects<'a> {
    fn new(issues: impl Iterator<Item = &'a Document>, order: &'a [Vec<String>]) -> Self {
        let mut linked = IndexMap::<_, Vec<_>>::new();
        let mut present = IndexSet::new();
        for (index, issue) in issues.enumerate() {
            let project = issue.meta("project");
            present.insert(project);
            if let Some(project) = project.filter(|project| !project.is_empty()) {
                linked
                    .entry(issue.doc_id.as_str())
                    .or_default()
                    .push((index, project));
            }
        }
        let ranks = order
            .iter()
            .enumerate()
            .flat_map(|(rank, group)| group.iter().map(move |project| (project.as_str(), rank)))
            .collect();
        Self {
            linked,
            present,
            ranks,
        }
    }

    fn of(&self, thread: &Document) -> Option<String> {
        let mut counts = IndexMap::<&str, (usize, usize)>::new();
        for id in thread
            .links
            .iter()
            .map(String::as_str)
            .collect::<IndexSet<_>>()
        {
            if let Some(issues) = self.linked.get(id) {
                for &(index, project) in issues {
                    let (count, first) = counts.entry(project).or_insert((0, index));
                    *count += 1;
                    *first = (*first).min(index);
                }
            }
        }
        let rank = |project: &str| self.ranks.get(project).copied().unwrap_or(usize::MAX);
        let linked = counts
            .into_iter()
            .min_by(|(a, (x, first_a)), (b, (y, first_b))| {
                y.cmp(x)
                    .then_with(|| rank(a).cmp(&rank(b)))
                    .then_with(|| first_a.cmp(first_b))
            })
            .map(|(project, _)| project);
        linked
            .or_else(|| {
                self.present
                    .contains(&thread.meta("project"))
                    .then(|| thread.meta("project"))
                    .flatten()
            })
            .map(str::to_owned)
    }
}

fn project_of(thread: &Document, issues: &[&Document], order: &[Vec<String>]) -> Option<String> {
    IssueProjects::new(issues.iter().copied(), order).of(thread)
}

fn projects_of(input: &Input) -> Vec<Option<String>> {
    let projects = IssueProjects::new(input.issues.iter(), &input.project_order);
    input
        .docs
        .iter()
        .map(|thread| projects.of(thread))
        .collect()
}

fn commitment_summary(sentence: &str) -> Option<String> {
    if let Some(summary) = agreement_summary(sentence) {
        return Some(summary);
    }
    static COMMITMENT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^(?:I (?:will|promise to|commit to)|track(?: this)?:)\s+(.+)").unwrap()
    });
    let matched = COMMITMENT.captures(sentence)?;
    let rest = matched
        .get(1)?
        .as_str()
        .trim_end_matches(['.', '!', '?'])
        .trim_matches(whitespace);
    (!rest.is_empty()).then(|| rest.to_owned())
}

fn agreements_for(input: &Input) -> Vec<Value> {
    let issues = input
        .docs
        .iter()
        .filter(|doc| doc.source == Source::Jira)
        .collect::<Vec<_>>();
    let projects = IssueProjects::new(issues.iter().copied(), &input.project_order);
    let mut output = Vec::new();
    for thread in input.docs.iter().filter(|doc| doc.source == Source::Slack) {
        let Some(project) = projects.of(thread).filter(|project| !project.is_empty()) else {
            continue;
        };
        let evidence: Vec<(String, Option<&Value>)> = if thread.slack_messages.is_empty() {
            sentences(&thread.content)
                .into_iter()
                .map(|sentence| (sentence, None))
                .collect()
        } else {
            thread
                .slack_messages
                .iter()
                .flat_map(|message| {
                    sentences(message.get("text").and_then(Value::as_str).unwrap_or(""))
                        .into_iter()
                        .map(move |sentence| (sentence, Some(message)))
                })
                .collect()
        };
        for (sentence, message) in evidence {
            let Some(summary) = commitment_summary(&sentence) else {
                continue;
            };
            if tracked(&sentence, &issues) {
                continue;
            }
            let mut suggestion = json!({"threadDocId": thread.doc_id, "sentence": sentence, "project": project, "summary": summary, "canCreate": !input.live});
            if let Some(message) = message {
                suggestion["message"] = message.clone();
            }
            if input.live {
                if let Some(example) = issues
                    .iter()
                    .find(|issue| issue.meta("project") == Some(&project))
                {
                    suggestion["jiraUrl"] = json!(example.url);
                }
            }
            output.push(suggestion);
        }
    }
    output
}

fn catch_up_question(person: &Person, project: Option<&ProjectName>) -> Option<String> {
    if person.role == "compliance" {
        return None;
    }
    if person.groups.iter().any(|group| group == "interns") {
        return Some(format!("What should a new hire read first{}: the overview, the milestones and the workflow guides?", project.map(|project| format!(" about {}", project.name)).unwrap_or_default()));
    }
    if person.groups.is_empty() {
        return Some(format!(
            "What has been shared with {}, and what does {} own?",
            person.name, person.name
        ));
    }
    Some(format!(
        "What is the status of {}, what are the blockers, and what was decided recently?",
        project
            .map(|project| project.name.as_str())
            .unwrap_or("the work I can see")
    ))
}

fn plural(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

fn audit_summary(input: &Input) -> Vec<String> {
    let since = input.now.map(|now| now - 7.0 * DAY);
    let recent = input
        .entries
        .iter()
        .filter(|entry| {
            since
                .zip(entry.timestamp)
                .is_some_and(|(since, time)| time >= since)
        })
        .collect::<Vec<_>>();
    let count = |types: &[&str]| {
        recent
            .iter()
            .filter(|entry| types.contains(&entry.kind.as_str()))
            .count()
    };
    let mut askers = recent
        .iter()
        .filter(|entry| entry.kind == "query_received")
        .map(|entry| entry.name.as_str())
        .collect::<IndexSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    askers.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let names = match askers.as_slice() {
        [] => String::new(),
        [name] => (*name).to_owned(),
        names => format!(
            "{} and {}",
            names[..names.len() - 1].join(", "),
            names.last().unwrap()
        ),
    };
    let denied = recent
        .iter()
        .filter(|entry| {
            ["access_decision", "live_access_decision"].contains(&entry.kind.as_str())
                && entry.allowed == Some(false)
        })
        .count();
    vec![
        format!(
            "{} in the last 7 days{}.",
            plural(count(&["query_received"]), "question", "questions"),
            if names.is_empty() {
                String::new()
            } else {
                format!(", from {names}")
            }
        ),
        format!(
            "{} denied access.",
            plural(denied, "document check", "document checks")
        ),
        format!(
            "{} and {}.",
            plural(
                count(&[
                    "tier_narrowed",
                    "native_permission_changed",
                    "group_membership_removed",
                    "channel_membership_removed"
                ]),
                "permission change",
                "permission changes"
            ),
            plural(
                count(&["source_content_changed"]),
                "content edit",
                "content edits"
            )
        ),
        format!(
            "{} created from the workspace and {} marked done.",
            plural(count(&["task_created"]), "Jira task", "Jira tasks"),
            count(&["task_status_changed"])
        ),
        format!(
            "{} sealed. The chain verifies: {}.",
            plural(
                input
                    .batches
                    .iter()
                    .filter(|batch| since
                        .zip(batch.timestamp)
                        .is_some_and(|(since, time)| time >= since))
                    .count(),
                "Merkle batch",
                "Merkle batches"
            ),
            if input.verifies { "yes" } else { "no" }
        ),
    ]
}

pub fn dispatch(operation: &str, input: Value) -> Result<Value, String> {
    let input: Input = serde_json::from_value(input)
        .map_err(|error| format!("Invalid workspace input: {error}"))?;
    Ok(match operation {
        "workspace.sentences" => json!(sentences(&input.text)),
        "workspace.projectsFor" => json!(projects_for(&input.docs)),
        "workspace.latestScore" => json!(latest_score(
            input.doc.as_ref().ok_or("Missing document")?,
            input.now,
            input.master.as_ref()
        )),
        "workspace.latestFor" => json!(latest_for(&input)),
        "workspace.duplicatesFor" => json!(duplicates_for(&input)),
        "workspace.agreementSummary" => json!(agreement_summary(&input.text)),
        "workspace.commitmentSummary" => json!(commitment_summary(&input.text)),
        "workspace.tracked" => json!(tracked(
            &input.text,
            &input.issues.iter().collect::<Vec<_>>()
        )),
        "workspace.projectOf" => json!(project_of(
            input.doc.as_ref().ok_or("Missing document")?,
            &input.issues.iter().collect::<Vec<_>>(),
            &input.project_order
        )),
        "workspace.projectsOf" => json!(projects_of(&input)),
        "workspace.agreementsFor" => json!(agreements_for(&input)),
        "workspace.catchUpQuestion" => json!(catch_up_question(
            input.person.as_ref().ok_or("Missing person")?,
            input.project.as_ref()
        )),
        "workspace.auditSummary" => json!(audit_summary(&input)),
        _ => return Err(format!("Unknown workspace operation: {operation}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(id: &str, source: &str, metadata: Value, links: &[&str]) -> Value {
        json!({"docId": id, "source": source, "title": id, "content": "", "url": "https://jira.example/browse/A-1", "version": 1, "metadata": metadata, "links": links, "timestamp": 0})
    }

    #[test]
    fn sentences_preserve_internal_whitespace_and_use_ecmascript_boundaries() {
        assert_eq!(
            sentences(" One  sentence.\tSecond\nline!\u{00a0}Third? "),
            vec!["One  sentence.", "Second\nline!", "Third?"]
        );
        assert_eq!(
            sentences(" A.\u{0085}B.\u{feff}C. "),
            vec!["A.\u{0085}B.", "C."]
        );
    }

    #[test]
    fn projects_follow_visible_issue_links_and_remove_missing_ids() {
        let result = dispatch("workspace.projectsFor", json!({"docs": [
            doc("confluence:master", "confluence", json!({"label":"master", "space":"A"}), &["jira:A-1", "hidden"]),
            doc("jira:A-1", "jira", json!({"project":"A"}), &["drive:one", "slack:one"]),
            doc("drive:one", "drive", json!({}), &[]),
            doc("slack:one", "slack", json!({}), &[]),
            doc("drive:other", "drive", json!({"project":"A"}), &[])
        ]})).unwrap();
        assert_eq!(
            result[0]["docIds"],
            json!(["confluence:master", "drive:one", "jira:A-1", "slack:one"])
        );
    }

    #[test]
    fn project_count_ties_use_the_node_order_and_latest_ties_keep_input_order() {
        let result = dispatch("workspace.projectOf", json!({"doc": doc("slack:one", "slack", json!({}), &["jira:one", "jira:two"]), "issues": [doc("jira:one", "jira", json!({"project":"Z"}), &[]), doc("jira:two", "jira", json!({"project":"a"}), &[])], "projectOrder": [["a"], ["Z"]]})).unwrap();
        assert_eq!(result, json!("a"));
        let result = dispatch("workspace.latestFor", json!({"docs":[doc("drive:first", "drive", json!({}), &[]),doc("drive:second", "drive", json!({}), &[])], "now": 0})).unwrap();
        assert_eq!(result[0]["docId"], json!("drive:first"));
    }

    #[test]
    fn missing_dates_skip_recency_and_preserve_other_score_reasons() {
        let mut file = doc("drive:one", "drive", json!({"status":"final"}), &[]);
        file["timestamp"] = Value::Null;
        let result = dispatch("workspace.latestScore", json!({"doc":file, "now":0})).unwrap();
        assert_eq!(result["score"].as_f64(), Some(41.0));
        assert_eq!(result["reasons"], json!(["final (+40)", "version 1 (+1)"]));
    }

    #[test]
    fn ascii_phrases_do_not_fold_long_s_or_kelvin_sign() {
        assert_eq!(agreement_summary("deciſion: Ship"), None);
        assert_eq!(agreement_summary("oK, let's ship"), None);
        let mut master = doc(
            "confluence:master",
            "confluence",
            json!({"label":"master", "space":"PAY"}),
            &[],
        );
        master["title"] = json!("PAY Maſter page");
        let result = dispatch("workspace.projectsFor", json!({"docs":[master]})).unwrap();
        assert_eq!(result[0]["name"], json!("PAY Maſter page"));
        assert_eq!(round(0.49999999999999994), 0.0);
    }

    #[test]
    fn bulk_projects_count_duplicate_issues_once_per_link_and_preserve_thread_order() {
        let result = dispatch(
            "workspace.projectsOf",
            json!({"docs": [
            doc("slack:first", "slack", json!({}), &["jira:two", "jira:one", "jira:one"]),
            doc("slack:second", "slack", json!({}), &["jira:one"]),
            doc("slack:third", "slack", json!({"project":"Z"}), &[]),
            doc("slack:fourth", "slack", json!({"project":"absent"}), &[]),
            doc("slack:empty", "slack", json!({"project":""}), &[]),
            doc("slack:missing", "slack", json!({}), &[])
        ], "issues": [
            doc("jira:one", "jira", json!({"project":"a"}), &[]),
            doc("jira:one", "jira", json!({"project":"Z"}), &[]),
            doc("jira:two", "jira", json!({"project":"Z"}), &[]),
            doc("jira:empty", "jira", json!({"project":""}), &[])
        ], "projectOrder": [["a"], ["Z"]]}),
        )
        .unwrap();
        assert_eq!(result, json!(["Z", "a", "Z", null, "", null]));
    }

    #[test]
    fn collation_equivalent_projects_choose_the_first_linked_issue() {
        let result = dispatch(
            "workspace.projectsOf",
            json!({"docs": [
            doc("slack:first", "slack", json!({}), &["jira:second", "jira:first"]),
            doc("slack:second", "slack", json!({}), &["jira:unlinked", "jira:first"])
        ], "issues": [
            doc("jira:unlinked", "jira", json!({"project":"é"}), &[]),
            doc("jira:first", "jira", json!({"project":"e\u{301}"}), &[]),
            doc("jira:second", "jira", json!({"project":"é"}), &[])
        ], "projectOrder": [["é", "e\u{301}"]]}),
        )
        .unwrap();
        assert_eq!(result, json!(["e\u{301}", "é"]));
    }
}
