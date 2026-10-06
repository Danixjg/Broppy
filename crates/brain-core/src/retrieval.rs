use chrono::DateTime;
use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::sync::LazyLock;

pub const SEMANTIC_MIN: f64 = 0.51;
const DIMENSIONS: usize = 1024;
type SemanticSnapshot = Vec<(String, Vec<(String, Vec<f64>)>)>;
static TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[a-z0-9]+(?:-[a-z0-9]+)*").unwrap());
static STOP: LazyLock<HashSet<&str>> = LazyLock::new(|| {
    "about after all also an and any anything are as at be been before being both but by can could describe did do does each everything explain find for from get give had has have he her here his how if in into is it its just list me more most my no not of on or our out please regarding related she should show so some something such summarise summarize tell than that the their them then there these they this those to up us was we were what when where which who whom why will with would you your ago current currently day days last latest month months now past recent recently since today week weeks yesterday".split_whitespace().collect()
});
static GENERIC: LazyLock<HashSet<&str>> = LazyLock::new(|| {
    "status update updates project projects plan plans team teams issue issues task tasks ticket tickets raised need needs note notes progress work item items page pages doc docs document documents file files channel channels thread threads new first read help info".split_whitespace().collect()
});

fn synonyms(word: &str) -> &'static [&'static str] {
    match word {
        "switch" => &["cutover", "migration"],
        "recovery" => &["failover", "rollback"],
        "outage" => &["incident", "failover"],
        "launch" => &["cutover"],
        "access" => &["permission"],
        "payment" => &["pay", "payments"],
        "blockers" => &["blocker"],
        _ => &[],
    }
}

pub fn raw_terms(text: &str) -> Vec<String> {
    TOKEN
        .find_iter(&text.to_lowercase())
        .map(|m| m.as_str().into())
        .collect()
}

pub fn terms(text: &str) -> Vec<String> {
    raw_terms(text)
        .into_iter()
        .flat_map(|word| {
            let mut forms = vec![word.clone()];
            forms.extend(synonyms(&word).iter().map(|s| s.to_string()));
            forms
        })
        .collect()
}

fn unique(words: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    words
        .into_iter()
        .filter(|word| seen.insert(word.clone()))
        .collect()
}

pub fn query_terms(text: &str) -> Vec<String> {
    unique(
        terms(text)
            .into_iter()
            .filter(|word| word.len() > 1 && !STOP.contains(word.as_str())),
    )
}

#[derive(Clone, Debug, Serialize)]
pub struct Concept {
    pub terms: Vec<String>,
    pub generic: bool,
}

pub fn query_concepts(text: &str) -> Vec<Concept> {
    let mut concepts: Vec<Concept> = Vec::new();
    for word in raw_terms(text)
        .into_iter()
        .filter(|word| word.len() > 1 && !STOP.contains(word.as_str()))
    {
        let mut forms = vec![word.clone()];
        forms.extend(synonyms(&word).iter().map(|s| s.to_string()));
        if let Some(same) = concepts
            .iter_mut()
            .find(|concept| forms.iter().any(|form| concept.terms.contains(form)))
        {
            same.terms = unique(same.terms.iter().cloned().chain(forms));
            same.generic &= GENERIC.contains(word.as_str());
        } else {
            concepts.push(Concept {
                terms: forms,
                generic: GENERIC.contains(word.as_str()),
            });
        }
    }
    concepts
}

pub fn distinctive_words(text: &str) -> Vec<String> {
    unique(raw_terms(text).into_iter().filter(|word| {
        word.len() > 1 && !STOP.contains(word.as_str()) && !GENERIC.contains(word.as_str())
    }))
}

pub fn embed(text: &str) -> IndexMap<String, f64> {
    let mut vector = IndexMap::new();
    for word in terms(text) {
        *vector.entry(word).or_insert(0.0) += 1.0;
    }
    vector
}

