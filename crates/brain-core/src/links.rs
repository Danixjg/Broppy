use regex::Regex;
use serde_json::{json, Value};
use std::{collections::BTreeSet, sync::LazyLock};
use url::Url;

static ISSUE_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Z][A-Z0-9]{1,9}-[0-9]+").unwrap());
static LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"https?://[^\u{0009}-\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}<>|"'`)\]]+"#).unwrap()
});
static KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z][A-Z0-9]{1,9}-[0-9]+$").unwrap());
static ISSUE_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/browse/([^/]+)/?$").unwrap());
static PAGE_PATH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"/pages/([0-9]+)(?:/|$)").unwrap());
static CHANNEL_PATH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"/archives/([CGD][A-Z0-9]+)(?:/|$)").unwrap());
static CLIENT_PATH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^/client/[A-Z0-9]+/([CGD][A-Z0-9]+)(?:/|$)").unwrap());
static FILE_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"/(?:file|document|spreadsheets|presentation)/d/([A-Za-z0-9_-]+)(?:/|$)").unwrap()
});

fn capture(regex: &Regex, text: &str) -> Option<String> {
    regex
        .captures(text)
        .and_then(|captures| captures.get(1))
        .map(|capture| capture.as_str().to_owned())
}

fn query(url: &Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find(|(candidate, _)| candidate == key)
        .map(|(_, value)| value.into_owned())
}

fn trusted(url: &Url, source: &str, origins: &Value) -> bool {
    let origin = url.origin().ascii_serialization();
    origins
        .get(source)
        .and_then(Value::as_array)
        .is_some_and(|values| {
            values.iter().any(|value| {
                value
                    .as_str()
                    .and_then(|value| Url::parse(value).ok())
                    .is_some_and(|allowed| {
                        allowed.scheme() == "https"
                            && allowed.username().is_empty()
                            && allowed.password().is_none()
                            && allowed.origin().ascii_serialization() == origin
                    })
            })
        })
}

fn from_url(value: &str, origins: &Value) -> Option<String> {
    let url = Url::parse(value).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let path = url.path();
    if let Some(issue) = capture(&ISSUE_PATH, path)
        .filter(|issue| KEY.is_match(issue) && trusted(&url, "jira", origins))
    {
        return Some(format!("jira:{issue}"));
    }
    if let Some(page) = query(&url, "pageId")
        .or_else(|| capture(&PAGE_PATH, path))
        .filter(|page| {
            !page.is_empty()
                && page.bytes().all(|byte| byte.is_ascii_digit())
                && trusted(&url, "confluence", origins)
        })
    {
        return Some(format!("confluence:{page}"));
    }
    if let Some(channel) = capture(&CHANNEL_PATH, path).or_else(|| capture(&CLIENT_PATH, path)) {
        if trusted(&url, "slack", origins) {
            return Some(format!("slack:{channel}"));
        }
        return None;
    }
    if !matches!(
        url.origin().ascii_serialization().as_str(),
        "https://docs.google.com" | "https://drive.google.com"
    ) {
        return None;
    }
    let file = capture(&FILE_PATH, path).or_else(|| {
        if path == "/open" {
            query(&url, "id")
        } else {
            None
        }
    });
    file.filter(|file| {
        !file.is_empty()
            && file
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    })
    .map(|file| format!("drive:{file}"))
}

fn is_key_boundary(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '-'
}

fn links_in(text: &str, origins: &Value) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for link in LINK.find_iter(text) {
        let value = link
            .as_str()
            .trim_end_matches(['.', ',', ';', ':', '!', '?']);
        if let Some(target) = from_url(value, origins) {
            found.insert(target);
        }
    }
    let key_text = LINK.replace_all(text, " ");
    for key in ISSUE_KEY.find_iter(&key_text) {
        let before = key_text[..key.start()].chars().next_back();
        let after = key_text[key.end()..].chars().next();
        if !before.is_some_and(is_key_boundary) && !after.is_some_and(is_key_boundary) {
            found.insert(format!("jira:{}", key.as_str()));
        }
    }
    found
}

fn sorted_links(links: BTreeSet<String>) -> Vec<String> {
    let mut links: Vec<_> = links.into_iter().collect();
    links.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    links
}

fn string_field<'a>(input: &'a Value, name: &str) -> Result<&'a str, String> {
    input
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Invalid {name}"))
}

