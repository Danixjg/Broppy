// Builds the corpus from the content banks: first every item's id, readers, date and links, then its text, so the
// text may mention another item only when everyone who can read the first can read the second.
import type { NativePermission, Source, SourceDocument } from "../../packages/types/src/index.js";
import { Cast, People } from "./people.js";
import { Rng, byCode, sortedUnique } from "./random.js";
import {
  FILE_URLS, FIXTURE_NOW, HOUR, MAX_AGE_HOURS, MIME_TYPES, PERSONA_GROUPS, PERSONA_IDS, TEAMS, type PersonaId, type Scale
} from "./rules.js";
import type { Access, Bank, ChannelSpec, FileSpec, IssueSpec, PageSpec, Tier, Topic } from "./types.js";
import {
  REPEAT_LIMIT, Writer, cap, factVariants, list, restates, statusSentences, wordCount, type Voice
} from "./write.js";

export interface Tuple {
  user: string;
  relation: "member" | "direct_reader" | "group_reader" | "public_reader";
  object: string;
}

export interface Built {
  documents: SourceDocument[];
  fgaTuples: Tuple[];
  personaGroups: Record<PersonaId, string[]>;
}

type Kind = "master" | "page" | "issue" | "channel" | "file" | "superseded" | "near";

interface Shell {
  id: string;
  kind: Kind;
  source: Source;
  nativeId: string;
  title: string;
  url: string;
  hours: number;
  version: number;
  metadata: Record<string, string>;
  permissions: { users: string[]; groups: string[]; public: boolean; native: NativePermission };
  tier: Tier;
  links: string[];
  /** Everyone the platform lets read the item. */
  audience: Set<string>;
  /** Items in one family may share sentences: an item and its copies. */
  family: string;
  topic?: Topic;
  page?: PageSpec;
  issue?: IssueSpec;
  issueNo?: number;
  channel?: ChannelSpec;
  file?: FileSpec;
  original?: Shell;
  copy?: { older?: Array<[string, string]> };
  content: string;
}

interface Area {
  bank: Bank;
  cast: Cast;
  people: People;
  topics: Map<string, Topic>;
  names: string[];
  /** How often each fact has been said in this area, so items on one topic spread over its facts. */
  factUses: Map<string, number>;
  /** The same for Drive files alone, which the workspace compares with each other to find duplicates. */
  driveFactUses: Map<string, number>;
  master?: Shell;
  pages: Shell[];
  issues: Shell[];
  channels: Shell[];
  files: Shell[];
  copies: Shell[];
}

const UPPER_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

class Ids {
  private nextPage = 100000;
  private readonly used = new Set<string>();

  constructor(private readonly rng: Rng) {}

  page(): string {
    return String(this.nextPage++);
  }

  private unique(make: () => string): string {
    let id = make();
    while (this.used.has(id)) id = make();
    this.used.add(id);
    return id;
  }

  channel(): string {
    return this.unique(() => `C${this.rng.id(8, UPPER_DIGITS)}`);
  }

  file(): string {
    return this.unique(() => `1${this.rng.id(15, ALPHANUMERIC)}`);
  }
}

export function buildCorpus(seed: number, scale: Scale, banks: readonly Bank[]): Built {
  const rng = new Rng(seed);
  const people = new People(rng.stream("people"), scale);
  const ids = new Ids(rng.stream("ids"));
  const writer = new Writer(rng.stream("writer"), scale === "demo" ? REPEAT_LIMIT : Number.POSITIVE_INFINITY);
  const areas = banks.map(bank => planArea(bank, people, ids, rng.stream(`plan:${bank.key}`)));
  for (const area of areas) writeArea(area, writer, rng.stream(`text:${area.bank.key}`));
  const shells = areas.flatMap(area => [
    ...(area.master ? [area.master] : []), ...area.pages, ...area.issues, ...area.channels, ...area.files, ...area.copies
  ]);
  const documents = shells.map(toDocument).sort((a, b) => byCode(a.docId, b.docId));
  return { documents, fgaTuples: tuples(documents, people), personaGroups: personaGroups() };
}

// ---------------------------------------------------------------------------------------------------------------
// Planning: ids, readers, dates and links.

