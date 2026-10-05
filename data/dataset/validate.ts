// Judges the generated corpus by the app's own rules: its access check, link reader, search words and workspace
// functions are imported, never copied, so the data is checked exactly as the app will read it.
import {
  agreementSummary, duplicatesFor, projectOf, projectsFor, sentences, tracked, type WorkspaceDocument
} from "../../apps/api/src/workspace.js";
import { linkFromUrl, linksIn, withLinks } from "../../packages/connectors/src/index.js";
import { FgaAdapter } from "../../packages/fga-adapter/src/index.js";
import { terms } from "../../packages/retrieval/src/index.js";
import type { NativePermission, SourceDocument, User } from "../../packages/types/src/index.js";
import { BANKS } from "./banks/index.js";
import type { Built, Tuple } from "./build.js";
import { byCode, sortedUnique } from "./random.js";
import {
  ABBREVIATIONS, ALEX_WEI_WORDS, BRIEF_TARGETS, DAY, FILE_STATUSES, FIXTURE_NOW, FORBIDDEN_WORDS, HANDWRITTEN_TITLES,
  JIRA_STATUSES, MIME_TYPES, MONTHS, NEVER_GRANTED, PAGE_STATUSES, PERSONAS, PERSONA_GROUPS, PERSONA_IDS,
  PERSONA_VIEW_RANGES, RESERVED_CHANNELS, RESERVED_KEYS, TEAMS, type PersonaId, type Scale
} from "./rules.js";
import { LONG_SENTENCE, REPEAT_LIMIT, normalizeSentence, wordCount } from "./write.js";

const NOW = new Date(FIXTURE_NOW);
const DRIVE_TARGETS: Record<string, number> = {
  [MIME_TYPES.doc]: 70, [MIME_TYPES.sheet]: 40, [MIME_TYPES.slides]: 30, [MIME_TYPES.pdf]: 11
};

export function validateCorpus(corpus: Built, scale: Scale): string[] {
  const problems: string[] = [];
  const report = (where: string, message: string) => problems.push(`${where}: ${message}`);
  const docs = corpus.documents;
  const byId = new Map(docs.map(doc => [doc.docId, doc]));
  if (byId.size !== docs.length) report("corpus", "document ids are not unique");
  if (docs.some((doc, index) => index > 0 && byCode(docs[index - 1].docId, doc.docId) >= 0)) {
    report("corpus", "documents are not sorted by docId");
  }
  const personas = personaUsers(corpus);
  const fga = new FgaAdapter();
  for (const doc of docs) fga.upsert(doc);
  const views = new Map(personas.map(user =>
    [user.id as PersonaId, new Set(docs.filter(doc => fga.check(user, doc.docId, NOW).allowed).map(doc => doc.docId))]));
  const workspace = docs.map(doc => withLinks(doc) as SourceDocument & WorkspaceDocument);

  checkFormats(docs, corpus, report);
  checkLinks(docs, byId, report);
  checkWords(docs, views, report);
  checkAccess(docs, views, scale, report);
  if (scale === "demo") checkLeaks(docs, workspace, views, report);
  checkWorkspace(docs, workspace, scale, report);
  checkWriting(docs, views, scale, report);
  checkCounts(docs, scale, report);
  checkTuples(corpus, report);
  return problems;
}

type Report = (where: string, message: string) => void;

function personaUsers(corpus: Built): User[] {
  return PERSONAS.map(user => ({
    ...user, groups: sortedUnique([...user.groups, ...(corpus.personaGroups[user.id as PersonaId] ?? [])])
  }));
}

/** Who the platform itself lets read a document. */
function effectiveReaders(native: NativePermission): string[] {
  switch (native.source) {
    case "jira": return native.issueViewers ?? native.projectViewers;
    case "confluence": return native.pageViewers ?? native.spaceViewers;
    case "slack": return native.members;
    case "drive": return [native.owner, ...native.sharedUsers];
  }
}