pub fn dispatch(operation: &str, input: Value) -> Result<Value, String> {
    match operation {
        "links.fromUrl" => Ok(json!(from_url(
            string_field(&input, "value")?,
            &input["origins"]
        ))),
        "links.in" => Ok(json!(links_in(
            string_field(&input, "text")?,
            &input["origins"]
        ))),
        "links.withLinks" => {
            let mut doc = input
                .get("doc")
                .and_then(Value::as_object)
                .cloned()
                .ok_or_else(|| "Invalid doc".to_string())?;
            let defaults = doc
                .get("url")
                .and_then(Value::as_str)
                .and_then(|url| Url::parse(url).ok())
                .filter(|url| {
                    url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
                })
                .zip(doc.get("source").and_then(Value::as_str))
                .map(|(url, source)| json!({source: [url.origin().ascii_serialization()]}))
                .unwrap_or(json!({}));
            let origins = input
                .get("origins")
                .filter(|value| !value.is_null())
                .unwrap_or(&defaults);
            let mut links = links_in(
                doc.get("content")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Invalid content".to_string())?,
                origins,
            );
            if let Some(declared) = doc.get("links").filter(|value| !value.is_null()) {
                let declared: Vec<String> = serde_json::from_value(declared.clone())
                    .map_err(|error| format!("Invalid links: {error}"))?;
                links.extend(declared);
            }
            let doc_id = doc
                .get("docId")
                .and_then(Value::as_str)
                .ok_or_else(|| "Invalid docId".to_string())?;
            links.remove(doc_id);
            doc.insert("links".to_string(), json!(sorted_links(links)));
            Ok(Value::Object(doc))
        }
        _ => Err(format!("Unknown links operation: {operation}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origins() -> Value {
        json!({"jira":["https://jira.example","https://j.example"],"confluence":["https://wiki.example"],"slack":["https://slack.example","https://s.example"]})
    }

    #[test]
    fn source_paths_identify_all_platforms() {
        for (url, target) in [
            ("https://jira.example/browse/SEC-44/", "jira:SEC-44"),
            ("https://wiki.example/pages/12345/Plan", "confluence:12345"),
            (
                "https://wiki.example/viewpage.action?pageId=678",
                "confluence:678",
            ),
            (
                "https://slack.example/archives/C0123ABC/p1",
                "slack:C0123ABC",
            ),
            (
                "https://slack.example/client/T0001/C0456DEF",
                "slack:C0456DEF",
            ),
            (
                "https://docs.google.com/document/d/1Ab_Gh/edit",
                "drive:1Ab_Gh",
            ),
            ("https://drive.google.com/open?id=abc%5F9", "drive:abc_9"),
        ] {
            assert_eq!(from_url(url, &origins()).as_deref(), Some(target), "{url}");
        }
        assert_eq!(from_url("not a url", &origins()), None);
        assert_eq!(
            from_url("https://wiki.example/pages/123?pageId=", &origins()),
            None
        );
        assert_eq!(
            from_url("https://wiki.example/pages/123?pageId=no", &origins()),
            None
        );
    }

    #[test]
    fn text_keys_keep_the_original_ascii_boundaries() {
        let found = links_in(
            "AA-1 AA-1A X-2 AA-3-44 xAA-4 _AA-5 éAA-6 ABCDEFGHIJK-7",
            &origins(),
        );
        assert_eq!(
            found,
            BTreeSet::from(["jira:AA-1".into(), "jira:AA-5".into(), "jira:AA-6".into()])
        );
    }

    #[test]
    fn slack_markup_and_trailing_punctuation_produce_sorted_unique_links() {
        assert_eq!(dispatch("links.in", json!({ "text": "<https://s.example/archives/C0123ABC/p1|thread> DB-12 https://j.example/browse/DB-12.!", "origins": origins() })).unwrap(),
            json!(["jira:DB-12", "slack:C0123ABC"]));
    }

    #[test]
    fn document_links_exclude_self_and_preserve_unknown_fields() {
        let doc = json!({ "docId": "jira:DB-12", "content": "DB-12 waits on DB-15.", "links": ["slack:db", "jira:DB-15"], "additional": { "large": 9007199254740991_u64 } });
        let linked = dispatch("links.withLinks", json!({ "doc": doc })).unwrap();
        assert_eq!(linked["links"], json!(["jira:DB-15", "slack:db"]));
        assert_eq!(linked["additional"], doc["additional"]);
    }

    #[test]
    fn whitespace_and_declared_link_order_match_javascript() {
        assert_eq!(
            dispatch(
                "links.in",
                json!({ "text": "https://drive.google.com/open?id=x\u{0085}suffix" })
            )
            .unwrap(),
            json!([])
        );
        assert_eq!(
            dispatch(
                "links.in",
                json!({ "text": "https://drive.google.com/open?id=x\u{feff}suffix" })
            )
            .unwrap(),
            json!(["drive:x"])
        );
        let linked = dispatch("links.withLinks", json!({ "doc": { "docId": "x", "content": "", "links": ["drive:\u{e000}", "drive:\u{10000}"] } })).unwrap();
        assert_eq!(
            linked["links"],
            json!(["drive:\u{10000}", "drive:\u{e000}"])
        );
    }
}