function planArea(bank: Bank, people: People, ids: Ids, rng: Rng): Area {
  const cast = new Cast(people, bank.key, bank.roles);
  const topics = new Map(bank.topics.map(topic => [topic.id, topic]));
  const names = sortedUnique([...Object.keys(bank.roles), ...(bank.grants ?? [])].map(role => cast.get(role).name));
  const area: Area = { bank, cast, people, topics, names, factUses: new Map(), driveFactUses: new Map(), pages: [], issues: [], channels: [], files: [], copies: [] };
  const topic = (id: string) => {
    const found = topics.get(id);
    if (!found) throw new Error(`${bank.key}: unknown topic ${id}`);
    return found;
  };

  if (bank.project) {
    area.master = confluencePage(area, ids, rng, `${bank.name} master page`, bank.masterAccess, "final", "master");
    area.master.metadata.label = "master";
    area.master.hours = rng.int(48, 480);
    area.master.version = rng.int(4, 12);
  }
  for (const page of bank.pages) {
    const shell = confluencePage(area, ids, rng, page.title, page.access, page.status ?? "final", "page");
    shell.page = page;
    shell.topic = topic(page.topic);
    area.pages.push(shell);
  }
  (bank.issues ?? []).forEach((issue, index) => {
    const key = `${bank.key}-${index + 1}`;
    const reach = readers(area, issue.access);
    const native: NativePermission = {
      source: "jira", projectKey: bank.key, projectViewers: reach.container,
      ...(reach.restricted ? { issueViewers: reach.restricted } : {})
    };
    area.issues.push(shell({
      id: `jira:${key}`, kind: "issue", source: "jira", nativeId: key, title: `${key} ${issue.summary}`,
      url: `https://jira.example/browse/${key}`,
      hours: rng.chance(0.4) ? rng.int(1, 167) : rng.int(168, 2400), version: rng.int(1, 6),
      metadata: { project: bank.key, status: issue.status }, reach, native, issue, issueNo: index + 1,
      topic: topic(issue.topic)
    }));
  });
  for (const channel of bank.channels) {
    const id = ids.channel();
    const reach = readers(area, channel.access);
    const native: NativePermission = { source: "slack", channelId: id, visibility: channel.visibility, members: reach.base };
    area.channels.push(shell({
      id: `slack:${id}`, kind: "channel", source: "slack", nativeId: id, title: `#${channel.name}`,
      url: `https://slack.example/archives/${id}`,
      hours: rng.chance(0.6) ? rng.int(1, 167) : rng.int(168, 2400), version: rng.int(1, 12),
      metadata: { channel: channel.name, ...(bank.project ? { project: bank.key } : {}) }, reach, native, channel
    }));
  }
  for (const file of bank.files) {
    const created = driveFile(area, ids, rng, file.title, file.type, file.status, file.access);
    created.file = file;
    created.topic = topic(file.topic);
    area.files.push(created);
  }
  for (const copy of bank.copies?.superseded ?? []) {
    const original = area.files.find(item => item.title === copy.title);
    if (!original) throw new Error(`${bank.key}: no file to supersede called ${copy.title}`);
    const created = driveFile(area, ids, rng, copy.title, original.file!.type, "superseded", original.file!.access);
    created.kind = "superseded";
    created.original = original;
    created.family = original.family;
    created.file = original.file;
    created.topic = original.topic;
    created.copy = { older: copy.older };
    created.hours = Math.min(MAX_AGE_HOURS, original.hours + rng.int(400, 1200));
    created.version = rng.int(1, Math.max(1, original.version - 1));
    area.copies.push(created);
  }
  for (const copy of bank.copies?.near ?? []) {
    const original = area.files.find(item => item.title === copy.of);
    if (!original) throw new Error(`${bank.key}: no file to copy called ${copy.of}`);
    const created = driveFile(area, ids, rng, copy.title, original.file!.type, original.file!.status, original.file!.access);
    created.kind = "near";
    created.original = original;
    created.family = original.family;
    created.file = original.file;
    created.topic = original.topic;
    created.hours = rng.int(24, 1500);
    created.version = rng.int(1, 4);
    area.copies.push(created);
  }
  if (bank.project) linkProject(area);
  return area;
}

function confluencePage(area: Area, ids: Ids, rng: Rng, title: string, access: Access | undefined, status: string, kind: Kind): Shell {
  const id = ids.page();
  const reach = readers(area, access);
  const native: NativePermission = {
    source: "confluence", spaceKey: area.bank.key, spaceViewers: reach.container,
    ...(reach.restricted ? { pageViewers: reach.restricted } : {})
  };
  return shell({
    id: `confluence:${id}`, kind, source: "confluence", nativeId: id, title,
    url: `https://confluence.example/wiki/spaces/${area.bank.key}/pages/${id}`,
    hours: rng.chance(0.06) ? rng.int(1, 167) : rng.int(168, 2700), version: rng.int(1, 12),
    metadata: { space: area.bank.key, status }, reach, native
  });
}