const AREA_BY_NAME = new Map(BANKS.map(bank => [bank.name, bank.key]));
const AREA_BY_CHANNEL = new Map(BANKS.flatMap(bank => bank.channels.map(channel => [channel.name, bank.key] as const)));

/** The demo area an item belongs to. */
function areaOf(doc: SourceDocument): string | undefined {
  switch (doc.source) {
    case "jira": return doc.metadata.project;
    case "confluence": return doc.metadata.space;
    case "slack": return doc.metadata.project ?? AREA_BY_CHANNEL.get(doc.metadata.channel);
    case "drive": return AREA_BY_NAME.get(doc.metadata.topic);
  }
}

// 1. Formats --------------------------------------------------------------------------------------------------------

function checkFormats(docs: readonly SourceDocument[], corpus: Built, report: Report): void {
  const oldest = FIXTURE_NOW - 120 * DAY;
  let recent = 0;
  for (const doc of docs) {
    const where = doc.docId;
    const native = doc.permissions.native;
    const { source, metadata } = doc;
    if ("orgId" in doc || "deletedAt" in doc) report(where, "has orgId or deletedAt");
    if (!doc.title.trim() || doc.title !== doc.title.trim()) report(where, "empty or padded title");
    if (linkFromUrl(doc.url) !== doc.docId) report(where, `url ${doc.url} does not resolve to the item`);
    if (doc.docId !== `${source}:${doc.sourceNativeId}`) report(where, "sourceNativeId does not match the docId");
    if (!native || native.source !== source) report(where, "native permission missing or for another source");
    if (!Number.isInteger(doc.version) || doc.version < 1 || doc.version > 12) report(where, `version ${doc.version} out of range`);
    const updated = Date.parse(doc.updatedAt);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(doc.updatedAt) || updated > FIXTURE_NOW || updated < oldest) {
      report(where, `updatedAt ${doc.updatedAt} is not a whole hour within 120 days before the fixture time`);
    }
    if (FIXTURE_NOW - updated < 7 * DAY) recent++;
    if (Object.values(metadata).some(value => typeof value !== "string")) report(where, "metadata values must be strings");
    for (const group of doc.permissions.groups) {
      if (NEVER_GRANTED.includes(group) || !TEAMS.includes(group)) report(where, `grants group ${group}`);
    }
    if (doc.permissions.public && !["COMPANY", "PEOPLE"].includes(areaOf(doc) ?? "")) report(where, "public outside COMPANY and PEOPLE");
    const keys = Object.keys(metadata).sort(byCode).join(",");
    switch (source) {
      case "jira": {
        const key = doc.sourceNativeId;
        if (!/^jira:[A-Z][A-Z0-9]{1,9}-\d+$/.test(doc.docId)) report(where, "bad Jira id");
        if (!doc.title.startsWith(`${key} `)) report(where, "Jira title must start with its key");
        if (keys !== "project,status" || metadata.project !== key.split("-")[0]) report(where, `bad Jira metadata ${keys}`);
        if (!(JIRA_STATUSES as readonly string[]).includes(metadata.status)) report(where, `bad Jira status ${metadata.status}`);
        if (doc.url !== `https://jira.example/browse/${key}`) report(where, "bad Jira url");
        break;
      }
      case "confluence": {
        if (!/^confluence:\d{6}$/.test(doc.docId) || Number(doc.sourceNativeId) < 100000) report(where, "bad Confluence id");
        if (doc.url !== `https://confluence.example/wiki/spaces/${metadata.space}/pages/${doc.sourceNativeId}`) report(where, "bad Confluence url");
        const master = metadata.label === "master";
        if (keys !== (master ? "label,space,status" : "space,status")) report(where, `bad Confluence metadata ${keys}`);
        if (master !== doc.title.endsWith(" master page")) report(where, "label master must go with a master page title");
        if (!(PAGE_STATUSES as readonly string[]).includes(metadata.status)) report(where, `bad page status ${metadata.status}`);
        break;
      }
      case "slack": {
        if (!/^slack:C[A-Z0-9]{8}$/.test(doc.docId)) report(where, "bad Slack id");
        if (doc.url !== `https://slack.example/archives/${doc.sourceNativeId}`) report(where, "bad Slack url");
        if (doc.title !== `#${metadata.channel}`) report(where, "Slack title must be the channel name");
        if (keys !== "channel" && keys !== "channel,project") report(where, `bad Slack metadata ${keys}`);
        break;
      }
      case "drive": {
        if (!/^drive:1[A-Za-z0-9]{15}$/.test(doc.docId)) report(where, "bad Drive id");
        const type = Object.entries(MIME_TYPES).find(([, mime]) => mime === metadata.mimeType)?.[0];
        if (!type) report(where, `bad mimeType ${metadata.mimeType}`);
        if (keys !== "mimeType,status,topic") report(where, `bad Drive metadata ${keys}`);
        if (!(FILE_STATUSES as readonly string[]).includes(metadata.status)) report(where, `bad Drive status ${metadata.status}`);
        break;
      }
    }
    if (native) {
      const lists: string[][] = native.source === "slack" ? [native.members]
        : native.source === "jira" ? [native.projectViewers, ...(native.issueViewers ? [native.issueViewers] : [])]
          : native.source === "confluence" ? [native.spaceViewers, ...(native.pageViewers ? [native.pageViewers] : [])]
            : [native.sharedUsers];
      if (lists.some(items => !items.length)) report(where, "empty native list");
      if (native.source === "jira" && native.issueViewers?.some(email => !native.projectViewers.includes(email))) report(where, "issueViewers not within projectViewers");
      if (native.source === "confluence" && native.pageViewers?.some(email => !native.spaceViewers.includes(email))) report(where, "pageViewers not within spaceViewers");
      if (native.source === "drive" && !native.owner) report(where, "Drive file without an owner");
      for (const items of [...lists, doc.permissions.users, doc.permissions.groups]) {
        if (items.join("\n") !== sortedUnique(items).join("\n")) report(where, "a list is not sorted or has repeats");
      }
    }
  }
  const share = recent / Math.max(1, docs.length);
  if (share < 0.12 || share > 0.3) problems(report, `about 20% of items should be from the last week, got ${Math.round(share * 100)}%`);
  const expected = Object.fromEntries(PERSONA_IDS.map(id => [id, sortedUnique(PERSONA_GROUPS[id])]));
  if (JSON.stringify(corpus.personaGroups) !== JSON.stringify(expected)) report("personaGroups", "does not match the spec");
  const firsts = new Set(PERSONAS.map(user => user.name.split(" ")[0].toLowerCase()));
  for (const email of colleagues(docs)) {
    if (firsts.has(email.split(".")[0])) report(email, "a colleague uses a persona's first name");
  }
}

