// Answer helpers for the workspace. They touch no page, so node checks them (answer.nodecheck.js).

const text = value => typeof value === "string" ? value : "";

/** One entry per cited document, numbered in the order the answer first cites it. Citations come one per passage. */
export function numberSources(citations) {
  const sources = [];
  const byDoc = new Map();
  for (const citation of Array.isArray(citations) ? citations : []) {
    if (!citation || typeof citation.docId !== "string" || typeof citation.chunkId !== "string") continue;
    let source = byDoc.get(citation.docId);
    if (!source) {
      const { chunkId: _chunkId, ...rest } = citation;
      source = { ...rest, number: sources.length + 1, chunkIds: [] };
      byDoc.set(citation.docId, source);
      sources.push(source);
    }
    if (!source.chunkIds.includes(citation.chunkId)) source.chunkIds.push(citation.chunkId);
  }
  return sources;
}

/** The answer's lines, each with the numbers of the sources its markers name. A marker naming no source stays as text. */
export function answerLines(answer, sources) {
  const numbers = new Map();
  for (const source of Array.isArray(sources) ? sources : []) for (const id of source.chunkIds) numbers.set(id, source.number);
  return text(answer).split(/\n+/).map(line => line.trim()).filter(Boolean).map(line => {
    const refs = [];
    const rest = line.replace(/\s*\[([^\]]+)\]/g, (marker, id) => {
      const number = numbers.get(id);
      if (number === undefined) return marker;
      if (!refs.includes(number)) refs.push(number);
      return "";
    }).trim();
    return { text: rest, refs };
  });
}

// Answers show a Jira issue's status inside the quoted text: after the key when the text starts with it, "DB-12
// (in progress) tracks…", and in front of it otherwise, "DB-15 (blocked): Replica…". The document has neither.
const JIRA_STATUS = /^([A-Z][A-Z0-9]+-\d+) \([^)]*\)(:?) /;
function withoutStatus(sentence) {
  const match = JIRA_STATUS.exec(sentence);
  if (!match) return undefined;
  const rest = sentence.slice(match[0].length);
  return match[2] ? rest : `${match[1]} ${rest}`;
}

// The text with each run of whitespace as one space, and where each of its characters came from.
function collapse(value) {
  let out = "";
  const at = [];
  for (let index = 0; index < value.length; index++) {
    if (/\s/.test(value[index])) {
      if (!out || out.endsWith(" ")) continue;
      out += " ";
    } else out += value[index];
    at.push(index);
  }
  return { out, at };
}

/** Where each quoted sentence sits in a document's text, as sorted [start, end) ranges with overlaps merged. */
export function quotedRanges(content, sentences) {
  const { out, at } = collapse(text(content));
  const ranges = [];
  for (const sentence of Array.isArray(sentences) ? sentences : []) {
    for (const candidate of [text(sentence), withoutStatus(text(sentence))]) {
      const needle = text(candidate).replace(/\s+/g, " ").trim();
      if (!needle) continue;
      const found = [];
      for (let start = out.indexOf(needle); start !== -1; start = out.indexOf(needle, start + needle.length)) {
        found.push([at[start], at[start + needle.length - 1] + 1]);
      }
      if (found.length) { ranges.push(...found); break; }
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

/** The demo's documents live at placeholder addresses on the reserved .example domain, which no browser can open. */
export function isDemoAddress(url) {
  try { return new URL(url).hostname.endsWith(".example"); } catch { return false; }
}
