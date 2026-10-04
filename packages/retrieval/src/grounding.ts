// The answer checker. Each line a writer returns must say only what a passage it cites says.
// - A sentence copied word for word from a cited passage is kept as it is ("quoted").
// - A reworded sentence is kept ("reworded") only when each of its clauses is backed by one sentence of a passage it
//   cites: the same numbers (next to the same words), names, keys, dates and quantities, the same status, order,
//   comparison, negation and hedging, and no other word that carries meaning.
// - Anything else is left out, with the reason. Only the reason reaches the asker (D63); the text goes to the audit.
import type { AnswerCheck, Citation, QueryAnswer, RemovalReason } from "@brain/types";

export const NO_RESULT = "No accessible information was found for this query.";

// A model may copy a sentence with lookalike characters: a non-breaking hyphen, curly quotes or special spaces. Both
// sides are folded before they are compared, so those don't drop a faithful copy; the words must still match.
export function fold(text: string): string {
  return text.normalize("NFKC").toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

const sentencesOf = (text: string) => text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).filter(Boolean);

/** The source's own sentence, when the claim copies one whole, so the answer shows the source's characters. */
function sourceSentence(evidence: string | undefined, claim: string): string | undefined {
  return evidence === undefined ? undefined : sentencesOf(evidence).find(sentence => fold(sentence) === claim);
}

// ----- Words -----

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  thousand: 1000, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
  tenth: 10, eleventh: 11, twelfth: 12
};

/** A number written as digits, a word or an ordinal, as digits; undefined for any other word. */
export function numberValue(word: string): string | undefined {
  const lower = word.toLowerCase();
  if (/^\d+(\.\d+)?%?$/.test(lower)) return lower.replace(/^0+(?=\d)/, "");
  const ordinal = /^(\d+)(st|nd|rd|th)$/.exec(lower);
  if (ordinal) return ordinal[1];
  return Object.hasOwn(NUMBER_WORDS, lower) ? String(NUMBER_WORDS[lower]) : undefined;
}

const set = (words: string) => new Set(words.split(" "));
// Words that carry no fact of their own.
const FUNCTION_WORDS = set("a an the this that these those it its they them their there here we us our you your he " +
  "him his she her i me my is are was were be been being am has have had having do does did doing will would shall " +
  "should can must to of in on at by for from with as into onto about than and or but if which who whom whose what " +
  "when where how why out up off via per during through while whereas although though because so then very really " +
  "too");
// Words a reworded line may add without adding a fact: who said it, and that it still holds.
const SAFE_WORDS = set("also still currently now yet team says say said mentions mention mentioned according");
const NEGATIONS = set("not no never cannot can't won't isn't aren't wasn't weren't doesn't don't didn't hasn't " +
  "haven't hadn't shouldn't wouldn't couldn't mustn't without none nothing nobody neither nor unable");
const HEDGES = set("may might could likely possibly probably perhaps expected potentially");
const QUANTIFIERS = set("all every each none only both most many few several always entire whole any just");
const BEFORE = set("before prior ahead earlier");
const AFTER = set("after once following afterwards later until till");
const MORE = set("above over more higher greater exceeds exceed exceeding beyond longer larger bigger");
const LESS = set("below under less lower fewer shorter smaller within");
const TIME_WORDS = set("today tomorrow yesterday tonight overnight morning mornings evening night nightly daily " +
  "weekly monthly week weeks weekend month months quarter quarters year years hour hours minute minutes day days " +
  "monday tuesday wednesday thursday friday saturday sunday january february march april june july august " +
  "september october november december jan feb mar apr jun jul aug sep sept oct nov dec q1 q2 q3 q4 am pm noon " +
  "midnight");
const MEANING_WORDS = new Set([...NEGATIONS, ...HEDGES, ...QUANTIFIERS, ...BEFORE, ...AFTER, ...MORE, ...LESS]);