function problems(report: Report, message: string): void {
  report("corpus", message);
}

/** Every colleague's email in the corpus: not a persona. */
function colleagues(docs: readonly SourceDocument[]): string[] {
  const personas = new Set(PERSONAS.map(user => user.email));
  const emails = new Set<string>();
  for (const doc of docs) {
    for (const email of [...doc.permissions.users, ...effectiveReaders(doc.permissions.native!)]) {
      if (!personas.has(email)) emails.add(email);
    }
  }
  return sortedUnique(emails);
}

// 2. Links ----------------------------------------------------------------------------------------------------------

function checkLinks(docs: readonly SourceDocument[], byId: ReadonlyMap<string, SourceDocument>, report: Report): void {
  for (const doc of docs) {
    const declared = doc.links ?? [];
    if (declared.includes(doc.docId)) report(doc.docId, "links to itself");
    if (declared.join("\n") !== sortedUnique(declared).join("\n")) report(doc.docId, "links are not sorted or repeat");
    for (const target of [...declared, ...linksIn(doc.content).filter(id => id !== doc.docId)]) {
      if (!byId.has(target)) report(doc.docId, `links to ${target}, which does not exist`);
    }
  }
}

// 3. Words ----------------------------------------------------------------------------------------------------------

/** The search words of a text, with each part of a hyphenated word as well. */
function searchWords(text: string): Set<string> {
  const words = terms(text);
  return new Set([...words, ...words.flatMap(word => word.split("-"))]);
}

