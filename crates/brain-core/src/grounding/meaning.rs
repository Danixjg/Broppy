use super::words::{is_name, number_value, rules, same_word, statuses_in, stem, Vocabulary, Word};
use std::{collections::HashSet, sync::OnceLock};

const ACTION_WORDS: &str = "assign ask rotate raise increase own start begin fix resolve solve need require depend move migrate check verify inspect confirm validate freeze pause halt stop restart collect classify submit approve reject complete finish wait keep slip read include escalate page close deploy remove create update";
const AUXILIARIES: &str =
    "am is are was were be been being has have had do does did will shall would should can must";

struct ActionRules {
    auxiliaries: Vocabulary,
    action_forms: HashSet<String>,
}

fn action_rules() -> &'static ActionRules {
    static RULES: OnceLock<ActionRules> = OnceLock::new();
    RULES.get_or_init(|| ActionRules {
        auxiliaries: AUXILIARIES.split(' ').collect(),
        action_forms: ACTION_WORDS
            .split(' ')
            .flat_map(|action| {
                let base = action.strip_suffix('e').unwrap_or(action);
                let past = action
                    .strip_suffix('y')
                    .map_or_else(|| format!("{base}ed"), |base| format!("{base}ied"));
                let plural = action
                    .strip_suffix('y')
                    .map_or_else(|| format!("{action}es"), |base| format!("{base}ies"));
                [
                    action.to_owned(),
                    format!("{action}s"),
                    plural,
                    past,
                    format!("{base}ing"),
                ]
            })
            .collect(),
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ActionTiming {
    Planned,
    Current,
    Completed,
}

impl ActionTiming {
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::Current => "current",
            Self::Completed => "completed",
        }
    }
}

pub(super) struct ActionMeaning {
    pub(super) action: Word,
    pub(super) actor: Option<String>,
    pub(super) target: Option<String>,
    pub(super) timing: ActionTiming,
    pub(super) explicit_timing: bool,
    pub(super) negated: bool,
}

pub(super) struct SentenceMeaning {
    pub(super) actions: Vec<ActionMeaning>,
    pub(super) agreement: bool,
    pub(super) names: HashSet<String>,
}

fn auxiliary_of(word: &str) -> &str {
    match word {
        "won't" => "will",
        "can't" => "can",
        _ => word.strip_suffix("n't").unwrap_or(word),
    }
}

fn pronoun(word: &str) -> Option<&'static str> {
    match word {
        "i" | "me" | "my" => Some("i"),
        "we" | "us" | "our" => Some("we"),
        "you" | "your" => Some("you"),
        "he" | "him" | "his" => Some("he"),
        "she" | "her" => Some("she"),
        "they" | "them" | "their" => Some("they"),
        "it" | "its" => Some("it"),
        _ => None,
    }
}

fn participant<'a>(item: &'a Word, names: &HashSet<String>) -> Option<&'a str> {
    pronoun(&item.word).or_else(|| names.contains(&item.word).then_some(item.word.as_str()))
}

pub(super) fn control_action(word: &str) -> bool {
    matches!(stem(word).as_str(), "assign" | "ask")
}

fn subject_connector(item: &Word) -> bool {
    let word = item.word.as_str();
    rules().function.contains(word)
        || rules().safe.contains(word)
        || rules().negations.contains(word)
        || rules().hedges.contains(word)
        || matches!(word, "agreed" | "progress")
        || !statuses_in(word).is_empty()
}