function driveFile(area: Area, ids: Ids, rng: Rng, title: string, type: FileSpec["type"], status: string, access: Access | undefined): Shell {
  const id = ids.file();
  const reach = readers(area, access);
  const owner = area.cast.get(access?.owner ?? area.bank.fileOwner).email;
  if (!reach.base.includes(owner)) throw new Error(`${area.bank.key}: the owner of ${title} can't read it`);
  const native: NativePermission = { source: "drive", fileId: id, owner, sharedUsers: reach.base.filter(email => email !== owner) };
  return shell({
    id: `drive:${id}`, kind: "file", source: "drive", nativeId: id, title, url: `${FILE_URLS[type]}${id}`,
    hours: rng.chance(0.1) ? rng.int(1, 167) : rng.int(168, 2600), version: rng.int(2, 9),
    metadata: { mimeType: MIME_TYPES[type], status, topic: area.bank.name }, reach, native
  });
}

interface Reach {
  users: string[];
  groups: string[];
  isPublic: boolean;
  tier: Tier;
  /** Who reads the item itself: Slack members, Drive owner and shared users. */
  base: string[];
  /** Who reads the space or Jira project the item sits in. */
  container: string[];
  /** Page or issue viewers, for a restricted page or issue. */
  restricted?: string[];
}

/** Who may read an item: its brain grant, and the platform's own lists, which must agree with it. */
function readers(area: Area, access: Access | undefined): Reach {
  const { bank, people, cast } = area;
  const union = (...lists: Array<readonly string[]>) => sortedUnique(lists.flat());
  const groups = access?.groups ?? bank.owners;
  const users = sortedUnique([
    ...(bank.grants ?? []), ...(access?.partner ? bank.partner ?? [] : []), ...(access?.users ?? [])
  ].map(role => cast.get(role).email));
  const isPublic = access?.public ?? bank.public ?? false;
  const everyoneInArea = bank.public ? people.everyone : people.audience(bank.owners);
  const partner = (bank.partner ?? []).map(role => cast.get(role).email);
  const restricted = access?.restrictTo ? union(people.audience(access.restrictTo), users)
    : bank.partner && !access?.partner ? union(people.audience(groups), users) : undefined;
  const expand = (token: string) => TEAMS.includes(token) ? people.audience([token]) : [cast.get(token).email];
  const base = access?.members ? union(...access.members.map(expand), users)
    : restricted ?? (isPublic ? union(people.everyone, users) : union(people.audience(groups), users));
  const container = union(everyoneInArea, partner, restricted ?? [], users);
  if (!base.length || !container.length) throw new Error(`${bank.key}: an item has no readers`);
  return { users, groups: sortedUnique(groups), isPublic, tier: access?.tier ?? bank.tier, base, container, restricted };
}

function shell(item: {
  id: string; kind: Kind; source: Source; nativeId: string; title: string; url: string; hours: number; version: number;
  metadata: Record<string, string>; reach: Reach; native: NativePermission; issue?: IssueSpec; issueNo?: number;
  channel?: ChannelSpec; topic?: Topic;
}): Shell {
  const { reach, native } = item;
  const audience = native.source === "jira" ? native.issueViewers ?? native.projectViewers
    : native.source === "confluence" ? native.pageViewers ?? native.spaceViewers
      : native.source === "slack" ? native.members : [native.owner, ...native.sharedUsers];
  return {
    id: item.id, kind: item.kind, source: item.source, nativeId: item.nativeId, title: item.title, url: item.url,
    hours: item.hours, version: item.version, metadata: item.metadata,
    permissions: { users: reach.users, groups: reach.groups, public: reach.isPublic, native },
    tier: reach.tier, links: [], audience: new Set(audience), family: item.id, issue: item.issue, issueNo: item.issueNo,
    channel: item.channel, topic: item.topic, content: ""
  };
}

/** The master page links the key issues, every channel and the main files; every other file hangs off an issue. */
function linkProject(area: Area): void {
  const { bank, master, issues, channels, files, copies } = area;
  if (!master || !issues.length || !channels.length) throw new Error(`${bank.key}: a project needs issues and channels`);
  const masterFiles = files.filter(item => item.file?.master);
  master.links = [
    ...(bank.masterIssues ?? []).map(number => issues[number - 1].id), ...channels.map(item => item.id),
    ...masterFiles.map(item => item.id)
  ];
  for (const issue of issues) {
    const channel = channels.find(item => item.channel!.topics.includes(issue.issue!.topic)) ?? channels[0];
    issue.links.push(channel.id);
  }
  const byTopic = new Map<string, number>();
  const attach = (file: Shell, topicId: string) => {
    const candidates = issues.filter(item => item.issue!.topic === topicId);
    const pool = candidates.length ? candidates : issues;
    const turn = byTopic.get(topicId) ?? 0;
    byTopic.set(topicId, turn + 1);
    pool[turn % pool.length].links.push(file.id);
  };
  for (const file of files) if (!file.file?.master) attach(file, file.file!.topic);
  for (const copy of copies) attach(copy, copy.file!.topic);
}

