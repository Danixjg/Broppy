// The rules the generated dataset follows, shared by the generator and its validator.
import type { SourceDocument, User } from "../../packages/types/src/index.js";
import mockDocuments from "../mock/documents.json" with { type: "json" };
import mockUsers from "../mock/users.json" with { type: "json" };

/** Fixture dates are written as of this moment; the loader moves them forward to the demo day. */
export const FIXTURE_NOW = Date.parse("2026-09-30T00:00:00.000Z");
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const MAX_AGE_HOURS = 120 * 24;
export const DEFAULT_SEED = 20261016;

export type Scale = "demo" | "brief";
export type PersonaId = "ravi" | "maya" | "alex" | "david" | "nur" | "wei";
export const PERSONA_IDS: PersonaId[] = ["ravi", "maya", "alex", "david", "nur", "wei"];

export const PERSONAS = mockUsers as unknown as User[];

/** The groups each persona gains in the generated set, on top of those in users.json. */
export const PERSONA_GROUPS: Record<PersonaId, string[]> = {
  ravi: ["platform", "sre"],
  maya: ["eng-leads", "mobile", "platform"],
  alex: [],
  david: ["data", "platform"],
  nur: ["legal", "risk"],
  wei: []
};

/** How many generated items each persona may open, at demo scale. */
export const PERSONA_VIEW_RANGES: Record<PersonaId, [number, number]> = {
  david: [230, 295],
  ravi: [170, 225],
  maya: [250, 315],
  nur: [90, 125],
  alex: [30, 45],
  wei: [10, 20]
};

export const TEAMS = [
  "platform", "sre", "mobile", "data", "product", "design", "risk", "legal", "people-ops", "finance", "eng-leads",
  "interns"
];
/** Groups that belong to the hand-written set; the generated set never grants to them. */
export const NEVER_GRANTED = ["payments", "security", "fraud-ops", "compliance"];

export const JIRA_STATUSES = ["open", "in progress", "in review", "blocked", "done"] as const;
export type JiraStatus = typeof JIRA_STATUSES[number];
export const PAGE_STATUSES = ["final", "draft"] as const;
export const FILE_STATUSES = ["draft", "in review", "final", "superseded"] as const;
export type FileStatus = typeof FILE_STATUSES[number];

export type FileType = "doc" | "sheet" | "slides" | "pdf";
export const MIME_TYPES: Record<FileType, string> = {
  doc: "application/vnd.google-apps.document",
  sheet: "application/vnd.google-apps.spreadsheet",
  slides: "application/vnd.google-apps.presentation",
  pdf: "application/pdf"
};
export const FILE_URLS: Record<FileType, string> = {
  doc: "https://docs.example/document/d/",
  sheet: "https://docs.example/spreadsheets/d/",
  slides: "https://docs.example/presentation/d/",
  pdf: "https://drive.example/file/d/"
};

/**
 * Words the generated set never uses, because the hand-written story and the negative test depend on them. The last
 * four are words the search counts as story words: switch means cutover and migration, launch means cutover, outage
 * means incident and failover, and recovery means failover.
 */
export const FORBIDDEN_WORDS = new Set([
  "payment", "payments", "pay", "cutover", "migration", "migrations", "database", "databases", "ledger", "postgres",
  "replica", "failover", "settlement", "settlements", "reconciliation", "chargeback", "chargebacks", "gateway",
  "runbook", "runbooks", "incident", "incidents", "breach", "breaches", "fraud", "vendor", "vendors",
  "switch", "launch", "outage", "recovery",
  "zebra", "q9", "offsite"
]);
/** Words items that Alex or Wei can open never use, so nothing restricted shows through to them. */
export const ALEX_WEI_WORDS = new Set(["security", "incident", "report", "reports", "breach", "q3", "onboarding", "notes"]);

export const RESERVED_KEYS = new Set(["PAY", "DB", "SEC", "SETL", "OPS", "payment-gateway"]);
export const RESERVED_CHANNELS = new Set([
  "payments-cutover", "fraud-private", "fraud-ops-private", "sec-incident", "vendor-integration", "db-migration",
  "db-oncall", "db-planning"
]);
const HANDWRITTEN = mockDocuments as unknown as SourceDocument[];
export const HANDWRITTEN_TITLES = new Set(HANDWRITTEN.map(doc => doc.title));

/** Abbreviations with a full stop inside a sentence, which the app's sentence split would cut in two. */
export const ABBREVIATIONS = /(?<![A-Za-z])(?:e\.g|i\.e|etc|vs|approx|Mr|Mrs|Ms|Dr|No)\.(?=\s|$)/;
export const MONTHS = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/;

/** Demo and brief sizes, per platform. */
export const BRIEF_TARGETS = {
  projects: 30, spaces: 50, confluence: 12_000, jira: 4_500, slack: 200, drive: 3_000, colleagues: 600
};