fn digest_serialized(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub fn sentences(text: &str) -> Vec<String> {
    let normalized = text
        .split(whitespace)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let mut result = Vec::new();
    let mut start = 0;
    for (at, c) in normalized.char_indices() {
        if c == ' ' && at > 0 && matches!(normalized.as_bytes()[at - 1], b'.' | b'!' | b'?') {
            result.push(normalized[start..at].to_string());
            start = at + 1;
        }
    }
    if start < normalized.len() {
        result.push(normalized[start..].to_string());
    }
    result
}

pub fn chunk(doc: &Value) -> Result<Value, String> {
    if doc.get("source").and_then(Value::as_str) == Some("slack") {
        if let Some(messages) = doc
            .get("slackMessages")
            .and_then(Value::as_array)
            .filter(|messages| !messages.is_empty())
        {
            let doc_id = field(doc, "docId")?;
            let mut chunks = Vec::new();
            for message in messages {
                let timestamp = field(message, "messageTs")?;
                let mut source = doc.clone();
                source
                    .as_object_mut()
                    .ok_or("Invalid document")?
                    .remove("slackMessages");
                source["content"] = json!(field(message, "text")?);
                let message_chunks = chunk(&source)?;
                for (index, item) in message_chunks
                    .as_array()
                    .ok_or("Invalid chunks")?
                    .iter()
                    .enumerate()
                {
                    let mut item = item.clone();
                    item["chunkId"] = json!(format!("{doc_id}:{timestamp}:{index}"));
                    if let Some(permalink) = message.get("permalink").and_then(Value::as_str) {
                        item["sourceUrl"] = json!(permalink);
                    }
                    chunks.push(item);
                }
            }
            return Ok(Value::Array(chunks));
        }
    }
    let content = field(doc, "content")?;
    let title = field(doc, "title")?;
    let doc_id = field(doc, "docId")?;
    let chars: Vec<_> = content.char_indices().collect();
    let mut texts = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let mut max = start;
        let mut units = 0;
        while max < chars.len() && units + chars[max].1.len_utf16() <= 900 {
            units += chars[max].1.len_utf16();
            max += 1;
        }
        let boundary = (start + 1..=max)
            .rev()
            .find(|&at| at == chars.len() || whitespace(chars[at].1));
        let end = boundary
            .map(|at| if at == chars.len() { at } else { at + 1 })
            .unwrap_or(max);
        let byte_end = chars.get(end).map_or(content.len(), |(at, _)| *at);
        texts.push(content[chars[start].0..byte_end].to_string());
        start = end;
    }
    if texts.is_empty() {
        texts.push(content.into());
    }
    Ok(Value::Array(texts.into_iter().enumerate().map(|(index, text)| {
        let mut item = json!({"chunkId": format!("{doc_id}:{index}"), "docId": doc_id, "text": text.trim_matches(whitespace), "embedding": embed(&format!("{title} {text}"))});
        if let Some(org) = doc.get("orgId") { item["orgId"] = org.clone(); }
        item
    }).collect()))
}

pub fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Missing string field: {key}"))
}

pub fn valid_vector(vector: &[f64]) -> bool {
    let norm: f64 = vector.iter().map(|v| v * v).sum();
    vector.len() == DIMENSIONS
        && vector.iter().all(|v| v.is_finite())
        && norm.is_finite()
        && norm > 0.0
}

fn sparse_cosine(a: &IndexMap<String, f64>, b: &IndexMap<String, f64>) -> f64 {
    let a_norm: f64 = a.values().map(|v| v * v).sum();
    let b_norm: f64 = b.values().map(|v| v * v).sum();
    let dot: f64 = a.iter().map(|(k, v)| v * b.get(k).unwrap_or(&0.0)).sum();
    if a_norm > 0.0 && b_norm > 0.0 {
        dot / (a_norm * b_norm).sqrt()
    } else {
        0.0
    }
}

