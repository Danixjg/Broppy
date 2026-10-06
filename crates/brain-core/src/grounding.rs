mod meaning;
mod words;
use meaning::{control_action, meaning_of, ActionMeaning, ActionTiming, SentenceMeaning};
use words::{
    compact_spaces, display_text, fact_words, is_name, matches, rules, sentences_of, statuses_in,
    trim, without_statuses, words_of, Statuses, Vocabulary, Word,
};
pub use words::{fold, number_value, same_word, split_clauses, stem};

use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use serde_json::{json, Value};

const NO_RESULT: &str = "No accessible information was found for this query.";
struct Sentence {
    text: String,
    folded: String,
    words: Vec<Word>,
    facts: Vec<Word>,
    statuses: Statuses,
    meaning: SentenceMeaning,
}

struct Passage {
    id: String,
    sentences: Vec<Sentence>,
    folded: String,
    extras: Vec<Word>,
    labels: IndexMap<String, Statuses>,
}

fn passage_of(id: &str, text: &str, citation: &Value) -> Passage {
    let sentences = sentences_of(text)
        .into_iter()
        .map(|text| {
            let words = words_of(&text);
            let folded = fold(&text);
            Sentence {
                facts: fact_words(&words),
                statuses: statuses_in(&folded),
                meaning: meaning_of(&words, None),
                text,
                folded,
                words,
            }
        })
        .collect();
    let platform = id.split(':').next().unwrap_or_default();
    let mut extras = words_of(
        citation
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    extras.extend(words_of(if platform == "drive" {
        "drive google"
    } else {
        platform
    }));
    let labels = rules()
        .label
        .captures_iter(text)
        .map(|item| (item[1].to_lowercase(), statuses_in(&fold(&item[2]))))
        .collect();
    Passage {
        id: id.to_owned(),
        sentences,
        folded: fold(text),
        extras,
        labels,
    }
}

struct Clause {
    words: Vec<Word>,
    facts: Vec<Word>,
    statuses: Statuses,
    plain: Vec<Word>,
}

fn analyse(text: &str) -> Clause {
    let folded = fold(text);
    let words = words_of(text);
    Clause {
        facts: fact_words(&words),
        statuses: statuses_in(&folded),
        plain: fact_words(&words_of(&without_statuses(&folded)))
            .into_iter()
            .filter(|item| !rules().meaning.contains(item.word.as_str()))
            .collect(),
        words,
    }
}

struct Failure {
    reason: &'static str,
    detail: String,
}

struct ClauseResult {
    failure: Option<Failure>,
    score: f64,
    used_sentence: bool,
}

fn quote(word: &str) -> String {
    format!("\"{word}\"")
}

fn any_of<'a>(words: &'a [Word], vocabulary: &Vocabulary) -> Option<&'a Word> {
    words
        .iter()
        .find(|item| vocabulary.contains(item.word.as_str()))
}

fn negated_words(words: &[Word]) -> Vec<(&str, &Word)> {
    words
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            if !rules().negations.contains(item.word.as_str()) {
                return None;
            }
            words[index + 1..words.len().min(index + 4)]
                .iter()
                .find(|candidate| {
                    !rules().function.contains(candidate.word.as_str())
                        && !rules().negations.contains(candidate.word.as_str())
                })
                .map(|next| (item.raw.as_str(), next))
        })
        .collect()
}