function checkWords(docs: readonly SourceDocument[], views: ReadonlyMap<PersonaId, Set<string>>, report: Report): void {
  const alexOrWei = new Set([...views.get("alex")!, ...views.get("wei")!]);
  for (const doc of docs) {
    const words = searchWords(`${doc.title} ${doc.content}`);
    for (const word of words) {
      if (FORBIDDEN_WORDS.has(word)) report(doc.docId, `uses the forbidden word "${word}"`);
      if (alexOrWei.has(doc.docId) && ALEX_WEI_WORDS.has(word)) report(doc.docId, `Alex or Wei can open it, and it says "${word}"`);
    }
    if (HANDWRITTEN_TITLES.has(doc.title)) report(doc.docId, "reuses a hand-written title");
    if (doc.source === "jira" && RESERVED_KEYS.has(doc.metadata.project)) report(doc.docId, "uses a reserved Jira key");
    if (doc.source === "confluence" && RESERVED_KEYS.has(doc.metadata.space)) report(doc.docId, "uses a reserved space key");
    if (doc.source === "slack" && RESERVED_CHANNELS.has(doc.metadata.channel)) report(doc.docId, "uses a reserved channel name");
  }
}

// 4. Access ---------------------------------------------------------------------------------------------------------

function checkAccess(docs: readonly SourceDocument[], views: ReadonlyMap<PersonaId, Set<string>>, scale: Scale, report: Report): void {
  if (scale === "demo") {
    for (const id of PERSONA_IDS) {
      const [low, high] = PERSONA_VIEW_RANGES[id];
      const count = views.get(id)!.size;
      if (count < low || count > high) report(id, `can open ${count} items, expected ${low}-${high}`);
    }
  }
  const byTitle = (title: string) => docs.find(doc => doc.title === title);
  const expect = (title: string, allowed: PersonaId[], denied: PersonaId[]) => {
    const doc = byTitle(title);
    if (!doc) return report(title, "example item is missing");
    for (const id of allowed) if (!views.get(id)!.has(doc.docId)) report(title, `${id} should be able to open it`);
    for (const id of denied) if (views.get(id)!.has(doc.docId)) report(title, `${id} should not be able to open it`);
  };
  expect("#plat-leads", ["ravi", "maya"], ["david", "wei", "alex"]);
  expect("Customer churn model review", ["nur"], ["david", "maya", "ravi"]);
  expect("Partner commercial review", ["maya"], ["ravi", "david", "wei"]);
  expect("#mob-war-room", ["maya"], ["david", "ravi", "wei"]);
  for (const doc of docs) {
    const readers = effectiveReaders(doc.permissions.native!);
    const contractors = sortedUnique([...readers, ...doc.permissions.users].filter(email => email.endsWith("@contractor.example")));
    for (const email of contractors) {
      if (!doc.permissions.users.includes(email)) report(doc.docId, `contractor ${email} can read it without a grant by name`);
      if (doc.tier === "restricted") report(doc.docId, `contractor ${email} on a restricted item`);
    }
  }
}

