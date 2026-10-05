// The brief's scale: 24 more projects and 15 team spaces, built the same way as the demo areas from generic
// components, so the benchmark has realistic volume. Text repeats more here, which only the brief's scale allows.
import type { Rng } from "./random.js";
import type { JiraStatus } from "./rules.js";
import type { Bank, FileSpec, IssueSpec, PageKind, PageSpec, Topic } from "./types.js";
import type { FileType } from "./rules.js";

interface ProjectSeed { key: string; name: string; owners: [string, string]; parts: string[] }
interface SpaceSeed { key: string; name: string; owners: string[]; parts: string[] }

const PROJECTS: ProjectSeed[] = [
  { key: "FLT", name: "Fleet telemetry rollout", owners: ["data", "platform"], parts: ["telemetry agent", "vehicle map", "trip export", "alert rules", "driver app sync", "fuel usage view"] },
  { key: "INVX", name: "Invoice export redesign", owners: ["product", "finance"], parts: ["invoice export", "tax rules", "export scheduler", "PDF renderer", "customer portal", "audit trail"] },
  { key: "SUPT", name: "Support inbox triage", owners: ["product", "data"], parts: ["inbox router", "reply templates", "priority rules", "customer timeline", "agent dashboard", "survey sender"] },
  { key: "SRCH", name: "Search ranking refresh", owners: ["data", "platform"], parts: ["ranking model", "query parser", "synonym list", "search page", "click tracker", "index builder"] },
  { key: "PRTL", name: "Partner portal refresh", owners: ["product", "design"], parts: ["portal home", "order lookup", "document centre", "user roles", "help widget", "sign-in page"] },
  { key: "PICK", name: "Warehouse picking app", owners: ["mobile", "product"], parts: ["pick list", "barcode scanner", "route planner", "shift view", "stock counter", "offline queue"] },
  { key: "FSAL", name: "Field sales app", owners: ["mobile", "product"], parts: ["account map", "visit planner", "quote builder", "contact list", "sync engine", "sales dashboard"] },
  { key: "PRCE", name: "Pricing page experiments", owners: ["product", "design"], parts: ["pricing page", "plan picker", "experiment framework", "checkout form", "comparison table", "questions block"] },
  { key: "HLTH", name: "Customer health scores", owners: ["data", "product"], parts: ["health score", "usage signals", "renewal list", "score dashboard", "alert digest", "data feed"] },
  { key: "PREF", name: "Email preference centre", owners: ["product", "platform"], parts: ["preference page", "unsubscribe flow", "topic list", "send scheduler", "bounce handler", "consent log"] },
  { key: "KBAS", name: "Knowledge base refresh", owners: ["product", "design"], parts: ["article editor", "search box", "article ratings", "category tree", "translation queue", "related articles"] },
  { key: "RTRN", name: "Returns portal", owners: ["product", "platform"], parts: ["return form", "label printer", "refund rules", "status tracker", "courier booking", "return reasons"] },
  { key: "DRVR", name: "Driver scheduling", owners: ["platform", "data"], parts: ["shift planner", "availability form", "route assigner", "rate cards", "overtime rules", "schedule export"] },
  { key: "STOR", name: "Store locator rebuild", owners: ["mobile", "design"], parts: ["store map", "opening hours", "search filters", "store pages", "directions link", "location data"] },
  { key: "LOYL", name: "Loyalty points sync", owners: ["platform", "finance"], parts: ["points balance", "sync job", "expiry rules", "member page", "partner feed", "points history"] },
  { key: "ACCT", name: "Accounting close automation", owners: ["finance", "data"], parts: ["close checklist", "journal import", "variance view", "approval flow", "bank feed", "period lock"] },
  { key: "RENW", name: "Contract renewal tracker", owners: ["legal", "product"], parts: ["renewal list", "reminder emails", "contract fields", "owner view", "renewal dashboard", "notice periods"] },
  { key: "RCRT", name: "Recruiting pipeline revamp", owners: ["people-ops", "product"], parts: ["job board", "candidate list", "interview planner", "scorecards", "offer letters", "referral form"] },
  { key: "LRNG", name: "Learning portal", owners: ["people-ops", "design"], parts: ["course catalogue", "progress tracker", "quiz builder", "certificates", "learning paths", "team view"] },
  { key: "EXPN", name: "Expense tool upgrade", owners: ["finance", "product"], parts: ["receipt scanner", "expense form", "approval chain", "card feed", "mileage rules", "expense export"] },
  { key: "TRNS", name: "Translation workflow", owners: ["product", "design"], parts: ["string export", "translation memory", "review queue", "glossary", "language picker", "release bundle"] },
  { key: "ACSB", name: "Accessibility programme", owners: ["design", "mobile"], parts: ["contrast checker", "screen reader tests", "keyboard paths", "caption tool", "audit tracker", "design tokens"] },
  { key: "STAT", name: "Status page rebuild", owners: ["platform", "sre"], parts: ["status page", "component list", "subscriber emails", "uptime chart", "maintenance notices", "history view"] },
  { key: "DEVP", name: "Developer portal", owners: ["platform", "product"], parts: ["API reference", "sandbox keys", "code samples", "changelog", "usage charts", "sign-up form"] }
];