fn check_clause(clause: &Clause, sentence: &Sentence, passage: &Passage) -> ClauseResult {
    let in_sentence = |item: &Word| sentence.words.iter().any(|other| matches(item, other));
    let in_extras = |item: &Word| passage.extras.iter().any(|other| matches(item, other));
    let mut used_sentence = false;
    let mut matched = 0.0;
    let mut total = 0.0;
    let mut failures = Vec::new();
    for (index, item) in clause.facts.iter().enumerate() {
        let Some(value) = number_value(&item.word) else {
            continue;
        };
        total += 1.0;
        let neighbours: Vec<&Word> = [
            index
                .checked_sub(1)
                .and_then(|index| clause.facts.get(index)),
            clause.facts.get(index + 1),
        ]
        .into_iter()
        .flatten()
        .collect();
        let bound = sentence.facts.iter().enumerate().any(|(at, other)| {
            number_value(&other.word).as_ref() == Some(&value)
                && (neighbours.is_empty()
                    || [
                        at.checked_sub(1)
                            .and_then(|index| sentence.facts.get(index)),
                        sentence.facts.get(at + 1),
                    ]
                    .into_iter()
                    .flatten()
                    .any(|near| neighbours.iter().any(|mine| matches(mine, near))))
        });
        if bound {
            matched += 1.0;
            used_sentence = true;
            continue;
        }
        let present = sentence
            .facts
            .iter()
            .any(|other| number_value(&other.word).as_ref() == Some(&value));
        if present {
            matched += 0.5;
        }
        failures.push(Failure {
            reason: "new_fact",
            detail: if present {
                format!(
                    "{} isn't tied to the same words in the passage",
                    quote(&item.raw)
                )
            } else {
                format!("the passage doesn't have {}", quote(&item.raw))
            },
        });
    }
    for item in &clause.facts {
        let kind = if is_name(item) {
            "name"
        } else if rules().time.contains(item.word.as_str()) {
            "time"
        } else if rules().quantifiers.contains(item.word.as_str()) {
            "quantity"
        } else {
            continue;
        };
        total += 1.0;
        if in_sentence(item) {
            matched += 1.0;
            used_sentence = true;
        } else if kind != "quantity" && in_extras(item) {
            matched += 1.0;
        } else {
            failures.push(Failure {
                reason: "new_fact",
                detail: if kind == "quantity" {
                    format!("adds {}", quote(&item.raw))
                } else {
                    format!("the passage doesn't have {}", quote(&item.raw))
                },
            });
        }
    }
    for status in &clause.statuses {
        if !sentence.statuses.contains(status) {
            let theirs = sentence
                .statuses
                .iter()
                .copied()
                .collect::<Vec<_>>()
                .join(" or ");
            failures.push(Failure {
                reason: "changed_meaning",
                detail: format!(
                    "says {status}, but the passage says {}",
                    if theirs.is_empty() {
                        "neither"
                    } else {
                        &theirs
                    }
                ),
            });
        }
    }
    if !clause.statuses.is_empty() && clause.plain.len() == 1 && is_name(&clause.plain[0]) {
        let key = &clause.plain[0].word;
        let label = passage.labels.get(key);
        let near = sentence.facts.iter().enumerate().any(|(at, other)| {
            other.word == *key
                && sentence.facts[at.saturating_sub(2)..sentence.facts.len().min(at + 3)]
                    .iter()
                    .any(|word| {
                        clause
                            .statuses
                            .iter()
                            .any(|status| statuses_in(&word.word).contains(status))
                    })
        });
        if label.map_or(!near, |label| {
            !clause.statuses.iter().all(|status| label.contains(status))
        }) {
            failures.push(Failure {
                reason: "changed_meaning",
                detail: format!(
                    "says {} is {}, but the passage says {}",
                    clause.plain[0].raw,
                    clause
                        .statuses
                        .iter()
                        .copied()
                        .collect::<Vec<_>>()
                        .join(" and "),
                    label.map_or_else(
                        || "otherwise".to_owned(),
                        |label| label.iter().copied().collect::<Vec<_>>().join(" or ")
                    )
                ),
            });
        }
    }
    for (mine, opposite, name, other) in [
        (&rules().before, &rules().after, "before", "after"),
        (&rules().after, &rules().before, "after", "before"),
        (&rules().more, &rules().less, "more", "less"),
        (&rules().less, &rules().more, "less", "more"),
    ] {
        if any_of(&clause.words, mine).is_some() && any_of(&sentence.words, mine).is_none() {
            failures.push(Failure {
                reason: "changed_meaning",
                detail: format!(
                    "says {name}, but the passage says {}",
                    if any_of(&sentence.words, opposite).is_some() {
                        other
                    } else {
                        "neither"
                    }
                ),
            });
        }
    }
    let negation = any_of(&clause.words, &rules().negations);
    if let Some(negation) = negation {
        if any_of(&sentence.words, &rules().negations).is_none() {
            failures.push(Failure {
                reason: "changed_meaning",
                detail: format!("adds {}", quote(&negation.raw)),
            });
        }
    } else {
        for (theirs, word) in negated_words(&sentence.words) {
            if clause.words.iter().any(|item| matches(item, word)) {
                failures.push(Failure {
                    reason: "changed_meaning",
                    detail: format!(
                        "drops the passage's {} before {}",
                        quote(theirs),
                        quote(&word.raw)
                    ),
                });
            }
        }
    }
    let hedge = any_of(&clause.words, &rules().hedges);
    let their_hedge = any_of(&sentence.words, &rules().hedges);
    if let (Some(theirs), None) = (their_hedge, hedge) {
        failures.push(Failure {
            reason: "changed_meaning",
            detail: format!("drops the passage's {}", quote(&theirs.raw)),
        });
    }
    if let (Some(mine), None) = (hedge, their_hedge) {
        failures.push(Failure {
            reason: "changed_meaning",
            detail: format!("adds {}", quote(&mine.raw)),
        });
    }
    let meaning = meaning_of(&clause.words, Some(&sentence.meaning.names));
    for action in &meaning.actions {
        let candidates: Vec<&ActionMeaning> = sentence
            .meaning
            .actions
            .iter()
            .filter(|other| matches(&action.action, &other.action))
            .collect();
        if candidates.is_empty() {
            if in_sentence(&action.action)
                && (action.actor.is_some()
                    || action.target.is_some()
                    || action.timing != ActionTiming::Current)
            {
                failures.push(Failure {
                    reason: "changed_meaning",
                    detail: format!(
                        "can't establish the roles and timing of {}",
                        quote(&action.action.raw)
                    ),
                });
            }
            continue;
        }
        let same_roles: Vec<&ActionMeaning> = candidates
            .into_iter()
            .filter(|other| {
                action.actor == other.actor
                    && action.target == other.target
                    && (!control_action(&action.action.word)
                        || (other.actor.is_some() && other.target.is_some()))
            })
            .collect();
        if same_roles.is_empty() {
            failures.push(Failure {
                reason: "changed_meaning",
                detail: format!(
                    "changes who {} or receives the action",
                    quote(&action.action.raw)
                ),
            });
            continue;
        }
        let same_timing: Vec<&ActionMeaning> = same_roles
            .iter()
            .copied()
            .filter(|other| {
                let current = if action.timing == ActionTiming::Current {
                    action
                } else {
                    *other
                };
                action.timing == other.timing
                    || ((meaning.agreement || sentence.meaning.agreement)
                        && action.timing != ActionTiming::Completed
                        && other.timing != ActionTiming::Completed
                        && !current.explicit_timing)
            })
            .collect();
        if same_timing.is_empty() {
            failures.push(Failure {
                reason: "changed_meaning",
                detail: format!(
                    "changes {} from {} to {}",
                    quote(&action.action.raw),
                    same_roles[0].timing.label(),
                    action.timing.label()
                ),
            });
        } else if !same_timing
            .iter()
            .any(|other| action.negated == other.negated)
        {
            failures.push(Failure {
                reason: "changed_meaning",
                detail: format!("changes the negation of {}", quote(&action.action.raw)),
            });
        }
    }
    let mut missing = Vec::new();
    for item in &clause.plain {
        if number_value(&item.word).is_some()
            || rules().time.contains(item.word.as_str())
            || is_name(item)
        {
            continue;
        }
        total += 1.0;
        if in_sentence(item) {
            matched += 1.0;
            used_sentence = true;
        } else if in_extras(item) {
            matched += 1.0;
        } else {
            missing.push(item.raw.as_str());
        }
    }
    if !missing.is_empty() {
        failures.push(Failure {
            reason: "new_words",
            detail: format!(
                "the passage doesn't say {}",
                missing
                    .into_iter()
                    .map(quote)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        });
    }
    if !clause.statuses.is_empty()
        && clause
            .statuses
            .iter()
            .all(|status| sentence.statuses.contains(status))
    {
        used_sentence = true;
    }
    ClauseResult {
        failure: failures
            .into_iter()
            .min_by_key(|failure| match failure.reason {
                "new_fact" => 0,
                "changed_meaning" => 1,
                _ => 2,
            }),
        score: if total != 0.0 { matched / total } else { 1.0 },
        used_sentence,
    }
}

#[derive(Serialize)]
struct CheckedLine {
    kind: &'static str,
    text: String,
    citations: Vec<String>,
    support: Vec<String>,
}

enum SentenceResult {
    Kept(CheckedLine),
    Removed(Failure),
}

fn backing(sentence: &str, passages: &[&Passage]) -> SentenceResult {
    let claim = fold(sentence);
    if claim.is_empty() {
        return SentenceResult::Removed(Failure {
            reason: "new_words",
            detail: "says nothing".to_owned(),
        });
    }
    for passage in passages {
        if !passage.folded.contains(&claim) {
            continue;
        }
        let whole = passage
            .sentences
            .iter()
            .find(|item| item.folded.contains(&claim));
        if whole.is_some_and(|whole| {
            whole.folded != claim
                && check_clause(&analyse(sentence), whole, passage)
                    .failure
                    .is_some()
        }) {
            continue;
        }
        let original = passage.sentences.iter().find(|item| item.folded == claim);
        return SentenceResult::Kept(CheckedLine {
            kind: "quoted",
            text: original.map_or_else(|| display_text(sentence), |original| original.text.clone()),
            citations: vec![passage.id.clone()],
            support: whole.into_iter().map(|whole| whole.text.clone()).collect(),
        });
    }
    let mut citations = IndexSet::new();
    let mut support = IndexSet::new();
    for clause in split_clauses(sentence).iter().map(|text| analyse(text)) {
        let mut best: Option<(Failure, f64)> = None;
        let mut backed = false;
        for passage in passages {
            for candidate in &passage.sentences {
                let result = check_clause(&clause, candidate, passage);
                if let Some(failure) = result.failure {
                    if best.as_ref().is_none_or(|(_, score)| result.score > *score) {
                        best = Some((failure, result.score));
                    }
                } else {
                    backed = true;
                    citations.insert(passage.id.clone());
                    if result.used_sentence {
                        support.insert(candidate.text.clone());
                    }
                    break;
                }
            }
            if backed {
                break;
            }
        }
        if !backed {
            return SentenceResult::Removed(best.map_or_else(
                || Failure {
                    reason: "new_words",
                    detail: "says nothing the passage says".to_owned(),
                },
                |(failure, _)| failure,
            ));
        }
    }
    SentenceResult::Kept(CheckedLine {
        kind: "reworded",
        text: display_text(sentence),
        citations: citations.into_iter().collect(),
        support: support.into_iter().collect(),
    })
}

#[derive(Serialize)]
struct RemovedLine {
    text: String,
    reason: &'static str,
    detail: String,
    citations: Vec<String>,
}

#[derive(Default, Serialize)]
struct CheckReport {
    lines: Vec<CheckedLine>,
    removed: Vec<RemovedLine>,
}

fn entry_map(input: &Value, field: &str) -> Result<IndexMap<String, Value>, String> {
    let entries = input
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("grounding input.{field} must contain map entries"))?;
    entries
        .iter()
        .map(|entry| {
            let pair = entry
                .as_array()
                .filter(|pair| pair.len() == 2)
                .ok_or_else(|| format!("grounding input.{field} entries must be pairs"))?;
            let key = pair[0]
                .as_str()
                .ok_or_else(|| format!("grounding input.{field} keys must be strings"))?;
            Ok((key.to_owned(), pair[1].clone()))
        })
        .collect()
}