// 5. Leaks ----------------------------------------------------------------------------------------------------------

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function checkLeaks(docs: readonly SourceDocument[], workspace: ReadonlyArray<SourceDocument & WorkspaceDocument>,
  views: ReadonlyMap<PersonaId, Set<string>>, report: Report): void {
  const projects = projectsFor(workspace);
  for (const id of ["alex", "wei"] as PersonaId[]) {
    const visible = views.get(id)!;
    const visibleTitles = new Set(docs.filter(doc => visible.has(doc.docId)).map(doc => doc.title));
    const hidden = docs.filter(doc => !visible.has(doc.docId));
    const names: Array<[string, RegExp]> = [];
    const word = (text: string) => names.push([text, new RegExp(`(?<![A-Za-z0-9-])${escape(text)}(?![A-Za-z0-9-])`)]);
    for (const doc of hidden) {
      if (!visibleTitles.has(doc.title)) word(doc.title);
      if (doc.source === "jira") word(doc.sourceNativeId);
      if (doc.source === "slack" && doc.metadata.channel.includes("-")) word(doc.metadata.channel);
    }
    for (const project of projects) {
      if (!visible.has(project.masterDocId)) {
        word(project.name);
        word(project.key);
      }
    }
    for (const doc of docs.filter(item => visible.has(item.docId))) {
      const text = `${doc.title}\n${doc.content}`;
      for (const [name, pattern] of names) {
        if (text.includes(name) && pattern.test(text)) report(doc.docId, `${id} can open it, and it names "${name}", which ${id} can't open`);
      }
    }
  }
}

// 6. Workspace ------------------------------------------------------------------------------------------------------

function checkWorkspace(docs: readonly SourceDocument[], workspace: ReadonlyArray<SourceDocument & WorkspaceDocument>,
  scale: Scale, report: Report): void {
  const projects = projectsFor(workspace);
  const expected = BANKS.filter(bank => bank.project).map(bank => bank.name);
  const found = projects.map(project => project.name);
  if (scale === "demo" && found.slice().sort(byCode).join("|") !== expected.slice().sort(byCode).join("|")) {
    report("projects", `found ${found.join(", ")}`);
  }
  if (scale === "brief") {
    if (projects.length !== BRIEF_TARGETS.projects) report("projects", `found ${projects.length}, expected ${BRIEF_TARGETS.projects}`);
    for (const name of expected) if (!found.includes(name)) report("projects", `${name} is missing`);
  }
  for (const project of projects) {
    const members = new Set(project.docIds);
    for (const file of docs.filter(doc => doc.source === "drive" && doc.metadata.topic === project.name)) {
      if (!members.has(file.docId)) report(file.docId, `is not reached from the ${project.key} master page or issues`);
    }
  }
  if (scale === "demo") {
    const drive = workspace.filter(doc => doc.source === "drive");
    const pairKey = (a: string, b: string) => [a, b].sort(byCode).join(" + ");
    const actual = new Set(duplicatesFor(drive, NOW).map(pair => pairKey(pair.keep, pair.other)));
    const intended = new Set<string>();
    for (const bank of BANKS) {
      const files = drive.filter(doc => doc.metadata.topic === bank.name);
      for (const copy of bank.copies?.superseded ?? []) {
        const current = files.find(doc => doc.title === copy.title && doc.metadata.status !== "superseded");
        const old = files.find(doc => doc.title === copy.title && doc.metadata.status === "superseded");
        if (current && old) intended.add(pairKey(current.docId, old.docId));
        else report(bank.key, `superseded copy of ${copy.title} is missing`);
      }
      for (const copy of bank.copies?.near ?? []) {
        const original = files.find(doc => doc.title === copy.of);
        const near = files.find(doc => doc.title === copy.title);
        if (original && near) intended.add(pairKey(original.docId, near.docId));
        else report(bank.key, `near-copy ${copy.title} is missing`);
      }
    }
    for (const pair of actual) if (!intended.has(pair)) report("duplicates", `unintended pair ${pair}`);
    for (const pair of intended) if (!actual.has(pair)) report("duplicates", `intended pair not found: ${pair}`);
  }
  const issues = workspace.filter(doc => doc.source === "jira");
  for (const project of projects) {
    const own = issues.filter(doc => doc.metadata.project === project.key);
    let total = 0;
    let trackedCount = 0;
    for (const thread of workspace.filter(doc => doc.source === "slack" && projectOf(doc, issues) === project.key)) {
      for (const sentence of sentences(thread.content)) {
        if (!agreementSummary(sentence)) continue;
        total++;
        if (tracked(sentence, own)) trackedCount++;
      }
    }
    if (total < 3 || trackedCount < 1 || total - trackedCount < 1) {
      report(project.key, `has ${total} agreements, ${trackedCount} tracked; needs at least 3, with one tracked and one not`);
    }
  }
}