// Status words: a reworded line may only state a status its source sentence states, in any of its forms.
const STATUSES: Array<[string, RegExp]> = [
  ["in progress", /\b(?:in progress|underway|ongoing)\b/g],
  ["blocked", /\b(?:blocked|on hold|stuck)\b/g],
  ["in review", /\b(?:in review|under review)\b/g],
  ["done", /\b(?:done|complete|completed|finished)\b/g],
  ["open", /\bopen\b/g],
  ["approved", /\b(?:approved|signed off)\b/g],
  ["rejected", /\b(?:rejected|declined)\b/g],
  ["draft", /\bdraft\b/g],
  ["final", /\bfinal\b/g],
  ["superseded", /\b(?:superseded|outdated|obsolete)\b/g],
  ["failed", /\b(?:fail|fails|failed|failing)\b/g],
  ["passed", /\b(?:pass|passes|passed|passing)\b/g]
];
const statusesIn = (folded: string) => new Set(STATUSES.filter(([, pattern]) => folded.search(pattern) >= 0).map(([name]) => name));
const withoutStatuses = (folded: string) => STATUSES.reduce((text, [, pattern]) => text.replace(pattern, " "), folded);

// Close synonyms count as the same word. Kept short on purpose: each pair is one a test shows is safe.
const SYNONYMS = [
  ["start", "begin", "kick"],
  ["fix", "resolve", "solve"],
  ["complete", "finish", "done"],
  ["need", "require", "depend"],
  ["raise", "increase"],
  ["move", "migrate"],
  ["check", "verify", "inspect", "confirm", "validate"],
  ["freeze", "pause", "halt", "stop"],
  ["issue", "ticket"]
];