// ---------------------------------------------------------------------------------------------------------------
// Writing: the text of every item.

function writeArea(area: Area, writer: Writer, rng: Rng): void {
  if (area.master) area.master.content = writeMaster(area, area.master, writer);
  for (const page of area.pages) page.content = writePage(area, page, writer, rng);
  for (const issue of area.issues) issue.content = writeIssue(area, issue, writer);
  for (const channel of area.channels) channel.content = writeChannel(area, channel, writer);
  for (const file of area.files) file.content = writeFile(area, file, writer, rng);
  for (const copy of area.copies) copy.content = copy.kind === "superseded" ? supersede(copy) : nearCopy(copy);
}

/** Everyone who reads the first item can read the second, so naming it reveals nothing. */
function canMention(from: Shell, to: Shell): boolean {
  for (const email of from.audience) if (!to.audience.has(email)) return false;
  return true;
}

const keyOf = (issue: Shell) => issue.nativeId;

/** Picks facts not yet used in this item, each said in a way that is still free. */
class FactPicker {
  private readonly used = new Set<string>();
  private readonly styles = new Set<string>();
  /** Colleagues already quoted, so one thread doesn't quote the same person twice. */
  private readonly quoted = new Set<string>();

  constructor(private readonly area: Area, private readonly writer: Writer, private readonly family: string,
    private readonly voice: Voice = "formal", private readonly drive = false) {}

  /** A fact the item already states another way, such as in its status line. */
  mark(fact: string): void {
    this.used.add(fact);
  }

  /** Whether the item has said the fact, or must not. */
  has(fact: string): boolean {
    return this.used.has(fact);
  }

  /** Leaves out every fact of the area that the item's fixed lines already say, so nothing is said twice. */
  avoid(texts: ReadonlyArray<string | undefined>): void {
    const lines = texts.filter((text): text is string => Boolean(text));
    if (!lines.length) return;
    for (const topic of this.area.bank.topics) {
      for (const fact of topic.facts.map(item => this.area.cast.fill(item))) {
        if (lines.some(line => restates(fact, line))) this.used.add(fact);
      }
    }
  }

  take(topic: Topic, count: number, wrap?: (fact: string) => string[]): string[] {
    const picked: Array<[number, string]> = [];
    const { factUses: uses, driveFactUses: driveUses } = this.area;
    // Prefer the facts this area has said least, so two items on one topic don't say the same things; a Drive file
    // looks first at what other Drive files say, since those are the ones compared for duplicates.
    const said = (fact: string) => (this.drive ? (driveUses.get(fact) ?? 0) * 1000 : 0) + (uses.get(fact) ?? 0);
    const facts = topic.facts.map(fact => this.area.cast.fill(fact));
    for (let index = 0; index < count; index++) {
      const remaining = facts.filter(fact => !this.used.has(fact));
      if (!remaining.length) break;
      const fewest = Math.min(...remaining.map(said));
      const fresh = remaining.filter(fact => said(fact) === fewest);
      let tiers: Array<Array<readonly [string, readonly [string, string, string]]>>;
      if (wrap) {
        tiers = [fresh.flatMap(fact => wrap(fact).map(sentence => [sentence, [fact, "wrapped", ""]] as const))];
      } else {
        // Plain sentences may repeat in an item; an opener such as "Note that" or "Ana Silva says" may not, and a
        // colleague is quoted once.
        const variants = fresh.flatMap(fact => factVariants(fact, this.area.names, this.voice)
          .map(([style, tier, sentence, who]) => ({ fact, style, tier, sentence, who })));
        const open = variants.filter(item => item.style === "plain"
          || (!this.styles.has(item.style) && !(item.who && this.quoted.has(item.who))));
        const pool = open.length ? open : variants;
        tiers = [0, 1, 2].map(tier => pool.filter(item => item.tier === tier)
          .map(item => [item.sentence, [item.fact, item.style, item.who ?? ""]] as const));
      }
      const [sentence, [fact, style, who]] = this.writer.pickTiered(this.family, tiers);
      if (who) this.quoted.add(who);
      this.styles.add(style);
      this.used.add(fact);
      uses.set(fact, (uses.get(fact) ?? 0) + 1);
      if (this.drive) driveUses.set(fact, (driveUses.get(fact) ?? 0) + 1);
      picked.push([facts.indexOf(fact), sentence]);
    }
    // In the order the bank lists them, which is the order a person would explain them in.
    return picked.sort((a, b) => a[0] - b[0]).map(([, sentence]) => sentence);
  }