// 7. Writing --------------------------------------------------------------------------------------------------------

function checkWriting(docs: readonly SourceDocument[], views: ReadonlyMap<PersonaId, Set<string>>, scale: Scale,
  report: Report): void {
  const statuses = new Map(docs.filter(doc => doc.source === "jira").map(doc => [doc.sourceNativeId, doc.metadata.status]));
  const people = new Set<string>();
  for (const email of colleagues(docs)) {
    const [first, last] = email.split("@")[0].split(".").map(part => part[0].toUpperCase() + part.slice(1));
    people.add(first);
    people.add(`${first} ${last}`);
  }
  for (const user of PERSONAS) {
    people.add(user.name);
    people.add(user.name.split(" ")[0]);
  }
  for (const doc of docs) {
    const where = doc.docId;
    const { content } = doc;
    const words = wordCount(content);
    if (words < 25 || words > 200) report(where, `has ${words} words; needs 25-200`);
    if (!/^[\x20-\x7E\n]*$/.test(content) || !/^[\x20-\x7E]*$/.test(doc.title)) report(where, "is not plain ASCII");
    const lines = content.split("\n");
    if (content !== content.trim() || lines.some(line => !line.trim() || !/[.!?]$/.test(line))) {
      report(where, "a line does not end with a full stop, question mark or exclamation mark");
    }
    if (/[.!?]\s+[a-z]/.test(content)) report(where, "a sentence starts with a lower-case letter, which suggests an abbreviation");
    if (ABBREVIATIONS.test(content)) report(where, "uses an abbreviation with a full stop");
    if (MONTHS.test(content) || MONTHS.test(doc.title)) report(where, "names a month");
    if (/\b\d{4}-\d{2}-\d{2}\b/.test(content) || /\b(?:19|20)\d{2}\b/.test(content)) report(where, "has a calendar date or year");
    if (/\bQ[1-4]\b/.test(content) || /\bQ[1-4]\b/.test(doc.title)) report(where, "names a quarter");
    if (doc.source === "slack") {
      if (lines.length < 5 || lines.length > 15) report(where, `has ${lines.length} Slack lines; needs 5-15`);
      for (const line of lines) {
        const speaker = /^([A-Z][a-z]+(?: [A-Z][a-z]+)?):/.exec(line)?.[1];
        if (speaker && people.has(speaker)) report(where, `a Slack line starts with a speaker: ${speaker}`);
      }
    }
    if (doc.source === "jira") {
      if (!content.startsWith(`${doc.sourceNativeId} `)) report(where, "Jira content must start with its key");
      if (!content.includes("Acceptance:")) report(where, "Jira content needs acceptance criteria");
      const count = sentences(content).length;
      if (count < 2 || count > 5) report(where, `Jira content has ${count} sentences; needs 2-5`);
    }
    for (const [, key, status] of content.matchAll(/\b([A-Z][A-Z0-9]{1,9}-\d+) is (open|in progress|in review|blocked|done)\b/g)) {
      if (statuses.get(key) !== status) report(where, `says ${key} is ${status}, but it is ${statuses.get(key)}`);
    }
    // Lines that say where an issue stands: a blocker, something finished, or a step still to come.
    for (const sentence of sentences(content)) {
      const claim = CLAIM.exec(sentence)?.[1];
      if (!claim) continue;
      const expected = CLAIMS[claim];
      for (const [key] of sentence.matchAll(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g)) {
        const status = statuses.get(key);
        if (expected === "not done" ? status === "done" : status !== expected) {
          report(where, `a "${claim}:" line names ${key}, which is ${status}`);
        }
      }
    }
  }
  if (scale === "demo") {
    checkRepeats(docs, report);
    checkCatchUps(docs, views, report);
  }
}