fn input_string<'a>(input: &'a Value, field: &str) -> Result<&'a str, String> {
    input
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("grounding input.{field} must be a string"))
}

fn check_answer(input: &Value) -> Result<Value, String> {
    let output = input_string(input, "output")?;
    let allowed = entry_map(input, "allowed")?;
    let evidence = entry_map(input, "evidence")?;
    let mut passages = IndexMap::new();
    for (id, text) in evidence {
        let Some(citation) = allowed.get(&id) else {
            continue;
        };
        let text = text
            .as_str()
            .ok_or_else(|| "grounding evidence values must be strings".to_owned())?;
        passages.insert(id.clone(), passage_of(&id, text, citation));
    }
    let mut report = CheckReport::default();
    for line in output.split('\n').map(trim).filter(|line| !line.is_empty()) {
        let markers: IndexSet<String> = rules()
            .markers
            .captures_iter(line)
            .map(|item| item[1].to_owned())
            .collect();
        let markers: Vec<String> = markers.into_iter().collect();
        let body = compact_spaces(&rules().markers.replace_all(line, " "));
        if body.is_empty() {
            continue;
        }
        if markers.is_empty() {
            report.removed.push(RemovedLine {
                text: body,
                reason: "no_citation",
                detail: "cites no passage".to_owned(),
                citations: Vec::new(),
            });
            continue;
        }
        if let Some(unknown) = markers.iter().find(|id| !passages.contains_key(*id)) {
            report.removed.push(RemovedLine {
                text: body,
                reason: "unknown_citation",
                detail: format!("cites {unknown}, which the writer wasn't given"),
                citations: markers,
            });
            continue;
        }
        let cited: Vec<&Passage> = markers.iter().map(|id| &passages[id]).collect();
        for sentence in sentences_of(&body) {
            match backing(&sentence, &cited) {
                SentenceResult::Kept(mut result) => {
                    result.citations = markers
                        .iter()
                        .filter(|id| result.citations.contains(*id))
                        .cloned()
                        .collect();
                    report.lines.push(result);
                }
                SentenceResult::Removed(failure) => {
                    let elsewhere: Vec<&Passage> = passages
                        .values()
                        .filter(|passage| !markers.contains(&passage.id))
                        .collect();
                    let failure = match backing(&sentence, &elsewhere) {
                        SentenceResult::Kept(result) => Failure {
                            reason: "wrong_source",
                            detail: format!(
                                "backed by {}, not the passage it cites",
                                result.citations.join(", ")
                            ),
                        },
                        SentenceResult::Removed(_) => failure,
                    };
                    report.removed.push(RemovedLine {
                        text: sentence,
                        reason: failure.reason,
                        detail: failure.detail,
                        citations: markers.clone(),
                    });
                }
            }
        }
    }
    if report.lines.is_empty() {
        return Ok(json!({ "answer": { "text": NO_RESULT, "citations": [] }, "report": report }));
    }
    let mut citations = IndexMap::new();
    for line in &report.lines {
        for id in &line.citations {
            citations.insert(id.clone(), allowed[id].clone());
        }
    }
    let text = report
        .lines
        .iter()
        .map(|line| {
            format!(
                "{} {}",
                line.text,
                line.citations
                    .iter()
                    .map(|id| format!("[{id}]"))
                    .collect::<Vec<_>>()
                    .join(" ")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let check = json!({
        "lines": report.lines.iter().map(|line| json!({ "kind": line.kind, "support": line.support })).collect::<Vec<_>>(),
        "removed": report.removed.iter().map(|line| json!({ "reason": line.reason })).collect::<Vec<_>>()
    });
    Ok(
        json!({ "answer": { "text": text, "citations": citations.into_values().collect::<Vec<_>>(), "check": check }, "report": report }),
    )
}

pub fn dispatch(operation: &str, input: Value) -> Result<Value, String> {
    match operation {
        "grounding.checkAnswer" => check_answer(&input),
        "grounding.fold" => Ok(json!(fold(input_string(&input, "text")?))),
        "grounding.stem" => Ok(json!(stem(input_string(&input, "word")?))),
        "grounding.numberValue" => Ok(json!(number_value(input_string(&input, "word")?))),
        "grounding.sameWord" => Ok(json!(same_word(
            input_string(&input, "a")?,
            input_string(&input, "b")?
        ))),
        "grounding.splitClauses" => Ok(json!(split_clauses(input_string(&input, "sentence")?))),
        _ => Err(format!("Unknown grounding operation: {operation}")),
    }
}

#[cfg(test)]
#[path = "grounding/tests.rs"]
mod tests;
