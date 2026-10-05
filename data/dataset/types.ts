// The shape of a content bank: one area's topics, items and the people they name, written as data.
import type { FileStatus, FileType, JiraStatus } from "./rules.js";

export type Tier = "open" | "internal" | "restricted";
export type PageKind = "design" | "decision" | "playbook" | "meeting" | "howto" | "reference" | "policy" | "announcement";
export type DocKind = "plan" | "proposal" | "spec" | "guide" | "checklist" | "policy" | "summary" | "contract" | "brief";

/** One subject inside an area. Facts are clauses, written to read well after "{name} confirmed that". */
export interface Topic {
  id: string;
  name: string;
  facts: string[];
  /** Imperative clauses, for playbooks, guides and checklists. */
  steps?: string[];
  /** A question, and the answer as a full sentence without its full stop. */
  question?: [string, string];
  risk?: string;
  /** What was decided, as a clause; decision records and meeting summaries quote it. */
  decision?: string;
}

/** Who may open an item, when it differs from its area's default. */
export interface Access {
  /** Brain groups, in place of the area's owners. */
  groups?: string[];
  /** Readers granted by name: roles (c1-c5, m1, m2) or "wei". */
  users?: string[];
  /** The page or issue is restricted to these teams: Confluence page viewers or Jira issue viewers. */
  restrictTo?: string[];
  /** Slack and Drive: exactly these readers, as teams, roles or persona ids. */
  members?: string[];
  tier?: Tier;
  public?: boolean;
  /** VEND: shared with the partner, Wei Ming and the two partner contractors. */
  partner?: boolean;
  /** Drive: the owner's role. */
  owner?: string;
}

export interface IssueSpec {
  topic: string;
  summary: string;
  /** What the issue does, after its key: "adds 24 runners to the second rack". */
  what: string;
  acceptance: string;
  status: JiraStatus;
  /** For a blocked issue, what it waits on, after its key: "waits on finance approval for the host order". */
  blockedBy?: string;
  access?: Access;
}

export interface PageSpec {
  title: string;
  kind: PageKind;
  topic: string;
  status?: "final" | "draft";
  /** What the page covers, as a phrase: "how jobs move to the new runner pool". */
  purpose?: string;
  /** Sentences the page always says, after its opening line. */
  say?: string[];
  access?: Access;
}

export interface FileSpec {
  title: string;
  type: FileType;
  kind?: DocKind;
  topic: string;
  status: Exclude<FileStatus, "superseded">;
  purpose?: string;
  /** Sheets: one row per line, without "Row N:". */
  rows?: string[];
  /** Linked from the master page; other files hang off an issue. */
  master?: boolean;
  /** Sentences the file always says, after its opening line. */
  say?: string[];
  access?: Access;
}

export interface ChannelSpec {
  name: string;
  topics: string[];
  visibility: "public" | "private";
  access?: Access;
  /** Indexes into the bank's agreements. */
  agreements?: number[];
  /** Lines the channel always has. */
  say?: string[];
  /** The channel's progress, as a clause after "Status:"; without it, a measured fact of its topics. */
  status?: string;
}

export interface Copies {
  /** An older copy under the same title, marked superseded, with some facts changed. */
  superseded: Array<{ title: string; older: Array<[string, string]> }>;
  /** A copy under another title, with one or two sentences changed. */
  near: Array<{ of: string; title: string; changes: Array<[string, string]> }>;
}

export interface Bank {
  key: string;
  name: string;
  project: boolean;
  owners: string[];
  tier: Tier;
  public?: boolean;
  /** Role -> the teams the colleague must be in. */
  roles: Record<string, string[]>;
  /** Readers granted by name on every item (INTERN's mentors). */
  grants?: string[];
  /** VEND: the partner's readers, who see the project's space and Jira project but only items shared with them. */
  partner?: string[];
  /** The role that owns Drive files by default. */
  fileOwner: string;
  /** Who may open the master page, when it differs from the area's default. */
  masterAccess?: Access;
  goal?: string;
  status?: string[];
  topics: Topic[];
  issues?: IssueSpec[];
  masterIssues?: number[];
  pages: PageSpec[];
  files: FileSpec[];
  channels: ChannelSpec[];
  /** Full sentences; the first is quoted word for word by the issue numbered trackedBy. */
  agreements?: string[];
  trackedBy?: number;
  copies?: Copies;
}