const CLAIMS: Record<string, "open" | "in progress" | "in review" | "blocked" | "done" | "not done"> = {
  "Blocker": "blocked", "Still blocked": "blocked", "Done": "done", "Shipped": "done", "Finished": "done",
  "Planned": "open", "In progress": "in progress", "In review": "in review", "Waiting on review": "in review",
  "Next step": "not done", "Up next": "not done", "Follow-up": "not done", "Action": "not done"
};
const CLAIM = new RegExp(`^(${Object.keys(CLAIMS).join("|")}):`);

/** The words the catch-ups look for: a new hire's reading list, what was shared with Wei Ming, and project status. */
function checkCatchUps(docs: readonly SourceDocument[], views: ReadonlyMap<PersonaId, Set<string>>, report: Report): void {
  const has = (doc: SourceDocument, pattern: RegExp) => pattern.test(`${doc.title}\n${doc.content}`);
  const intern = docs.filter(doc => areaOf(doc) === "INTERN");
  for (const word of ["overview", "milestones", "workflow", "guides", "read first"]) {
    if (!intern.some(doc => has(doc, new RegExp(`\\b${word}\\b`, "i")))) report("INTERN", `no item uses the word "${word}"`);
  }
  const shared = docs.filter(doc => areaOf(doc) === "VEND" && views.get("wei")!.has(doc.docId));
  for (const phrase of ["shared with Wei Ming", "Wei Ming will own"]) {
    const count = shared.filter(doc => doc.content.includes(phrase)).length;
    if (count < 2) report("VEND", `${count} items Wei Ming can open say "${phrase}"; needs at least 2`);
  }
  for (const bank of BANKS.filter(item => item.project)) {
    const own = docs.filter(doc => areaOf(doc) === bank.key);
    for (const line of ["Status:", "Blocker:", "Decided:"]) {
      if (!own.some(doc => sentences(doc.content).some(sentence => sentence.startsWith(line)))) {
        report(bank.key, `no item has a "${line}" line`);
      }
    }
  }
}

/** No sentence of six or more words in more than three items; an item and its copies count as one. */
function checkRepeats(docs: readonly SourceDocument[], report: Report): void {
  const family = new Map(docs.map(doc => [doc.docId, doc.docId]));
  for (const bank of BANKS) {
    const files = docs.filter(doc => doc.source === "drive" && doc.metadata.topic === bank.name);
    for (const copy of bank.copies?.superseded ?? []) {
      const current = files.find(doc => doc.title === copy.title && doc.metadata.status !== "superseded");
      const old = files.find(doc => doc.title === copy.title && doc.metadata.status === "superseded");
      if (current && old) family.set(old.docId, current.docId);
    }
    for (const copy of bank.copies?.near ?? []) {
      const original = files.find(doc => doc.title === copy.of);
      const near = files.find(doc => doc.title === copy.title);
      if (original && near) family.set(near.docId, original.docId);
    }
  }
  const issues = docs.filter(doc => doc.source === "jira") as unknown as WorkspaceDocument[];
  const uses = new Map<string, Set<string>>();
  for (const doc of docs) {
    for (const sentence of sentences(doc.content)) {
      if (wordCount(sentence) < LONG_SENTENCE) continue;
      if (agreementSummary(sentence) && tracked(sentence, issues)) continue;
      const key = normalizeSentence(sentence);
      const families = uses.get(key) ?? new Set<string>();
      families.add(family.get(doc.docId)!);
      uses.set(key, families);
    }
  }
  for (const [sentence, families] of uses) {
    if (families.size > REPEAT_LIMIT) report("repeats", `"${sentence}" appears in ${families.size} items`);
  }
}

// 8. Counts ---------------------------------------------------------------------------------------------------------