/** A word's stem, by removing plural and tense endings, so "raises", "raised" and "raising" compare equal. */
export function stem(word: string): string {
  let value = word.toLowerCase().replace(/'s$/, "");
  if (value.length <= 3) return value;
  if (value.endsWith("ies") && value.length > 4) value = `${value.slice(0, -3)}y`;
  else if (/(?:ss|us|is)$/.test(value)) { /* class, status, analysis */ }
  else if (/(?:sh|ch|x|z|ss)es$/.test(value)) value = value.slice(0, -2);
  else if (value.endsWith("s")) value = value.slice(0, -1);
  if (value.endsWith("ing") && value.length > 5) value = value.slice(0, -3);
  else if (value.endsWith("ed") && value.length > 4) value = value.slice(0, -2);
  if (/([b-df-hj-np-tv-z])\1$/.test(value) && !/(?:ll|ss|zz)$/.test(value)) value = value.slice(0, -1);
  if (value.endsWith("e") && value.length > 4) value = value.slice(0, -1);
  if (/[^aeiou]y$/.test(value) && value.length > 4) value = `${value.slice(0, -1)}i`;
  return value;
}

const synonymGroup = new Map(SYNONYMS.flatMap((group, index) => group.map(word => [stem(word), index] as const)));

/** The same word in another form, or a close synonym: "raises" and "raise", "begins" and "starts". */
export function sameWord(a: string, b: string): boolean {
  const left = stem(a);
  const right = stem(b);
  if (left === right) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (shorter.length >= 5 && longer.startsWith(shorter)) return true;
  const group = synonymGroup.get(left);
  return group !== undefined && group === synonymGroup.get(right);
}

const CLAUSE_BREAK = /\s*[,;:]\s+(?:(?:and|but|while|whereas|so|then|because|although|though)\s+)?|\s+(?:and|but|while|whereas|so|then|because|although|though)\s+/i;

/** A sentence's clauses: split at commas, semicolons and joining words, so each can be checked against one sentence. */
export function splitClauses(sentence: string): string[] {
  return sentence.replace(/[.!?]+$/, "").split(CLAUSE_BREAK).map(part => part.trim()).filter(Boolean);
}

interface Word { raw: string; word: string }
const TOKEN = /[#@]?[\p{L}\p{N}]+(?:'[\p{L}]+)?(?:[-.:/][\p{L}\p{N}]+)*%?/gu;

function wordsOf(text: string): Word[] {
  const normal = text.normalize("NFKC").replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'").replace(/[\u2010-\u2015\u2212]/g, "-");
  return [...normal.matchAll(TOKEN)].map(match => {
    const raw = match[0].replace(/'s$/i, "");
    return { raw, word: raw.toLowerCase() };
  });
}

/** Names, issue keys, channels and versions: capitalized words, words with digits and letters, and #channels. */
const isName = (item: Word) => !FUNCTION_WORDS.has(item.word) && !SAFE_WORDS.has(item.word) && !MEANING_WORDS.has(item.word) &&
  numberValue(item.word) === undefined && !TIME_WORDS.has(item.word) &&
  (/^\p{Lu}/u.test(item.raw) || item.raw.startsWith("#") || (/\d/.test(item.raw) && /\p{L}/u.test(item.raw)));

/** The words that carry facts, in order: everything but function and safe words. Numbers are compared with their neighbours. */
const factWords = (words: Word[]) => words.filter(item => !FUNCTION_WORDS.has(item.word) && !SAFE_WORDS.has(item.word));

const matches = (a: Word, b: Word) => {
  const number = numberValue(a.word);
  return number !== undefined ? number === numberValue(b.word) : a.word === b.word || sameWord(a.word, b.word);
};

// ----- Passages -----

interface Sentence { text: string; folded: string; words: Word[]; facts: Word[]; statuses: Set<string> }
interface Passage {
  id: string;
  sentences: Sentence[];
  folded: string;
  /** The words of the passage's title and platform, which may name what the passage is about. */
  extras: Word[];
  /** A Jira issue's status as the brain writes it into the text: "DB-12 (in progress) …". */
  labels: Map<string, Set<string>>;
}

function passageOf(id: string, text: string, citation: Citation | undefined): Passage {
  const sentences = sentencesOf(text).map(sentence => {
    const words = wordsOf(sentence);
    return { text: sentence, folded: fold(sentence), words, facts: factWords(words), statuses: statusesIn(fold(sentence)) };
  });
  const platform = id.split(":")[0];
  const extras = [...wordsOf(citation?.title ?? ""), ...wordsOf(platform === "drive" ? "drive google" : platform)];
  const labels = new Map<string, Set<string>>();
  for (const match of text.matchAll(/\b([A-Z][A-Z0-9]+-\d+) \(([^)]+)\)/g)) labels.set(match[1].toLowerCase(), statusesIn(fold(match[2])));
  return { id, sentences, folded: fold(text), extras, labels };
}

// ----- Checking one clause against one sentence -----

type Failure = { reason: Extract<RemovalReason, "new_fact" | "changed_meaning" | "new_words">; detail: string };
type ClauseResult = { failure?: Failure; score: number; usedSentence: boolean };
interface Clause { words: Word[]; facts: Word[]; statuses: Set<string>; plain: Word[] }

function analyse(text: string): Clause {
  const folded = fold(text);
  const words = wordsOf(text);
  return { words, facts: factWords(words), statuses: statusesIn(folded),
    plain: factWords(wordsOf(withoutStatuses(folded))).filter(item => !MEANING_WORDS.has(item.word)) };
}

const quote = (word: string) => `"${word}"`;
const anyOf = (words: Word[], vocabulary: Set<string>) => words.find(item => vocabulary.has(item.word));

function negatedWords(words: Word[]): Array<{ negation: string; word: Word }> {
  const found: Array<{ negation: string; word: Word }> = [];
  words.forEach((item, index) => {
    if (!NEGATIONS.has(item.word)) return;
    const next = words.slice(index + 1, index + 4).find(candidate => !FUNCTION_WORDS.has(candidate.word) && !NEGATIONS.has(candidate.word));
    if (next) found.push({ negation: item.raw, word: next });
  });
  return found;
}

function checkClause({ words, facts, statuses, plain }: Clause, sentence: Sentence, passage: Passage): ClauseResult {
  const inSentence = (item: Word) => sentence.words.some(other => matches(item, other));
  const inExtras = (item: Word) => passage.extras.some(other => matches(item, other));
  let usedSentence = false;
  let matched = 0;
  let total = 0;
  const failures: Failure[] = [];
  const fail = (failure: Failure) => { failures.push(failure); };

  // Numbers must be in the sentence, next to one of the same words.
  facts.forEach((item, index) => {
    const value = numberValue(item.word);
    if (value === undefined) return;
    total++;
    const neighbours = [facts[index - 1], facts[index + 1]].filter((other): other is Word => Boolean(other));
    const bound = sentence.facts.some((other, at) => numberValue(other.word) === value && (neighbours.length === 0 ||
      [sentence.facts[at - 1], sentence.facts[at + 1]].some(near => near && neighbours.some(mine => matches(mine, near)))));
    if (bound) { matched++; usedSentence = true; return; }
    const present = sentence.facts.some(other => numberValue(other.word) === value);
    fail({ reason: "new_fact", detail: present ? `${quote(item.raw)} isn't tied to the same words in the passage` : `the passage doesn't have ${quote(item.raw)}` });
  });

  // Names, keys, dates and quantities must be in the sentence; names and keys may come from the title or platform.
  for (const item of facts) {
    const kind = isName(item) ? "name" : TIME_WORDS.has(item.word) ? "time" : QUANTIFIERS.has(item.word) ? "quantity" : undefined;
    if (!kind) continue;
    total++;
    if (inSentence(item)) { matched++; usedSentence = true; }
    else if (kind !== "quantity" && inExtras(item)) matched++;
    else fail({ reason: "new_fact", detail: kind === "quantity" ? `adds ${quote(item.raw)}` : `the passage doesn't have ${quote(item.raw)}` });
  }

  // A status, the order of events, a comparison, a negation and a hedge must all agree with the sentence.
  for (const status of statuses) {
    if (!sentence.statuses.has(status)) {
      fail({ reason: "changed_meaning", detail: `says ${status}, but the passage says ${[...sentence.statuses].join(" or ") || "neither"}` });
    }
  }
  // A clause that only gives an issue's status must give the status the passage gives that issue.
  if (statuses.size && plain.length === 1 && isName(plain[0])) {
    const key = plain[0].word;
    const label = passage.labels.get(key);
    const near = sentence.facts.some((other, at) => other.word === key &&
      sentence.facts.slice(Math.max(0, at - 2), at + 3).some(word => [...statuses].some(status => statusesIn(word.word).has(status))));
    if (label ? ![...statuses].every(status => label.has(status)) : !near) {
      fail({ reason: "changed_meaning", detail: `says ${plain[0].raw} is ${[...statuses].join(" and ")}, but the passage says ${label ? [...label].join(" or ") : "otherwise"}` });
    }
  }
  const pairs: Array<[Set<string>, Set<string>, string, string]> = [[BEFORE, AFTER, "before", "after"], [AFTER, BEFORE, "after", "before"],
    [MORE, LESS, "more", "less"], [LESS, MORE, "less", "more"]];
  for (const [mine, opposite, name, other] of pairs) {
    if (anyOf(words, mine) && !anyOf(sentence.words, mine)) {
      fail({ reason: "changed_meaning", detail: `says ${name}, but the passage says ${anyOf(sentence.words, opposite) ? other : "neither"}` });
    }
  }
  const negation = anyOf(words, NEGATIONS);
  if (negation && !anyOf(sentence.words, NEGATIONS)) fail({ reason: "changed_meaning", detail: `adds ${quote(negation.raw)}` });
  if (!negation) {
    for (const { negation: theirs, word } of negatedWords(sentence.words)) {
      if (words.some(item => matches(item, word))) fail({ reason: "changed_meaning", detail: `drops the passage's ${quote(theirs)} before ${quote(word.raw)}` });
    }
  }
  const hedge = anyOf(words, HEDGES);
  const theirHedge = anyOf(sentence.words, HEDGES);
  if (theirHedge && !hedge) fail({ reason: "changed_meaning", detail: `drops the passage's ${quote(theirHedge.raw)}` });
  if (hedge && !theirHedge) fail({ reason: "changed_meaning", detail: `adds ${quote(hedge.raw)}` });

  // Every other word that carries meaning must come from the sentence, or from the title or platform.
  const missing: string[] = [];
  for (const item of plain) {
    if (numberValue(item.word) !== undefined || TIME_WORDS.has(item.word) || isName(item)) continue;
    total++;
    if (inSentence(item)) { matched++; usedSentence = true; }
    else if (inExtras(item)) matched++;
    else missing.push(item.raw);
  }
  if (missing.length) fail({ reason: "new_words", detail: `the passage doesn't say ${missing.map(quote).join(", ")}` });
  if (statuses.size && [...statuses].every(status => sentence.statuses.has(status))) usedSentence = true;

  const order: Failure["reason"][] = ["new_fact", "changed_meaning", "new_words"];
  const failure = failures.sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason))[0];
  return { failure, score: total ? matched / total : 1, usedSentence };
}

