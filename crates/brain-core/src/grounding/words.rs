use indexmap::{IndexMap, IndexSet};
use regex::Regex;
use std::{collections::HashSet, sync::OnceLock};
use unicode_normalization::UnicodeNormalization;

const FUNCTION_WORDS: &str = "a an the this that these those it its they them their there here we us our you your he him his she her i me my is are was were be been being am has have had having do does did doing will would shall should can must to of in on at by for from with as into onto about than and or but if which who whom whose what when where how why out up off via per during through while whereas although though because so then very really too";
const SAFE_WORDS: &str =
    "also still currently now yet team says say said mentions mention mentioned according";
const NEGATIONS: &str = "not no never cannot can't won't isn't aren't wasn't weren't doesn't don't didn't hasn't haven't hadn't shouldn't wouldn't couldn't mustn't without none nothing nobody neither nor unable";
const HEDGES: &str = "may might could likely possibly probably perhaps expected potentially";
const QUANTIFIERS: &str =
    "all every each none only both most many few several always entire whole any just";
const BEFORE: &str = "before prior ahead earlier";
const AFTER: &str = "after once following afterwards later until till";
const MORE: &str =
    "above over more higher greater exceeds exceed exceeding beyond longer larger bigger";
const LESS: &str = "below under less lower fewer shorter smaller within";
const TIME_WORDS: &str = "today tomorrow yesterday tonight overnight morning mornings evening night nightly daily weekly monthly week weeks weekend month months quarter quarters year years hour hours minute minutes day days monday tuesday wednesday thursday friday saturday sunday january february march april june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec q1 q2 q3 q4 am pm noon midnight";
const SYNONYMS: &[&[&str]] = &[
    &["start", "begin", "kick"],
    &["fix", "resolve", "solve"],
    &["complete", "finish", "done"],
    &["need", "require", "depend"],
    &["raise", "increase"],
    &["move", "migrate"],
    &["check", "verify", "inspect", "confirm", "validate"],
    &["freeze", "pause", "halt", "stop"],
    &["issue", "ticket"],
];
const STATUS_PATTERNS: &[(&str, &str)] = &[
    ("in progress", "in progress|underway|ongoing"),
    ("blocked", "blocked|on hold|stuck"),
    ("in review", "in review|under review"),
    ("done", "done|complete|completed|finished"),
    ("open", "open"),
    ("approved", "approved|signed off"),
    ("rejected", "rejected|declined"),
    ("draft", "draft"),
    ("final", "final"),
    ("superseded", "superseded|outdated|obsolete"),
    ("failed", "fail|fails|failed|failing"),
    ("passed", "pass|passes|passed|passing"),
];
const SPACE_PATTERN: &str = r"[\t\n\x0B\x0C\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";

pub(super) type Vocabulary = HashSet<&'static str>;
pub(super) type Statuses = IndexSet<&'static str>;

pub(super) struct Rules {
    pub(super) function: Vocabulary,
    pub(super) safe: Vocabulary,
    pub(super) negations: Vocabulary,
    pub(super) hedges: Vocabulary,
    pub(super) quantifiers: Vocabulary,
    pub(super) before: Vocabulary,
    pub(super) after: Vocabulary,
    pub(super) more: Vocabulary,
    pub(super) less: Vocabulary,
    pub(super) time: Vocabulary,
    pub(super) meaning: Vocabulary,
    pub(super) synonyms: IndexMap<String, usize>,
    pub(super) statuses: Vec<(&'static str, Regex)>,
    pub(super) token: Regex,
    pub(super) uppercase: Regex,
    pub(super) letter: Regex,
    pub(super) label: Regex,
    pub(super) clauses: Regex,
    pub(super) markers: Regex,
}

fn vocabulary(words: &'static str) -> Vocabulary {
    words.split(' ').collect()
}

pub(super) fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| {
        let join = "(?i-u:and|but|while|whereas|so|then|because|although|though)";
        Rules {
            function: vocabulary(FUNCTION_WORDS),
            safe: vocabulary(SAFE_WORDS),
            negations: vocabulary(NEGATIONS),
            hedges: vocabulary(HEDGES),
            quantifiers: vocabulary(QUANTIFIERS),
            before: vocabulary(BEFORE),
            after: vocabulary(AFTER),
            more: vocabulary(MORE),
            less: vocabulary(LESS),
            time: vocabulary(TIME_WORDS),
            meaning: [NEGATIONS, HEDGES, QUANTIFIERS, BEFORE, AFTER, MORE, LESS]
                .into_iter()
                .flat_map(|words| words.split(' '))
                .collect(),
            synonyms: SYNONYMS
                .iter()
                .enumerate()
                .flat_map(|(index, group)| group.iter().map(move |word| (stem(word), index)))
                .collect(),
            statuses: STATUS_PATTERNS
                .iter()
                .map(|(name, pattern)| {
                    (*name, Regex::new(&format!(r"(?-u:\b)(?:{pattern})(?-u:\b)")).unwrap())
                })
                .collect(),
            token: Regex::new(r"[#@]?[\p{L}\p{N}]+(?:'[\p{L}]+)?(?:[-.:/][\p{L}\p{N}]+)*%?").unwrap(),
            uppercase: Regex::new(r"^\p{Lu}").unwrap(),
            letter: Regex::new(r"\p{L}").unwrap(),
            label: Regex::new(r"(?-u:\b)([A-Z][A-Z0-9]+-[0-9]+) \(([^)]+)\)").unwrap(),
            clauses: Regex::new(&format!(
                "{SPACE_PATTERN}*[,;:]{SPACE_PATTERN}+(?:{join}{SPACE_PATTERN}+)?|{SPACE_PATTERN}+{join}{SPACE_PATTERN}+"
            )).unwrap(),
            markers: Regex::new(r"\[([^\]]+)\]").unwrap(),
        }
    })
}