fn semantic_cosine(a: &[f64], b: &[f64]) -> f64 {
    let dot: f64 = a.iter().zip(b).map(|(a, b)| a * b).sum();
    let a_norm: f64 = a.iter().map(|v| v * v).sum();
    let b_norm: f64 = b.iter().map(|v| v * v).sum();
    let score = dot / (a_norm * b_norm).sqrt();
    if score.is_finite() {
        score.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Chunk {
    chunk_id: String,
    embedding: IndexMap<String, f64>,
}

impl Chunk {
    fn valid_sparse_vector(&self) -> bool {
        self.embedding
            .values()
            .all(|value| value.is_finite() && *value >= 0.0)
            && self
                .embedding
                .values()
                .map(|value| value * value)
                .sum::<f64>()
                .is_finite()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchCandidate {
    doc_id: String,
    chunk_id: String,
    score: f64,
    coverage: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    semantic: Option<f64>,
}

struct StoredDocument {
    value: Value,
    chunks: Vec<Chunk>,
    generation: u64,
}

#[derive(Default)]
pub struct Index {
    documents: IndexMap<String, StoredDocument>,
    vectors: IndexMap<String, IndexMap<String, Vec<f64>>>,
    generation: u64,
    refreshes: u64,
}

impl Index {
    pub fn execute(&mut self, operation: &str, input: Value) -> Result<Value, String> {
        match operation {
            "upsert" => self.upsert(
                input["doc"].clone(),
                field(&input, "now")?,
                &input["serialized"],
            ),
            "restore" => {
                let docs = input.as_array().ok_or("Expected documents")?;
                let mut restored = IndexMap::new();
                for value in docs {
                    let id = field(value, "docId")?.to_string();
                    let chunks: Vec<Chunk> = serde_json::from_value(value["chunks"].clone())
                        .map_err(|e| format!("Invalid chunks: {e}"))?;
                    if chunks.iter().any(|chunk| !chunk.valid_sparse_vector()) {
                        return Err("Invalid stored sparse vector".into());
                    }
                    self.generation += 1;
                    restored.insert(
                        id,
                        StoredDocument {
                            value: value.clone(),
                            chunks,
                            generation: self.generation,
                        },
                    );
                }
                self.documents = restored;
                self.vectors.clear();
                Ok(Value::Null)
            }
            "get" => Ok(self
                .documents
                .get(input.as_str().ok_or("Expected document ID")?)
                .map(|doc| doc.value.clone())
                .unwrap_or(Value::Null)),
            "values" => Ok(Value::Array(
                self.documents
                    .values()
                    .map(|doc| doc.value.clone())
                    .collect(),
            )),
            "size" => Ok(json!(self.documents.len())),
            "embeddingRefreshes" => Ok(json!(self.refreshes)),
            "generation" => Ok(self
                .documents
                .get(input.as_str().ok_or("Expected document ID")?)
                .filter(|doc| doc.value.get("deletedAt").is_none())
                .map(|doc| json!(doc.generation))
                .unwrap_or(Value::Null)),
            "remove" => {
                let id = input.as_str().ok_or("Expected document ID")?;
                self.vectors.shift_remove(id);
                Ok(json!(self.documents.shift_remove(id).is_some()))
            }
            "tombstone" => {
                let id = field(&input, "docId")?;
                let Some(doc) = self
                    .documents
                    .get_mut(id)
                    .filter(|doc| doc.value.get("deletedAt").is_none())
                else {
                    return Ok(json!(false));
                };
                doc.value["deletedAt"] = input["now"].clone();
                doc.value["chunks"] = json!([]);
                doc.chunks.clear();
                self.vectors.shift_remove(id);
                Ok(json!(true))
            }
            "semanticCount" => Ok(json!(self
                .vectors
                .get(input.as_str().ok_or("Expected document ID")?)
                .map_or(0, IndexMap::len))),
            "semanticVectorsFor" => Ok(json!(self
                .vectors
                .get(input.as_str().ok_or("Expected document ID")?)
                .map(|vectors| vectors.iter().collect::<Vec<_>>())
                .unwrap_or_default())),
            "semanticSnapshot" => Ok(json!(self
                .vectors
                .iter()
                .map(|(id, vectors)| (id, vectors.iter().collect::<Vec<_>>()))
                .collect::<Vec<_>>())),
            "restoreSemantic" => {
                let snapshot: SemanticSnapshot =
                    serde_json::from_value(input).map_err(|e| e.to_string())?;
                for (id, values) in snapshot {
                    if let Some(doc) = self
                        .documents
                        .get(&id)
                        .filter(|doc| doc.value.get("deletedAt").is_none())
                    {
                        if values.iter().any(|(id, v)| {
                            !doc.chunks.iter().any(|c| &c.chunk_id == id) || !valid_vector(v)
                        }) {
                            return Err("Invalid stored vectors".into());
                        }
                        let vectors: IndexMap<_, _> = values.into_iter().collect();
                        self.vectors.insert(id, vectors);
                    }
                }
                Ok(Value::Null)
            }
            "setSemantic" => {
                let id = field(&input, "docId")?;
                let Some(doc) = self.documents.get(id).filter(|doc| {
                    doc.value.get("deletedAt").is_none()
                        && Some(doc.generation) == input["generation"].as_u64()
                }) else {
                    return Ok(json!(false));
                };
                let values: Vec<(String, Vec<f64>)> =
                    serde_json::from_value(input["vectors"].clone()).map_err(|e| e.to_string())?;
                let ids: HashSet<_> = values.iter().map(|(id, _)| id).collect();
                if ids.len() != doc.chunks.len()
                    || values.len() != doc.chunks.len()
                    || values.iter().any(|(id, v)| {
                        !valid_vector(v) || !doc.chunks.iter().any(|c| &c.chunk_id == id)
                    })
                {
                    return Ok(json!(false));
                }
                self.vectors.insert(id.into(), values.into_iter().collect());
                Ok(json!(true))
            }
            "search" => self.search(&input),
            _ => Err(format!("Unknown index operation: {operation}")),
        }
    }

    fn upsert(&mut self, source: Value, now: &str, serialized: &Value) -> Result<Value, String> {
        let id = field(&source, "docId")?.to_string();
        let content_hash = digest_serialized(field(serialized, "content")?);
        let permission_hash = digest_serialized(field(serialized, "permission")?);
        let metadata_hash = digest_serialized(field(serialized, "metadata")?);
        let previous = self.documents.get(&id);
        let content_changed = previous.is_none_or(|previous| {
            previous.value.get("deletedAt").is_some()
                || previous.value["contentHash"] != content_hash
                || previous.value["title"] != source["title"]
        });
        let permission_changed =
            previous.is_none_or(|previous| previous.value["permissionHash"] != permission_hash);
        let chunks = if content_changed {
            chunk(&source)?
        } else {
            previous.unwrap().value["chunks"].clone()
        };
        let indexed_at = if content_changed {
            json!(now)
        } else {
            previous.unwrap().value["lastIndexedAt"].clone()
        };
        let permission_at = if permission_changed {
            json!(now)
        } else {
            previous.unwrap().value["lastPermissionSyncAt"].clone()
        };
        let generation = if content_changed {
            self.generation += 1;
            self.generation
        } else {
            previous.unwrap().generation
        };
        if content_changed {
            self.refreshes += 1;
            self.vectors.shift_remove(&id);
        }
        let typed =
            serde_json::from_value(chunks.clone()).map_err(|e| format!("Invalid chunks: {e}"))?;
        let mut value = source;
        let object = value.as_object_mut().ok_or("Expected document")?;
        object.remove("deletedAt");
        object.insert("chunks".into(), chunks);
        object.insert("contentHash".into(), json!(content_hash));
        object.insert("permissionHash".into(), json!(permission_hash));
        object.insert("metadataHash".into(), json!(metadata_hash));
        object.insert("lastIndexedAt".into(), indexed_at);
        object.insert("lastPermissionSyncAt".into(), permission_at);
        self.documents.insert(
            id,
            StoredDocument {
                value,
                chunks: typed,
                generation,
            },
        );
        Ok(json!({"contentChanged": content_changed, "permissionChanged": permission_changed}))
    }

    pub fn search(&self, input: &Value) -> Result<Value, String> {
        let concepts = query_concepts(field(input, "query")?);
        let topic = concepts.iter().any(|concept| !concept.generic);
        let weight = |concept: &Concept| if concept.generic { 0.25 } else { 1.0 };
        let total: f64 = concepts.iter().map(weight).sum();
        let mut sparse: IndexMap<String, f64> = IndexMap::new();
        for concept in &concepts {
            for term in &concept.terms {
                let v = sparse.entry(term.clone()).or_insert(0.0);
                *v = v.max(weight(concept));
            }
        }
        let vector = serde_json::from_value::<Vec<f64>>(input["vector"].clone())
            .ok()
            .filter(|v| valid_vector(v));
        let now = input["now"].as_f64().ok_or("Expected current time")?;
        let mut results = Vec::new();
        for (id, doc) in &self.documents {
            if doc.value.get("deletedAt").is_some() {
                continue;
            }
            for chunk in &doc.chunks {
                let matched: Vec<_> = concepts
                    .iter()
                    .filter(|concept| {
                        concept.terms.iter().any(|term| {
                            chunk.embedding.contains_key(term)
                                || (term.contains('-')
                                    && term
                                        .split('-')
                                        .all(|part| chunk.embedding.contains_key(part)))
                        })
                    })
                    .collect();
                let keyword = if total > 0.0 {
                    matched.iter().map(|c| weight(c)).sum::<f64>() / total
                } else {
                    0.0
                };
                let semantic = vector.as_ref().and_then(|v| {
                    self.vectors
                        .get(id)?
                        .get(&chunk.chunk_id)
                        .map(|b| semantic_cosine(v, b))
                });
                if !matched.iter().any(|c| !topic || !c.generic)
                    && semantic.is_none_or(|s| s < SEMANTIC_MIN)
                {
                    continue;
                }
                let similarity =
                    semantic.unwrap_or_else(|| sparse_cosine(&sparse, &chunk.embedding));
                let updated = DateTime::parse_from_rfc3339(field(&doc.value, "updatedAt")?)
                    .map(|d| d.timestamp_millis() as f64)
                    .unwrap_or(now);
                let age = ((now - updated) / 86_400_000.0).max(0.0);
                let score = 0.65 * similarity + 0.25 * keyword + 0.10 / (1.0 + age / 30.0);
                if !score.is_finite() {
                    return Err("Invalid retrieval score".into());
                }
                results.push(SearchCandidate {
                    doc_id: id.clone(),
                    chunk_id: chunk.chunk_id.clone(),
                    score,
                    coverage: matched.iter().filter(|c| !c.generic).count(),
                    semantic,
                });
            }
        }
        results.sort_by(|a, b| b.score.total_cmp(&a.score));
        results.truncate(input["limit"].as_u64().unwrap_or(20) as usize);
        serde_json::to_value(results).map_err(|error| error.to_string())
    }
}

pub fn dispatch(operation: &str, input: Value) -> Result<Value, String> {
    let text = || field(&input, "text");
    match operation {
        "retrieval.hash" => Ok(json!(digest_serialized(field(&input, "serialized")?))),
        "retrieval.terms" => Ok(json!(terms(text()?))),
        "retrieval.queryTerms" => Ok(json!(query_terms(text()?))),
        "retrieval.queryConcepts" => Ok(json!(query_concepts(text()?))),
        "retrieval.distinctiveWords" => Ok(json!(distinctive_words(text()?))),
        "retrieval.embed" => Ok(json!(embed(text()?))),
        "retrieval.chunk" => chunk(&input),
        "retrieval.validVector" => Ok(json!(
            serde_json::from_value::<Vec<f64>>(input).is_ok_and(|v| valid_vector(&v))
        )),
        "retrieval.generate" => {
            let question = field(&input, "question")?;
            let topics: HashSet<_> = query_terms(question).into_iter().collect();
            let prerequisite = Regex::new(r"(?i)\b(need|needs|required|require|requires|before|prerequisite|depend|depends)\b").unwrap().is_match(question);
            let required =
                Regex::new(r"(?i)\b(before|requires?|complete|must|depends?|prerequisite)\b")
                    .unwrap();
            let context = input["context"].as_array().ok_or("Expected context")?;
            let mut lines = Vec::new();
            if let Some(first) = context.first() {
                let citation = field(first, "citation")?;
                lines.extend(
                    sentences(field(first, "text")?)
                        .into_iter()
                        .take(6)
                        .map(|sentence| format!("{sentence} [{citation}]")),
                );
            }
            for item in context.iter().skip(1).take(3) {
                let mut choices = sentences(field(item, "text")?);
                let score = |text: &str| {
                    unique(terms(text))
                        .iter()
                        .filter(|word| topics.contains(*word))
                        .count()
                        + if prerequisite && required.is_match(text) {
                            3
                        } else {
                            0
                        }
                };
                choices.sort_by_key(|text| std::cmp::Reverse(score(text)));
                if let Some(best) = choices.first() {
                    lines.push(format!("{best} [{}]", field(item, "citation")?));
                }
            }
            Ok(json!(lines.join("\n")))
        }
        _ => Err(format!("Unknown retrieval operation: {operation}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concepts_preserve_distinctive_topics_and_stable_synonyms() {
        let concepts = query_concepts("What is the payment status and payments blocker?");
        assert_eq!(concepts[0].terms, ["payment", "pay", "payments"]);
        assert!(!concepts[0].generic);
        assert!(concepts[1].generic);
        assert_eq!(
            distinctive_words("what is the runner pool status?"),
            ["runner", "pool"]
        );
    }

    #[test]
    fn restore_rejects_sparse_weights_with_an_overflowing_norm() {
        let mut index = Index::default();
        let invalid = json!([{ "docId": "bad", "chunks": [{ "chunkId": "bad:0",
            "embedding": {"payment": 1e308, "cutover": 1e308} }] }]);
        assert_eq!(
            index.execute("restore", invalid),
            Err("Invalid stored sparse vector".into())
        );
        assert_eq!(index.execute("size", Value::Null).unwrap(), json!(0));
    }

    #[test]
    fn generation_rejects_embedding_completion_after_remove_and_reinsert() {
        let mut index = Index::default();
        let doc = json!({"docId":"doc","content":"payment procedure","title":"doc","permissions":{},"metadata":{},"url":"x","version":1,"updatedAt":"2026-10-01T00:00:00Z"});
        let serialized =
            json!({"content":doc["content"].to_string(),"permission":"{}","metadata":"{}"});
        index
            .execute(
                "upsert",
                json!({"doc":doc,"now":"2026-10-01T00:00:00Z","serialized":serialized}),
            )
            .unwrap();
        let generation = index.execute("generation", json!("doc")).unwrap();
        index.execute("remove", json!("doc")).unwrap();
        index
            .execute(
                "upsert",
                json!({"doc":doc,"now":"2026-10-01T00:00:00Z","serialized":serialized}),
            )
            .unwrap();
        let mut vector = vec![0.0; DIMENSIONS];
        vector[0] = 1.0;
        assert_eq!(
            index
                .execute(
                    "setSemantic",
                    json!({"docId":"doc","generation":generation,"vectors":[["doc:0",vector]]})
                )
                .unwrap(),
            json!(false)
        );
    }
}