  /** Adds facts from the item's topic, then the area's other topics, until the text has enough words. */
  pad(lines: string[], topic: Topic, minimum = 32): string[] {
    const topics = [topic, ...this.area.bank.topics.filter(item => item !== topic)];
    for (const next of topics) {
      while (wordCount(lines.join(" ")) < minimum) {
        const added = this.take(next, 1);
        if (!added.length) break;
        lines.splice(Math.max(1, lines.length - 1), 0, ...added);
      }
    }
    return lines;
  }
}

/** A line about one of the issues, said in a way that is still free: "Next step: PLAT-4 moves the Android jobs.". */
function issueLine(writer: Writer, family: string, issues: readonly Shell[], cast: Cast,
  prefixes: (issue: Shell) => readonly string[]): string {
  return writer.pick(family, issues.flatMap(issue => prefixes(issue).map(prefix =>
    [`${prefix} ${keyOf(issue)} ${cast.fill(issue.issue!.what)}.`, issue] as const)))[0];
}

/** How a thread introduces an issue, by where it stands; the validator checks each prefix against the status. */
const NEXT = (issue: Shell) => issue.issue!.status === "open" ? ["Next step:", "Up next:", "Planned:"] : ["Next step:", "Up next:", "In progress:"];
const IN_REVIEW = () => ["In review:", "Waiting on review:"];
const DONE = () => ["Done:", "Shipped:", "Finished:"];

function writeMaster(area: Area, master: Shell, writer: Writer): string {
  const { bank, cast } = area;
  const family = master.family;
  const lines: string[] = [`Goal: ${cast.fill(bank.goal ?? bank.name)}.`];
  const [status, ...more] = (bank.status ?? []).map(item => cast.fill(item));
  // The master page always says "Status:", the line a catch-up looks for first.
  if (status) lines.push(`Status: ${status}.`);
  for (const item of more) {
    const variants = factVariants(item, area.names, "formal");
    lines.push(writer.pickTiered(family, [0, 1, 2].map(tier => variants.filter(([, level]) => level === tier)
      .map(([, , sentence]) => [sentence, null] as const)))[0]);
  }
  const keyIssues = (bank.masterIssues ?? []).map(number => area.issues[number - 1]).filter(item => canMention(master, item));
  if (keyIssues.length) lines.push(`Key issues: ${list(keyIssues.map(keyOf))}.`);
  for (const issue of keyIssues.filter(item => item.issue!.status === "blocked")) {
    lines.push(`${keyOf(issue)} is blocked because it ${cast.fill(issue.issue!.blockedBy!)}.`);
  }
  const mainFiles = area.files.filter(item => item.file!.master && canMention(master, item));
  const plan = mainFiles.find(item => item.file!.kind === "plan") ?? mainFiles[0];
  if (plan) lines.push(`Plan of record: the ${plan.title} in Drive.`);
  const decision = bank.topics.find(item => item.decision)?.decision;
  if (decision) lines.push(`Decided: ${cast.fill(decision)}.`);
  lines.push(`Owner: ${cast.get(bank.roles.lead ? "lead" : bank.fileOwner).name}.`);
  return lines.join(" ");
}