function checkCounts(docs: readonly SourceDocument[], scale: Scale, report: Report): void {
  const within = (actual: number, target: number) => actual >= Math.floor(target * 0.9) && actual <= Math.ceil(target * 1.1);
  const bySource = (source: string) => docs.filter(doc => doc.source === source).length;
  const staff = colleagues(docs).length;
  if (scale === "brief") {
    const targets: Array<[string, number, number]> = [
      ["confluence", bySource("confluence"), BRIEF_TARGETS.confluence], ["jira", bySource("jira"), BRIEF_TARGETS.jira],
      ["slack", bySource("slack"), BRIEF_TARGETS.slack], ["drive", bySource("drive"), BRIEF_TARGETS.drive],
      ["colleagues", staff, BRIEF_TARGETS.colleagues],
      ["spaces", new Set(docs.filter(doc => doc.source === "confluence").map(doc => doc.metadata.space)).size, BRIEF_TARGETS.spaces]
    ];
    for (const [name, actual, target] of targets) if (!within(actual, target)) report("counts", `${name}: ${actual}, expected about ${target}`);
    return;
  }
  for (const bank of BANKS) {
    const items = docs.filter(doc => areaOf(doc) === bank.key);
    const expected: Record<string, number> = {
      confluence: bank.pages.length + (bank.project ? 1 : 0), jira: bank.issues?.length ?? 0, slack: bank.channels.length,
      drive: bank.files.length + (bank.copies?.superseded.length ?? 0) + (bank.copies?.near.length ?? 0)
    };
    for (const [source, target] of Object.entries(expected)) {
      const actual = items.filter(doc => doc.source === source).length;
      if (!within(actual, target)) report(bank.key, `${actual} ${source} items, expected ${target}`);
    }
  }
  const totals: Array<[string, number]> = [["confluence", 149], ["jira", 140], ["slack", 60], ["drive", 151]];
  for (const [source, target] of totals) if (!within(bySource(source), target)) report("counts", `${source}: ${bySource(source)}, expected about ${target}`);
  for (const [mime, target] of Object.entries(DRIVE_TARGETS)) {
    const actual = docs.filter(doc => doc.metadata.mimeType === mime).length;
    if (!within(actual, target)) report("counts", `${mime}: ${actual}, expected about ${target}`);
  }
  if (docs.length < 490 || docs.length > 510) report("counts", `${docs.length} items, expected 490-510`);
  if (!within(staff, 60)) report("counts", `${staff} colleagues, expected about 60`);
  const contractors = colleagues(docs).filter(email => email.endsWith("@contractor.example")).length;
  if (contractors > 7) report("counts", `${contractors} contractors, expected about 5`);
}

// The FGA tuples, rebuilt from the documents and persona groups. --------------------------------------------------

function checkTuples(corpus: Built, report: Report): void {
  const expected: Tuple[] = [];
  for (const id of PERSONA_IDS) {
    const email = PERSONAS.find(user => user.id === id)!.email;
    for (const group of corpus.personaGroups[id]) expected.push({ user: `user:${email}`, relation: "member", object: `group:${group}` });
  }
  for (const doc of corpus.documents) {
    const object = `document:${doc.docId}`;
    for (const group of doc.permissions.groups) expected.push({ user: `group:${group}#member`, relation: "group_reader", object });
    for (const user of doc.permissions.users) expected.push({ user: `user:${user}`, relation: "direct_reader", object });
    if (doc.permissions.public) expected.push({ user: "user:*", relation: "public_reader", object });
  }
  expected.sort((a, b) => byCode(a.object, b.object) || byCode(a.relation, b.relation) || byCode(a.user, b.user));
  if (JSON.stringify(expected) !== JSON.stringify(corpus.fgaTuples)) report("fgaTuples", "do not match the documents, or are not sorted");
}

/** How many generated items each persona may open, for the generator's summary. */
export function personaViews(corpus: Built): Record<PersonaId, number> {
  const fga = new FgaAdapter();
  for (const doc of corpus.documents) fga.upsert(doc);
  const users = personaUsers(corpus);
  return Object.fromEntries(users.map(user =>
    [user.id, corpus.documents.filter(doc => fga.check(user, doc.docId, NOW).allowed).length])) as Record<PersonaId, number>;
}

export { areaOf };
