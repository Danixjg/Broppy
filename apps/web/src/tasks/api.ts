// The one client the tasks surface talks to the API with. Every call carries the identity the page
// is showing: the demo persona when the page is in the demo, the session otherwise.

const API = "/api/brain";

export class ApiError extends Error {
  constructor(readonly status: number, readonly payload: unknown, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export type TaskStatus = { name: string; category: string | null };

export type TaskCard = {
  id: string;
  key: string;
  title: string;
  projectKey: string;
  projectName: string;
  status: TaskStatus;
  dueDate: string | null;
  priority: string | null;
  updatedAt: string;
  url: string;
  mine: boolean;
};

export type TaskColumn = { id: string; name: string; total: number; items: TaskCard[] };

export type TaskSummary = {
  open?: number;
  dueThisWeek?: number;
  overdue?: number;
  doneThisWeek?: { knownCount?: number; historyComplete?: boolean };
};

export type TaskPage = { nextCursor: string | null; hasMore: boolean; total?: number };

export type TaskListResponse = {
  summary?: TaskSummary;
  items?: TaskCard[];
  columns?: TaskColumn[];
  page?: TaskPage;
};

export type TaskLink = { id: string; title: string };

export type TaskDetail = TaskCard & {
  revision: string;
  description?: string;
  links?: TaskLink[];
  capabilities?: { edit?: boolean };
};

export type TransitionField = {
  id: string;
  name: string;
  type?: string;
  required?: boolean;
  supported?: boolean;
  allowedValues?: { id: string; name: string }[];
};

export type TaskTransition = {
  id: string;
  name: string;
  target?: { name?: string; category?: string };
  fields?: TransitionField[];
};

export type TransitionChoices = { taskRevision: string; transitions: TaskTransition[] };

export type CommandReceipt = {
  operationId?: string;
  state: "applied" | "uncertain" | "rejected" | "unavailable";
  outcome?: string;
  task?: TaskDetail;
  taskUnavailable?: boolean;
  fieldErrors?: Record<string, string>;
  transitions?: TaskTransition[];
};

export type CommandOptions = {
  method?: "GET" | "POST" | "PUT";
  headers?: Record<string, string>;
  body?: unknown;
};

const persona = () => (document.getElementById("user") as HTMLSelectElement | null)?.value ?? "";

export async function call<T>(path: string, options: CommandOptions = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", ...options.headers };
  const who = persona();
  if (who) headers["x-demo-user"] = who;
  const response = await fetch(API + path, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store"
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(response.status, null, "API returned an invalid response");
  }
  if (!response.ok) {
    const envelope = payload as { error?: unknown } | null;
    const message = typeof envelope?.error === "string" ? envelope.error : "Request failed";
    throw new ApiError(response.status, payload, message);
  }
  return payload as T;
}