// ----- Checking a sentence -----

type SentenceResult =
  | { kept: true; kind: "quoted" | "reworded"; text: string; citations: string[]; support: string[] }
  | { kept: false; reason: RemovalReason; detail: string };

function backing(sentence: string, passages: Passage[]): SentenceResult {
  const claim = fold(sentence);
  if (!claim) return { kept: false, reason: "new_words", detail: "says nothing" };
  // Word for word. Part of a sentence must still mean what the whole does: "Include this channel" is in "Do not include
  // this channel", and so is "slip the release" in "may slip the release".
  for (const passage of passages) {
    if (!passage.folded.includes(claim)) continue;
    const whole = passage.sentences.find(item => item.folded.includes(claim));
    if (whole && whole.folded !== claim && checkClause(analyse(sentence), whole, passage).failure) continue;
    const original = sourceSentence(passage.sentences.map(item => item.text).join(" "), claim);
    return { kept: true, kind: "quoted", text: original ?? sentence.normalize("NFKC").replace(/[\u2010\u2011]/g, "-"),
      citations: [passage.id], support: whole ? [whole.text] : [] };
  }
  // Reworded: each clause must be backed by one sentence of one passage.
  const citations: string[] = [];
  const support: string[] = [];
  for (const clause of splitClauses(sentence).map(analyse)) {
    let best: { failure: Failure; score: number } | undefined;
    let backed = false;
    for (const passage of passages) {
      for (const candidate of passage.sentences) {
        const result = checkClause(clause, candidate, passage);
        if (!result.failure) {
          backed = true;
          if (!citations.includes(passage.id)) citations.push(passage.id);
          if (result.usedSentence && !support.includes(candidate.text)) support.push(candidate.text);
          break;
        }
        if (!best || result.score > best.score) best = { failure: result.failure, score: result.score };
      }
      if (backed) break;
    }
    if (!backed) return { kept: false, reason: best?.failure.reason ?? "new_words", detail: best?.failure.detail ?? "says nothing the passage says" };
  }
  return { kept: true, kind: "reworded", text: sentence.normalize("NFKC").replace(/[\u2010\u2011]/g, "-"), citations, support };
}