const SPACES: SpaceSeed[] = [
  { key: "SREH", name: "SRE handbook", owners: ["sre"], parts: ["error budgets", "alert policy", "capacity reviews", "on-call training", "service levels"] },
  { key: "DSYS", name: "Design system", owners: ["design"], parts: ["colour tokens", "type scale", "button styles", "icon set", "layout grid"] },
  { key: "PRDH", name: "Product handbook", owners: ["product"], parts: ["roadmap process", "discovery interviews", "release reviews", "product metrics", "feature flags"] },
  { key: "FINO", name: "Finance operations", owners: ["finance"], parts: ["month end close", "invoice approvals", "budget reviews", "supplier setup", "expense audits"] },
  { key: "RSKH", name: "Risk handbook", owners: ["risk"], parts: ["risk register", "control testing", "policy reviews", "training records", "exception log"] },
  { key: "MOBG", name: "Mobile guild", owners: ["mobile"], parts: ["release checklist", "crash triage", "app size", "store listings", "device lab"] },
  { key: "DENG", name: "Data engineering guild", owners: ["data"], parts: ["pipeline standards", "data contracts", "job testing", "cost reviews", "schema registry"] },
  { key: "SUPH", name: "Support handbook", owners: ["product"], parts: ["ticket priorities", "escalation paths", "reply macros", "customer tone", "holiday cover"] },
  { key: "SALE", name: "Sales playbooks", owners: ["product", "finance"], parts: ["discovery calls", "demo scripts", "pricing approvals", "renewal calls", "territory plans"] },
  { key: "MKTG", name: "Marketing", owners: ["product", "design"], parts: ["campaign plans", "brand guide", "webinars", "newsletter", "event booths"] },
  { key: "OFFO", name: "Office operations", owners: ["people-ops"], parts: ["desk booking", "visitor rules", "office supplies", "facilities requests", "mail room"] },
  { key: "TRVL", name: "Travel desk", owners: ["people-ops", "finance"], parts: ["flight booking", "hotel rates", "visa letters", "travel cards", "trip approvals"] },
  { key: "QAGD", name: "Quality guild", owners: ["platform", "mobile"], parts: ["test strategy", "bug triage", "release sign-off", "test data", "exploratory testing"] },
  { key: "ARCH", name: "Architecture forum", owners: ["eng-leads", "platform"], parts: ["service boundaries", "API standards", "event schemas", "tech radar", "review board"] },
  { key: "TOOL", name: "Developer tooling", owners: ["platform", "sre"], parts: ["build tools", "local setup", "code search", "linting rules", "editor plugins"] }
];

const VERBS: Array<[string, string]> = [
  ["Add", "adds"], ["Fix", "fixes"], ["Speed up", "speeds up"], ["Document", "documents"], ["Test", "tests"],
  ["Move", "moves"], ["Simplify", "simplifies"], ["Measure", "measures"], ["Retire", "retires"], ["Split", "splits"]
];
const SUFFIXES = [
  "for large accounts", "for the mobile view", "for admins", "in the nightly run", "for new customers",
  "for the export screen", "for the weekly digest", "behind a flag", "for the second region", "for read-only users",
  "for the support team", "before the next release"
];
const UNITS = ["records", "requests", "messages", "rows", "events", "files"];
const KINDS: PageKind[] = ["design", "decision", "playbook", "meeting", "howto", "reference"];
const KIND_LABELS: Record<PageKind, string> = {
  design: "design", decision: "decision record", playbook: "playbook", meeting: "sync summary", howto: "how-to",
  reference: "reference", policy: "policy", announcement: "announcement"
};
const STATUS_CYCLE: JiraStatus[] = ["done", "done", "in progress", "in progress", "in progress", "in review", "blocked", "open", "open", "done"];
const FILE_CYCLE: FileType[] = ["doc", "sheet", "doc", "slides", "doc", "sheet", "doc", "slides", "doc", "sheet", "doc", "slides", "doc", "pdf", "sheet"];
const DOC_KINDS = ["plan", "proposal", "spec", "guide", "checklist", "brief"] as const;
const FILE_STATUSES = ["final", "in review", "draft", "final"] as const;

const cap = (text: string) => text[0].toUpperCase() + text.slice(1);
/** 2100 as "2,100", written by hand so no locale is involved. */
const thousands = (value: number) => value >= 1000 ? `${Math.floor(value / 1000)},${String(value % 1000).padStart(3, "0")}` : String(value);
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function topicFor(rng: Rng, part: string, index: number): Topic {
  const amount = rng.int(2, 90) * 100;
  const rate = rng.int(2, 9) / 10;
  return {
    id: `t${index}`,
    name: part,
    facts: [
      `the ${part} handles ${thousands(amount)} ${rng.pick(UNITS)} a day`,
      `changes to the ${part} ship behind a flag first`,
      `the ${part} has an error rate of ${rate}%`,
      `{e1} looks after the ${part} this half`
    ],
    steps: [
      `check the ${part} dashboard`,
      "compare the error rate with the week before",
      `roll back the latest ${part} change if errors doubled`
    ],
    question: [`Is the ${part} ready for the next step?`, `{lead} answered that it is ready once the error rate stays under ${rate}%`],
    risk: `the ${part} could slow down if traffic doubles`,
    decision: `changes to the ${part} ship behind a flag first`
  };
}