function writePage(area: Area, page: Shell, writer: Writer, rng: Rng): string {
  const { cast } = area;
  const spec = page.page!;
  const topic = page.topic!;
  const family = page.family;
  const facts = new FactPicker(area, writer, family);
  const say = (spec.say ?? []).map(item => cast.fill(item));
  const purpose = cast.fill(spec.purpose ?? `the ${topic.name}`);
  const people = rng.shuffle(area.names);
  const [owner, reviewer, third] = [people[0], people[1 % people.length], people[2 % people.length]];
  const steps = (topic.steps ?? []).map(item => cast.fill(item));
  const decision = topic.decision ? cast.fill(topic.decision) : undefined;
  const states = spec.kind === "decision" || spec.kind === "meeting";
  for (const line of say) writer.use(family, line);
  facts.avoid([...say, ...(spec.kind === "playbook" || spec.kind === "howto" ? steps : []), states ? decision : undefined,
    spec.kind === "meeting" && topic.risk ? cast.fill(topic.risk) : undefined]);
  let lines: string[];
  switch (spec.kind) {
    case "design":
      lines = [writer.say(family, [`This page describes ${purpose}.`, `This design explains ${purpose}.`]), ...say, ...facts.take(topic, 3),
        writer.say(family, [`${owner} owns this design, and ${reviewer} reviewed it.`, `Designed by ${owner} and reviewed by ${reviewer}.`])];
      if (topic.question) lines.push(`Open question: ${cast.fill(topic.question[0])}`);
      break;
    case "decision":
      lines = decision
        ? [...facts.take(topic, 1, fact => [`Context: ${fact}.`, `Background: ${fact}.`]), ...say, `Decision: ${decision}.`,
          ...facts.take(topic, 1),
          writer.say(family, [`Approved by ${owner} at the team sync.`, `${owner} approved this after the review.`])]
        : [`This page records a decision about the ${topic.name}.`, ...say, ...facts.take(topic, 3)];
      break;
    case "playbook":
      lines = [`Use this playbook when ${purpose}.`, ...say,
        ...(steps.length ? steps.map((step, index) => `Step ${index + 1}: ${cap(step)}.`) : facts.take(topic, 3)),
        writer.say(family, [`Escalate to ${owner} if the problem lasts more than an hour.`, `Call ${owner} if it is not fixed within an hour.`])];
      break;
    case "meeting": {
      lines = [`Attendees: ${list([owner, reviewer, third])}.`, ...say,
        ...facts.take(topic, 1, fact => [`Discussed: ${fact}.`, `Update: ${fact}.`])];
      if (topic.risk) lines.push(`Risk raised: ${cast.fill(topic.risk)}.`);
      lines.push(decision ? `Decided: ${decision}.` : facts.take(topic, 1)[0] ?? "");
      const next = area.issues.filter(item => item.issue!.topic === topic.id && item.issue!.status !== "done" && canMention(page, item));
      if (next.length) lines.push(issueLine(writer, family, next, cast, () => ["Next step:", "Follow-up:", "Action:"]));
      break;
    }
    case "howto": {
      lines = [`This guide explains how to ${purpose}.`, ...say];
      if (steps.length >= 3) lines.push(`First, ${steps[0]}.`, `Then ${steps[1]}.`, `Finally, ${steps[2]}.`);
      else lines.push(...facts.take(topic, 3));
      const channel = area.channels.find(item => item.channel!.topics.includes(topic.id) && canMention(page, item));
      if (channel) lines.push(`Ask in ${channel.title} if something fails.`);
      break;
    }
    case "policy":
      lines = [`This policy covers ${purpose}.`, ...say, ...facts.take(topic, 3), `Questions go to ${owner}.`];
      break;
    case "announcement":
      lines = [`${cap(purpose)}.`, ...say, ...facts.take(topic, 3), `Questions go to ${owner}.`];
      break;
    default:
      lines = [writer.say(family, [`This page covers ${purpose}.`, `This page explains ${purpose}.`]), ...say, ...facts.take(topic, 3)];
  }
  return facts.pad(lines.filter(Boolean), topic).join(" ");
}

function writeIssue(area: Area, issue: Shell, writer: Writer): string {
  const { bank, cast } = area;
  const spec = issue.issue!;
  const topic = issue.topic!;
  const facts = new FactPicker(area, writer, issue.family);
  const agreement = bank.trackedBy === issue.issueNo && bank.agreements?.[0] ? cast.fill(bank.agreements[0]) : undefined;
  const lines = [`${keyOf(issue)} ${cast.fill(spec.what)}.`];
  facts.avoid([lines[0], spec.blockedBy ? cast.fill(spec.blockedBy) : undefined, agreement, cast.fill(spec.acceptance)]);
  if (spec.status === "blocked") lines.push(`It ${cast.fill(spec.blockedBy!)}.`);
  else lines.push(...facts.take(topic, 1, fact => [`Context: ${fact}.`, `Background: ${fact}.`, `For context, ${fact}.`]));
  if (agreement) lines.push(agreement);
  lines.push(`Acceptance: ${cast.fill(spec.acceptance)}.`);
  if (wordCount(lines.join(" ")) < 28) {
    const more = topic.risk && spec.status !== "blocked" ? [`Risk: ${cast.fill(topic.risk)}.`]
      : facts.take(topic, 1, fact => [`Context: ${fact}.`, `Background: ${fact}.`, `For context, ${fact}.`]);
    lines.splice(lines.length - 1, 0, ...more);
  }
  return lines.join(" ");
}