pub(super) fn meaning_of(words: &[Word], known_names: Option<&HashSet<String>>) -> SentenceMeaning {
    let mut names = known_names.cloned().unwrap_or_default();
    names.extend(
        words
            .iter()
            .filter(|item| {
                is_name(item)
                    && !action_rules().action_forms.contains(&item.word)
                    && item.word != "agreed"
            })
            .map(|item| item.word.clone()),
    );
    let action_indexes: Vec<usize> = words
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let previous = index.checked_sub(1).and_then(|at| words.get(at));
            let next = words.get(index + 1);
            let word = item.word.as_str();
            let predicate = previous.is_some_and(|previous| {
                ((participant(previous, &names).is_some()
                    && (pronoun(&previous.word).is_some()
                        || ["s", "ed", "ing"]
                            .iter()
                            .any(|suffix| word.ends_with(suffix))))
                    || action_rules()
                        .auxiliaries
                        .contains(auxiliary_of(&previous.word))
                    || rules().negations.contains(previous.word.as_str())
                    || rules().hedges.contains(previous.word.as_str())
                    || previous.word == "to")
                    && participant(item, &names).is_none()
                    && !rules().function.contains(word)
                    && !rules().safe.contains(word)
                    && !rules().meaning.contains(word)
                    && !rules().time.contains(word)
                    && number_value(word).is_none()
                    && statuses_in(word).is_empty()
                    && !["tion", "ment", "ness", "ity", "ance", "ence"]
                        .iter()
                        .any(|suffix| word.ends_with(suffix))
                    && word != "agreed"
                    && next.is_none_or(|next| {
                        !action_rules()
                            .auxiliaries
                            .contains(auxiliary_of(&next.word))
                    })
            });
            (action_rules().action_forms.contains(word) || predicate).then_some(index)
        })
        .collect();
    let mut actions: Vec<ActionMeaning> = Vec::new();
    for (at, &index) in action_indexes.iter().enumerate() {
        let action = &words[index];
        let previous_index = at
            .checked_sub(1)
            .map(|at| action_indexes[at] + 1)
            .unwrap_or(0);
        let next_index = action_indexes.get(at + 1).copied().unwrap_or(words.len());
        let before = &words[previous_index..index];
        let after = &words[index + 1..next_index];
        let auxiliaries: Vec<&str> = before
            .iter()
            .map(|item| auxiliary_of(&item.word))
            .filter(|word| action_rules().auxiliaries.contains(word))
            .collect();
        let infinitive = before.iter().any(|item| item.word == "to");
        let participle = action.word.ends_with("ed") || action.word.ends_with("en");
        let passive = participle
            && auxiliaries.iter().any(|word| {
                matches!(
                    *word,
                    "am" | "is" | "are" | "was" | "were" | "be" | "been" | "being"
                )
            });
        let subject_index = before
            .iter()
            .rposition(|item| participant(item, &names).is_some());
        let subject = subject_index.and_then(|index| {
            before[index + 1..]
                .iter()
                .all(subject_connector)
                .then(|| participant(&before[index], &names))
                .flatten()
        });
        let by = after.iter().position(|item| item.word == "by");
        let object = after
            .iter()
            .find(|item| !matches!(item.word.as_str(), "a" | "an" | "the"));
        let target = if passive {
            subject
        } else if control_action(&action.word) {
            after.iter().find_map(|item| participant(item, &names))
        } else {
            object.and_then(|item| participant(item, &names))
        };
        let previous_action = actions.last();
        let actor = if passive {
            by.and_then(|by| {
                after[by + 1..]
                    .iter()
                    .find_map(|item| participant(item, &names))
            })
        } else if infinitive
            && previous_action.is_some_and(|action| {
                action.target.is_some() && control_action(&action.action.word)
            })
        {
            previous_action.and_then(|action| action.target.as_deref())
        } else {
            subject.or_else(|| {
                before
                    .iter()
                    .all(subject_connector)
                    .then(|| previous_action.and_then(|action| action.actor.as_deref()))
                    .flatten()
            })
        };
        let timing = if auxiliaries
            .iter()
            .any(|word| matches!(*word, "will" | "shall" | "would" | "should"))
            || (infinitive && actor.is_some())
        {
            ActionTiming::Planned
        } else if auxiliaries
            .iter()
            .any(|word| matches!(*word, "was" | "were" | "had" | "did"))
            || (participle
                && (!passive
                    || auxiliaries
                        .iter()
                        .any(|word| matches!(*word, "has" | "have" | "had"))))
            || (same_word(&action.word, "complete")
                && auxiliaries
                    .iter()
                    .any(|word| matches!(*word, "is" | "are" | "has" | "have")))
        {
            ActionTiming::Completed
        } else {
            ActionTiming::Current
        };
        let explicit_timing = timing != ActionTiming::Current
            || !auxiliaries.is_empty()
            || action.word.ends_with("ing")
            || before
                .iter()
                .chain(after)
                .any(|item| matches!(item.word.as_str(), "now" | "currently"));
        actions.push(ActionMeaning {
            action: action.clone(),
            actor: actor.map(str::to_owned),
            target: target.map(str::to_owned),
            timing,
            explicit_timing,
            negated: before
                .iter()
                .any(|item| rules().negations.contains(item.word.as_str())),
        });
    }
    SentenceMeaning {
        actions,
        agreement: words.iter().any(|item| item.word == "agreed"),
        names,
    }
}