function pages(parts: readonly string[], count: number, start: number): PageSpec[] {
  return Array.from({ length: count }, (_, index) => {
    const kind = KINDS[index % KINDS.length];
    const topic = index % parts.length;
    const part = parts[topic];
    const purposes: Record<string, string> = {
      design: `how the ${part} works`, playbook: `the ${part} error rate doubles`, howto: `change the ${part} safely`,
      reference: `the settings of the ${part}`
    };
    return { title: `${cap(part)} ${KIND_LABELS[kind]} ${start + index}`, kind, topic: `t${topic}`, purpose: purposes[kind] };
  });
}

function files(rng: Rng, parts: readonly string[], count: number, masters: number): FileSpec[] {
  return Array.from({ length: count }, (_, index) => {
    const type = FILE_CYCLE[index % FILE_CYCLE.length];
    const topic = index % parts.length;
    const part = parts[topic];
    const rows = type === "sheet"
      ? [1, 2, 3, 4].map(week => `Week ${week}, ${rng.int(10, 990)} ${rng.pick(UNITS)}, error rate ${rng.int(1, 9) / 10}%`)
      : undefined;
    return {
      title: `${cap(part)} ${type === "doc" ? "working doc" : type === "pdf" ? "export" : type} ${index + 1}`,
      type, topic: `t${topic}`, status: FILE_STATUSES[index % FILE_STATUSES.length],
      ...(type === "doc" ? { kind: DOC_KINDS[index % DOC_KINDS.length] } : {}),
      purpose: `the ${part}`, ...(rows ? { rows } : {}), ...(index < masters ? { master: true } : {})
    };
  });
}

function project(rng: Rng, seed: ProjectSeed): Bank {
  const [first, second] = seed.owners;
  const parts = seed.parts;
  const issues: IssueSpec[] = Array.from({ length: 182 }, (_, index) => {
    const part = parts[index % parts.length];
    const [verb, verbs] = VERBS[Math.floor(index / parts.length) % VERBS.length];
    const suffix = SUFFIXES[Math.floor(index / (parts.length * VERBS.length)) % SUFFIXES.length];
    const status = STATUS_CYCLE[index % STATUS_CYCLE.length];
    return {
      topic: `t${index % parts.length}`, summary: `${verb} the ${part} ${suffix}`, what: `${verbs} the ${part} ${suffix}`,
      acceptance: `the ${part} passes its checks for a week`, status,
      ...(status === "blocked" ? { blockedBy: `waits on the ${parts[(index + 1) % parts.length]} change` } : {})
    };
  });
  return {
    key: seed.key, name: seed.name, project: true, owners: [first, second], tier: "internal",
    roles: { lead: [first], e1: [first], e2: [first], e3: [second], e4: [second] },
    fileOwner: "e1",
    goal: `the ${seed.name.toLowerCase()} reaches every customer with fewer errors`,
    status: [`${rng.int(3, 8)} of 10 milestones are done`, `the error rate is down to ${rng.int(2, 9) / 10}%`],
    topics: parts.map((part, index) => topicFor(rng, part, index)),
    issues,
    masterIssues: [1, 2, 3, 7],
    pages: pages(parts, 299, 1),
    files: files(rng, parts, 100, 10),
    channels: parts.slice(0, 5).map((part, index) => ({
      name: `${seed.key.toLowerCase()}-${slug(part)}`, topics: [`t${index}`], visibility: "public" as const,
      ...(index === 0 ? { agreements: [0, 3] } : index < 3 ? { agreements: [index] } : {})
    })),
    agreements: [
      `Agreed: {e1} ships the ${parts[0]} change behind a flag.`,
      `Decision: the ${parts[1]} keeps its error rate under 2%.`,
      `Let's go with weekly releases for the ${parts[2]}.`,
      `Approved: {e2} owns the ${parts[3]} dashboard.`
    ],
    trackedBy: 1
  };
}

function space(rng: Rng, seed: SpaceSeed): Bank {
  const parts = seed.parts;
  return {
    key: seed.key, name: seed.name, project: false, owners: seed.owners, tier: "internal",
    roles: { lead: [seed.owners[0]], e1: [seed.owners[0]], e2: [seed.owners[seed.owners.length - 1]] },
    fileOwner: "e1",
    topics: parts.map((part, index) => topicFor(rng, part, index)),
    pages: pages(parts, 310, 1),
    files: files(rng, parts, 30, 0),
    channels: [{ name: `${seed.key.toLowerCase()}-general`, topics: ["t0", "t1"], visibility: "public" }]
  };
}

export function genericBanks(rng: Rng): Bank[] {
  return [
    ...PROJECTS.map(seed => project(rng.stream(`project:${seed.key}`), seed)),
    ...SPACES.map(seed => space(rng.stream(`space:${seed.key}`), seed))
  ];
}