function writeChannel(area: Area, channel: Shell, writer: Writer): string {
  const { bank, cast } = area;
  const spec = channel.channel!;
  const family = channel.family;
  const topics = spec.topics.map(id => area.topics.get(id)!);
  const facts = new FactPicker(area, writer, family, "chat");
  const inTopics = area.issues.filter(item => spec.topics.includes(item.issue!.topic) && canMention(channel, item));
  // The fixed lines come first, so that no fact repeats what one of them says.
  const blockers = bank.project ? inTopics.filter(item => item.issue!.status === "blocked").slice(0, 2).map(blocked => {
    const reason = cast.fill(blocked.issue!.blockedBy!);
    const line = (sentence: string) => [sentence, null] as const;
    return writer.pickTiered(family, [[line(`Blocker: ${keyOf(blocked)} ${reason}.`), line(`Blocker: ${keyOf(blocked)} still ${reason}.`)],
      [line(`Still blocked: ${keyOf(blocked)} ${reason}.`)]])[0];
  }) : [];
  const said = (spec.say ?? []).map(item => cast.fill(item));
  for (const line of said) writer.use(family, line);
  const questions = topics.filter(item => item.question).slice(0, 2)
    .flatMap(topic => [cast.fill(topic.question![0]), `${cast.fill(topic.question![1])}.`]);
  const agreements = (spec.agreements ?? []).map(index => cast.fill(bank.agreements![index]));
  const next = inTopics.filter(item => item.issue!.status === "in progress" || item.issue!.status === "open");
  const review = inTopics.filter(item => item.issue!.status === "in review");
  const done = inTopics.filter(item => item.issue!.status === "done");
  const closing = [
    ...(next.length ? [issueLine(writer, family, next, cast, NEXT)] : []),
    ...(review.length ? [issueLine(writer, family, review, cast, IN_REVIEW)] : []),
    ...(done.length ? [issueLine(writer, family, done, cast, DONE)] : [])
  ];
  facts.avoid([...blockers, ...said, ...questions, ...agreements, ...closing]);
  const lines: string[] = [];
  if (bank.project) {
    // A status line reports progress: the channel's own, or else a measured fact of its topics.
    const own = spec.status ? [cast.fill(spec.status)] : [];
    const numeric = topics.flatMap(topic => topic.facts.map(fact => cast.fill(fact))).filter(fact => /\d/.test(fact) && !facts.has(fact));
    const statuses = own.length ? own : numeric.length ? numeric : (bank.status ?? []).map(item => cast.fill(item));
    const [line, status] = writer.pick(family, statuses.flatMap(item => statusSentences(item).map(sentence => [sentence, item] as const)));
    lines.push(line);
    facts.mark(status);
    facts.avoid([status]);
  }
  lines.push(...blockers, ...said, ...questions);
  const target = bank.project ? 3 : 5;
  for (let index = 0; index < target; index++) lines.push(...facts.take(topics[index % topics.length], 1));
  // Short threads take facts from neighbouring topics, before the agreements and the closing lines.
  const neighbours = [...topics, ...bank.topics.filter(item => !topics.includes(item))];
  for (const topic of neighbours) {
    while (lines.length + agreements.length + closing.length < 5) {
      const added = facts.take(topic, 1);
      if (!added.length) break;
      lines.push(...added);
    }
  }
  return [...lines, ...agreements, ...closing].slice(0, 15).join("\n");
}

function writeFile(area: Area, file: Shell, writer: Writer, rng: Rng): string {
  const { cast } = area;
  const spec = file.file!;
  const topic = file.topic!;
  const family = file.family;
  const facts = new FactPicker(area, writer, family, "formal", true);
  const say = (spec.say ?? []).map(item => cast.fill(item));
  const purpose = cast.fill(spec.purpose ?? `the ${topic.name}`);
  const people = rng.shuffle(area.names);
  const owner = cast.get(spec.access?.owner ?? area.bank.fileOwner).name;
  const other = people.find(name => name !== owner) ?? people[0];
  const steps = (topic.steps ?? []).map(item => cast.fill(item));
  if (spec.type === "sheet") return [...say, ...(spec.rows ?? []).map((row, index) => `Row ${index + 1}: ${cap(cast.fill(row))}.`)].join("\n");
  const kind = spec.kind ?? (spec.type === "pdf" ? "summary" : "spec");
  for (const line of say) writer.use(family, line);
  facts.avoid([...say, ...(spec.type === "doc" && (kind === "guide" || kind === "checklist") ? steps : [])]);
  if (spec.type === "slides") {
    const slides = [`Slide 1: ${cap(purpose)}.`, ...say];
    for (let number = slides.length + 1; number <= 4; number++) {
      const [line] = facts.take(topic, 1, fact => [`Slide ${number}: ${cap(fact)}.`]);
      if (!line) break;
      slides.push(line);
    }
    slides.push(`Slide ${slides.length + 1}: Contact ${owner}.`);
    return slides.join("\n");
  }
  let lines: string[];
  switch (kind) {
    case "plan":
      lines = [`This plan covers ${purpose}.`, ...say, ...facts.take(topic, 3), `Owner: ${owner}.`, "Reviewed every two weeks."];
      break;
    case "proposal":
      lines = [`Proposal: ${purpose}.`, ...say, ...facts.take(topic, 1, fact => [`Why: ${fact}.`, `The reason: ${fact}.`]),
        ...facts.take(topic, 2), `Decision needed from ${other}.`];
      break;
    case "guide":
      lines = [`This guide explains ${purpose}.`, ...say,
        ...(steps.length >= 3 ? [`First, ${steps[0]}.`, `Then ${steps[1]}.`, `Finally, ${steps[2]}.`] : facts.take(topic, 3)),
        `Ask ${owner} if a step fails.`];
      break;
    case "checklist":
      lines = [`Checklist for ${purpose}.`, ...say,
        ...(steps.length ? steps.map((step, index) => `Item ${index + 1}: ${cap(step)}.`) : facts.take(topic, 3))];
      break;
    case "policy":
      lines = [`Policy: ${purpose}.`, ...say, ...facts.take(topic, 3), `Questions go to ${owner}.`];
      break;
    case "summary":
      lines = spec.type === "pdf"
        ? [`Exported summary of ${purpose}.`, ...say, ...facts.take(topic, 3), `Exported by ${owner}.`]
        : [`Summary of ${purpose}.`, ...say, ...facts.take(topic, 3), `Prepared by ${owner}.`];
      break;
    case "contract":
      lines = [`Signed agreement for ${purpose}.`, ...say, ...facts.take(topic, 2), `Signed by ${owner} and ${other}.`];
      break;
    case "brief":
      lines = [`Brief: ${purpose}.`, ...say, ...facts.take(topic, 3), `Contact: ${owner}.`];
      break;
    default:
      lines = [`This spec defines ${purpose}.`, ...say, ...facts.take(topic, 3), `Questions go to ${owner}.`];
  }
  return facts.pad(lines, topic).join(" ");
}