fn js_space(character: char) -> bool {
    matches!(
        character,
        '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

pub(super) fn trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

pub(super) fn compact_spaces(text: &str) -> String {
    let mut output = String::new();
    let mut spaced = false;
    for character in text.chars() {
        if js_space(character) {
            if !output.is_empty() {
                spaced = true;
            }
        } else {
            if spaced {
                output.push(' ');
                spaced = false;
            }
            output.push(character);
        }
    }
    output
}

fn normalize_word_character(character: char) -> char {
    match character {
        '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
        '\u{2018}'..='\u{201B}' | '\u{2032}' => '\'',
        _ => character,
    }
}

pub fn fold(text: &str) -> String {
    let lowered = text.nfkc().collect::<String>().to_lowercase();
    compact_spaces(
        &lowered
            .chars()
            .map(|character| match character {
                '\u{201C}'..='\u{201F}' | '\u{2033}' => '"',
                _ => normalize_word_character(character),
            })
            .collect::<String>(),
    )
}

pub(super) fn display_text(text: &str) -> String {
    text.nfkc()
        .map(|character| match character {
            '\u{2010}' | '\u{2011}' => '-',
            _ => character,
        })
        .collect()
}

pub(super) fn sentences_of(text: &str) -> Vec<String> {
    let text = compact_spaces(text);
    let mut start = 0;
    let mut sentences = Vec::new();
    for (index, character) in text.char_indices() {
        if character == ' ' && index > 0 && matches!(text.as_bytes()[index - 1], b'.' | b'!' | b'?')
        {
            sentences.push(text[start..index].to_owned());
            start = index + 1;
        }
    }
    if start < text.len() {
        sentences.push(text[start..].to_owned());
    }
    sentences
}

pub fn number_value(word: &str) -> Option<String> {
    let lower = word.to_lowercase();
    let numeric = lower.strip_suffix('%').unwrap_or(&lower);
    let mut parts = numeric.split('.');
    let whole = parts.next().unwrap_or_default();
    let decimal = parts.next();
    if !whole.is_empty()
        && whole.bytes().all(|byte| byte.is_ascii_digit())
        && decimal
            .is_none_or(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        && parts.next().is_none()
    {
        let mut start = 0;
        while lower.as_bytes().get(start) == Some(&b'0')
            && lower
                .as_bytes()
                .get(start + 1)
                .is_some_and(u8::is_ascii_digit)
        {
            start += 1;
        }
        return Some(lower[start..].to_owned());
    }
    for suffix in ["st", "nd", "rd", "th"] {
        if let Some(digits) = lower.strip_suffix(suffix) {
            if !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()) {
                return Some(digits.to_owned());
            }
        }
    }
    let value = match lower.as_str() {
        "zero" => 0,
        "one" | "first" => 1,
        "two" | "second" => 2,
        "three" | "third" => 3,
        "four" | "fourth" => 4,
        "five" | "fifth" => 5,
        "six" | "sixth" => 6,
        "seven" | "seventh" => 7,
        "eight" | "eighth" => 8,
        "nine" | "ninth" => 9,
        "ten" | "tenth" => 10,
        "eleven" | "eleventh" => 11,
        "twelve" | "twelfth" => 12,
        "thirteen" => 13,
        "fourteen" => 14,
        "fifteen" => 15,
        "sixteen" => 16,
        "seventeen" => 17,
        "eighteen" => 18,
        "nineteen" => 19,
        "twenty" => 20,
        "thirty" => 30,
        "forty" => 40,
        "fifty" => 50,
        "sixty" => 60,
        "seventy" => 70,
        "eighty" => 80,
        "ninety" => 90,
        "hundred" => 100,
        "thousand" => 1000,
        _ => return None,
    };
    Some(value.to_string())
}

fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

pub fn stem(word: &str) -> String {
    let mut value = word.to_lowercase();
    if value.ends_with("'s") {
        value.truncate(value.len() - 2);
    }
    if js_len(&value) <= 3 {
        return value;
    }
    if value.ends_with("ies") && js_len(&value) > 4 {
        value.truncate(value.len() - 3);
        value.push('y');
    } else if ["ss", "us", "is"]
        .iter()
        .any(|suffix| value.ends_with(suffix))
    {
    } else if ["shes", "ches", "xes", "zes", "sses"]
        .iter()
        .any(|suffix| value.ends_with(suffix))
    {
        value.truncate(value.len() - 2);
    } else if value.ends_with('s') {
        value.pop();
    }
    if value.ends_with("ing") && js_len(&value) > 5 {
        value.truncate(value.len() - 3);
    } else if value.ends_with("ed") && js_len(&value) > 4 {
        value.truncate(value.len() - 2);
    }
    let mut ending = value.chars().rev();
    if let (Some(last), Some(previous)) = (ending.next(), ending.next()) {
        if last == previous
            && "bcdfghjklmnpqrstvwxyz".contains(last)
            && !matches!(last, 'l' | 's' | 'z')
        {
            value.pop();
        }
    }
    if value.ends_with('e') && js_len(&value) > 4 {
        value.pop();
    }
    let mut ending = value.chars().rev();
    if ending.next() == Some('y')
        && ending
            .next()
            .is_some_and(|character| !"aeiou".contains(character))
        && js_len(&value) > 4
    {
        value.pop();
        value.push('i');
    }
    value
}

pub fn same_word(a: &str, b: &str) -> bool {
    let left = stem(a);
    let right = stem(b);
    if left == right {
        return true;
    }
    let (shorter, longer) = if js_len(&left) <= js_len(&right) {
        (&left, &right)
    } else {
        (&right, &left)
    };
    if js_len(shorter) >= 5 && longer.starts_with(shorter) {
        return true;
    }
    rules()
        .synonyms
        .get(&left)
        .is_some_and(|group| rules().synonyms.get(&right) == Some(group))
}

pub fn split_clauses(sentence: &str) -> Vec<String> {
    let mut body_end = sentence.len();
    while body_end > 0 && matches!(sentence.as_bytes()[body_end - 1], b'.' | b'!' | b'?') {
        body_end -= 1;
    }
    rules()
        .clauses
        .split(&sentence[..body_end])
        .map(trim)
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect()
}

#[derive(Clone)]
pub(super) struct Word {
    pub(super) raw: String,
    pub(super) word: String,
}

pub(super) fn words_of(text: &str) -> Vec<Word> {
    let normal: String = text.nfkc().map(normalize_word_character).collect();
    rules()
        .token
        .find_iter(&normal)
        .map(|item| {
            let mut raw = item.as_str().to_owned();
            if raw.ends_with("'s") || raw.ends_with("'S") {
                raw.truncate(raw.len() - 2);
            }
            Word {
                word: raw.to_lowercase(),
                raw,
            }
        })
        .collect()
}

pub(super) fn fact_words(words: &[Word]) -> Vec<Word> {
    words
        .iter()
        .filter(|item| {
            !rules().function.contains(item.word.as_str())
                && !rules().safe.contains(item.word.as_str())
        })
        .cloned()
        .collect()
}

pub(super) fn is_name(item: &Word) -> bool {
    let rules = rules();
    !rules.function.contains(item.word.as_str())
        && !rules.safe.contains(item.word.as_str())
        && !rules.meaning.contains(item.word.as_str())
        && number_value(&item.word).is_none()
        && !rules.time.contains(item.word.as_str())
        && (rules.uppercase.is_match(&item.raw)
            || item.raw.starts_with('#')
            || (item.raw.bytes().any(|byte| byte.is_ascii_digit())
                && rules.letter.is_match(&item.raw)))
}

pub(super) fn matches(a: &Word, b: &Word) -> bool {
    match number_value(&a.word) {
        Some(number) => number_value(&b.word).as_ref() == Some(&number),
        None => a.word == b.word || same_word(&a.word, &b.word),
    }
}

pub(super) fn statuses_in(folded: &str) -> Statuses {
    rules()
        .statuses
        .iter()
        .filter(|(_, pattern)| pattern.is_match(folded))
        .map(|(name, _)| *name)
        .collect()
}

pub(super) fn without_statuses(folded: &str) -> String {
    rules()
        .statuses
        .iter()
        .fold(folded.to_owned(), |text, (_, pattern)| {
            pattern.replace_all(&text, " ").into_owned()
        })
}