// ----- Checking an answer -----

export interface CheckReport {
  lines: Array<{ kind: "quoted" | "reworded"; text: string; citations: string[]; support: string[] }>;
  /** Lines left out, with their text and what was wrong, for the audit. */
  removed: Array<{ text: string; reason: RemovalReason; detail: string; citations: string[] }>;
}

/**
 * Checks a writer's reply line by line against the passages it was given (`evidence`, by citation ID), keeping what
 * they back. The answer carries the kept lines, their citations and the check; the report adds what was left out.
 */
export function checkAnswer(output: string, allowed: Map<string, Citation>, evidence: Map<string, string>):
  { answer: QueryAnswer; report: CheckReport } {
  const passages = new Map([...evidence].filter(([id]) => allowed.has(id)).map(([id, text]) => [id, passageOf(id, text, allowed.get(id))]));
  const report: CheckReport = { lines: [], removed: [] };
  for (const line of output.split(/\n+/).map(item => item.trim()).filter(Boolean)) {
    const markers = [...new Set([...line.matchAll(/\[([^\]]+)\]/g)].map(match => match[1]))];
    const body = line.replace(/\s*\[[^\]]+\]/g, " ").replace(/\s+/g, " ").trim();
    if (!body) continue;
    if (!markers.length) { report.removed.push({ text: body, reason: "no_citation", detail: "cites no passage", citations: [] }); continue; }
    const unknown = markers.find(id => !passages.has(id));
    if (unknown) {
      report.removed.push({ text: body, reason: "unknown_citation", detail: `cites ${unknown}, which the writer wasn't given`, citations: markers });
      continue;
    }
    const cited = markers.map(id => passages.get(id)!);
    for (const sentence of sentencesOf(body)) {
      const result = backing(sentence, cited);
      if (result.kept) {
        report.lines.push({ kind: result.kind, text: result.text, citations: markers.filter(id => result.citations.includes(id)), support: result.support });
        continue;
      }
      // Backed by a passage the writer had, but not one this line cites.
      const elsewhere = backing(sentence, [...passages.values()].filter(passage => !markers.includes(passage.id)));
      report.removed.push(elsewhere.kept
        ? { text: sentence, reason: "wrong_source", detail: `backed by ${elsewhere.citations.join(", ")}, not the passage it cites`, citations: markers }
        : { text: sentence, reason: result.reason, detail: result.detail, citations: markers });
    }
  }
  const citations = new Map<string, Citation>();
  for (const line of report.lines) for (const id of line.citations) citations.set(id, allowed.get(id)!);
  if (!report.lines.length) return { answer: { text: NO_RESULT, citations: [] }, report };
  const check: AnswerCheck = {
    lines: report.lines.map(line => ({ kind: line.kind, support: line.support })),
    removed: report.removed.map(item => ({ reason: item.reason }))
  };
  return {
    answer: {
      text: report.lines.map(line => `${line.text} ${line.citations.map(id => `[${id}]`).join(" ")}`).join("\n"),
      citations: [...citations.values()],
      check
    },
    report
  };
}