/** An older copy: the same text with some facts changed back. */
function supersede(copy: Shell): string {
  let text = copy.original!.content;
  let changed = 0;
  for (const [from, to] of copy.copy?.older ?? []) {
    if (text.includes(from)) {
      text = text.replace(from, to);
      changed++;
    }
  }
  if (!changed) {
    // No listed fact appears: change the first plain number instead, never one inside an issue key.
    text = text.replace(/(?<![A-Za-z0-9.,-])(\d+)(?![\d.,])/, (_, number: string) => String(Number(number) + 7));
  }
  if (text === copy.original!.content) throw new Error(`Superseded copy of ${copy.title} is unchanged`);
  return text;
}

/** A copy under another title: the same text, with its opening line rewritten. */
function nearCopy(copy: Shell): string {
  const original = copy.original!;
  const separator = original.content.includes("\n") ? "\n" : " ";
  const parts = separator === "\n" ? original.content.split("\n") : original.content.split(/(?<=[.!?])\s+/);
  return [`Working copy of the ${original.title}, shared for comments.`, ...parts.slice(1)].join(separator);
}

// ---------------------------------------------------------------------------------------------------------------
// Output.

function toDocument(item: Shell): SourceDocument {
  return {
    docId: item.id,
    source: item.source,
    sourceNativeId: item.nativeId,
    title: item.title,
    content: item.content,
    url: item.url,
    version: item.version,
    updatedAt: new Date(FIXTURE_NOW - item.hours * HOUR).toISOString(),
    metadata: item.metadata,
    permissions: item.permissions,
    tier: item.tier,
    ...(item.links.length ? { links: sortedUnique(item.links) } : {})
  };
}

function tuples(documents: readonly SourceDocument[], people: People): Tuple[] {
  const result: Tuple[] = [];
  for (const id of PERSONA_IDS) {
    for (const group of PERSONA_GROUPS[id]) {
      result.push({ user: `user:${people.persona(id).email}`, relation: "member", object: `group:${group}` });
    }
  }
  for (const doc of documents) {
    const object = `document:${doc.docId}`;
    for (const group of doc.permissions.groups) result.push({ user: `group:${group}#member`, relation: "group_reader", object });
    for (const user of doc.permissions.users) result.push({ user: `user:${user}`, relation: "direct_reader", object });
    if (doc.permissions.public) result.push({ user: "user:*", relation: "public_reader", object });
  }
  return result.sort((a, b) => byCode(a.object, b.object) || byCode(a.relation, b.relation) || byCode(a.user, b.user));
}

function personaGroups(): Record<PersonaId, string[]> {
  return {
    ravi: sortedUnique(PERSONA_GROUPS.ravi),
    maya: sortedUnique(PERSONA_GROUPS.maya),
    alex: sortedUnique(PERSONA_GROUPS.alex),
    david: sortedUnique(PERSONA_GROUPS.david),
    nur: sortedUnique(PERSONA_GROUPS.nur),
    wei: sortedUnique(PERSONA_GROUPS.wei)
  };
}
