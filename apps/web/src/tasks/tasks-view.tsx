import { useEffect, useRef, useState } from "react";
import { Badge, Button, FieldError, Input, Label, Surface, TextField } from "@heroui/react";
import { isDemoAddress } from "../../answer.js";
import { changedFields, countText, countsText, dayText, detailPath, doneTileLabel, dueText, errorText,
  movesByColumn, nameText, pickDrop, priorityText, taskQuery } from "../lib/tasks.js";
import { ApiError, call, type CommandReceipt, type TaskCard, type TaskColumn, type TaskDetail, type TaskListResponse,
  type TaskSummary, type TransitionChoices, type TaskTransition } from "./api";
import { OPEN_DOC, OPEN_TASK, SHOW_ALL_TASKS, TASKS_CHANGED, WORKSPACE_LOADED, type OpenTaskDetail } from "./events";

type View = "list" | "board";
type Filters = { projectIds: string[]; mine: boolean; priority: string; status: string; due: string; q: string; preset: string };
type Draft = { summary: string; dueDate: string; priority: string };
type DragState = { id: string; revision: string; moves: Map<string, TaskTransition[]>; failed: boolean; loaded: boolean };
type Intent = { docId: string; signature: string; idempotencyKey: string; intentId: string; identity: number };

const emptyFilters = (): Filters => ({ projectIds: [], mine: false, priority: "", status: "", due: "any", q: "", preset: "" });
const emptyDraft = (): Draft => ({ summary: "", dueDate: "", priority: "" });
const PRIORITIES = ["Highest", "High", "Medium", "Low", "Lowest"];
const DUE_CHOICES: [string, string][] = [["any", "Any due date"], ["today", "Due today"], ["throughToday", "Through today"],
  ["thisWeek", "Due this week"], ["overdue", "Overdue"], ["none", "No due date"]];
const PRESET_CHOICES: [string, string][] = [["", "All tasks"], ["open", "Open"], ["dueThisWeek", "Due this week"],
  ["overdue", "Overdue"], ["doneThisWeek", "Done"]];
const draftBase = (detail: TaskDetail): Draft => ({ summary: detail.title ?? "", dueDate: detail.dueDate ?? "", priority: detail.priority ?? "" });
const isVisible = (element: HTMLElement) => element.offsetParent !== null;

const mergeStatuses = (previous: string[], response: TaskListResponse) => {
  const cards = (response.columns ?? []).flatMap(column => column.items ?? []).concat(response.items ?? []);
  const names = cards.map(card => card.status?.name)
    .filter((name): name is string => typeof name === "string" && name.trim() !== "");
  return [...new Set([...previous, ...names])];
};

export function TasksView() {
  const [view, setView] = useState<View>("list");
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [projects, setProjects] = useState<{ key: string; name: string }[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [summary, setSummary] = useState<TaskSummary | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [cards, setCards] = useState<TaskCard[]>([]);
  const [columns, setColumns] = useState<TaskColumn[]>([]);
  const [page, setPage] = useState<{ nextCursor: string | null; hasMore: boolean; total?: number }>({ nextCursor: null, hasMore: false });
  const [status, setStatus] = useState("");
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editNote, setEditNote] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [transitionNote, setTransitionNote] = useState("");
  const [choices, setChoices] = useState<TransitionChoices | null>(null);
  const [transitionId, setTransitionId] = useState("");
  const [transitionValues, setTransitionValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [savingCard, setSavingCard] = useState<{ id: string; label: string } | null>(null);
  const [discardArmed, setDiscardArmed] = useState(false);
  const [focusMoves, setFocusMoves] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<{ mode: string; documents: number; documentIds: string[] }>({ mode: "", documents: 0, documentIds: [] });

  const viewRef = useRef<View>("list");
  const filtersRef = useRef<Filters>(emptyFilters());
  const detailRef = useRef<TaskDetail | null>(null);
  const identityRef = useRef(0);
  const loadRef = useRef(0);
  const savingRef = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const intentRef = useRef<Intent | undefined>(undefined);
  const triggerRef = useRef<{ id: string; element?: HTMLElement } | undefined>(undefined);
  const deepLinkRef = useRef(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const movesRef = useRef<HTMLSelectElement | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  viewRef.current = view;
  filtersRef.current = filters;
  detailRef.current = detail;

  const dirty = detail ? Object.keys(changedFields(draftBase(detail), draft)).length > 0 : false;
  const filtered = filters.projectIds.length > 0 || filters.mine ||
    [filters.priority, filters.status, filters.q, filters.preset].some(value => value !== "") || filters.due !== "any";
  const nothingRead = workspace.mode === "live" && workspace.documents === 0;
  const emptyText = nothingRead ? "Jira tasks appear here once Broppy has read them."
    : filtered ? "No tasks match these filters." : "No Jira tasks here yet.";

  const loadProjects = async () => {
    try {
      const result = await call<{ projects: { key: string; name: string }[] }>("/v1/tasks/projects");
      setProjects((result.projects ?? []).filter(item => item && typeof item.key === "string" && item.key)
        .map(item => ({ key: item.key, name: typeof item.name === "string" && item.name ? item.name : item.key })));
    } catch {
      setProjects([]);
    }
  };

  const load = async (nextView: View, nextFilters: Filters, cursor?: string) => {
    const request = ++loadRef.current;
    const identity = identityRef.current;
    if (!cursor) setStatus("Loading tasks…");
    try {
      const params = taskQuery(nextView, nextFilters);
      if (cursor) params.set("cursor", cursor);
      const response = await call<TaskListResponse>(`/v1/tasks?${params}`);
      if (request !== loadRef.current || identity !== identityRef.current) return;
      setSummary(response.summary ?? {});
      setLoaded(true);
      setStatuses(previous => mergeStatuses(previous, response));
      setPage({ nextCursor: response.page?.nextCursor ?? null, hasMore: response.page?.hasMore === true, total: response.page?.total });
      if (cursor) setCards(previous => [...previous, ...(response.items ?? [])]);
      else if (nextView === "board") setColumns(response.columns ?? []);
      else setCards(response.items ?? []);
      setStatus("");
    } catch (error) {
      if (request !== loadRef.current || identity !== identityRef.current) return;
      if (error instanceof ApiError && error.status === 409) { await load(nextView, nextFilters); return; }
      setStatus(error instanceof ApiError ? errorText(error.payload) : "The tasks could not be loaded.");
    }
  };

  const loadTransitions = async (docId: string) => {
    const path = detailPath(docId);
    if (!path) return;
    try {
      const result = await call<TransitionChoices>(`${path}/transitions`);
      setChoices(result);
      setTransitionId(result.transitions?.[0]?.id ?? "");
      setTransitionValues({});
      setTransitionNote("");
    } catch (error) {
      setChoices(null);
      setTransitionId("");
      if (!(error instanceof ApiError && error.status === 404)) setTransitionNote("Jira's moves are unavailable right now.");
    }
  };

  const showDetail = (task: TaskDetail) => {
    setDetail(task);
    setUnavailable(false);
    setDraft(draftBase(task));
    setEditNote("");
    setFieldErrors({});
    setDiscardArmed(false);
    setChoices(null);
    setTransitionId("");
    setTransitionValues({});
    setTransitionNote("");
    if (task.capabilities?.edit === true && task.revision) void loadTransitions(task.id);
  };

  const showUnavailable = () => {
    setDetail(null);
    setUnavailable(true);
    setChoices(null);
    setDiscardArmed(false);
  };

  const openDetail = async (docId: string, options: { focus?: boolean } = {}) => {
    const identity = identityRef.current;
    const path = detailPath(docId);
    if (!path) { showUnavailable(); return; }
    setStatus("Loading task…");
    try {
      const task = await call<TaskDetail>(path);
      if (identity !== identityRef.current) return;
      setStatus("");
      showDetail(task);
      if (options.focus) requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
    } catch (error) {
      if (identity !== identityRef.current) return;
      setStatus("");
      if (error instanceof ApiError && error.status === 404) showUnavailable();
      else setStatus(error instanceof ApiError ? errorText(error.payload) : "The task could not be loaded.");
    }
  };

  const openDetailRef = useRef(openDetail);
  openDetailRef.current = openDetail;

  const closeDetail = () => {
    setDetail(null);
    setUnavailable(false);
    setChoices(null);
    setEditNote("");
    setFieldErrors({});
    setTransitionNote("");
    setDiscardArmed(false);
    const trigger = triggerRef.current;
    triggerRef.current = undefined;
    const back = trigger?.element && trigger.element.isConnected && isVisible(trigger.element) ? trigger.element
      : trigger?.id ? Array.from(document.querySelectorAll<HTMLElement>("[data-task-id]"))
        .find(item => item.dataset.taskId === trigger.id && isVisible(item)) : null;
    back?.focus({ preventScroll: true });
  };

  const intentFor = (docId: string, signature: string) => {
    const current = intentRef.current;
    if (current && current.docId === docId && current.signature === signature) return current;
    const fresh: Intent = {
      docId,
      signature,
      idempotencyKey: crypto.randomUUID(),
      intentId: crypto.randomUUID(),
      identity: identityRef.current
    };
    intentRef.current = fresh;
    return fresh;
  };

  const afterWrite = async (docId: string) => {
    if (detailRef.current?.id === docId) await openDetail(docId);
    await load(viewRef.current, filtersRef.current);
    document.dispatchEvent(new CustomEvent(TASKS_CHANGED));
  };

  const pollReceipt = async (operationId: string | undefined, docId: string, intent: Intent, note: (message: string) => void, delay = 5000) => {
    if (!operationId) { note("Jira did not confirm the change. Check the task again in a moment."); return; }
    await new Promise(resolve => setTimeout(resolve, delay));
    if (intentRef.current !== intent || intent.identity !== identityRef.current) return;
    try {
      const receipt = await call<CommandReceipt>(`/v1/task-operations/${encodeURIComponent(operationId)}`);
      if (receipt.state === "applied") {
        intentRef.current = undefined;
        setSavingCard(current => current?.id === docId ? null : current);
        await afterWrite(docId);
        note("Jira confirmed the change.");
        return;
      }
      if (receipt.state === "uncertain") { void pollReceipt(operationId, docId, intent, note, delay); return; }
      setSavingCard(current => current?.id === docId ? null : current);
      note(receipt.fieldErrors
        ? errorText({ error: { message: "Jira refused the change.", fieldErrors: receipt.fieldErrors } })
        : "Jira refused the change.");
    } catch {
      void pollReceipt(operationId, docId, intent, note, delay);
    }
  };

  const runCommand = async (command: {
    docId: string;
    url: string;
    method: "PUT" | "POST";
    revision: string;
    signature: string;
    body: Record<string, unknown>;
    note: (message: string) => void;
  }) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    command.note("Saving…");
    const intent = intentFor(command.docId, command.signature);
    try {
      const receipt = await call<CommandReceipt>(command.url, {
        method: command.method,
        headers: { "if-match": command.revision, "idempotency-key": intent.idempotencyKey },
        body: { ...command.body, clientIntentId: intent.intentId }
      });
      if (receipt.state === "uncertain") {
        command.note("Checking Jira…");
        void pollReceipt(receipt.operationId, command.docId, intent, command.note);
        return;
      }
      if (receipt.state === "applied") {
        intentRef.current = undefined;
        command.note("");
        await afterWrite(command.docId);
        return;
      }
      command.note("The change could not be saved.");
    } catch (error) {
      const payload = error instanceof ApiError ? error.payload : null;
      if (error instanceof ApiError && error.status === 412) {
        command.note("The task changed on Jira since you loaded it. Your draft is kept; reload the task to compare.");
        return;
      }
      if (error instanceof ApiError && error.status === 409 && Array.isArray((payload as { transitions?: unknown } | null)?.transitions)) {
        command.note("Jira's workflow changed; the moves below are refreshed.");
        await loadTransitions(command.docId);
        return;
      }
      const envelope = payload as { error?: { fieldErrors?: Record<string, string> } } | null;
      if (envelope?.error?.fieldErrors) setFieldErrors(envelope.error.fieldErrors);
      command.note(payload ? errorText(payload) : "The change could not be saved.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const saveEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!detail) return;
    const fields = changedFields(draftBase(detail), draft);
    if (!Object.keys(fields).length) { setEditNote("Nothing changed yet."); return; }
    const path = detailPath(detail.id);
    if (!path) return;
    await runCommand({
      docId: detail.id,
      url: path,
      method: "PUT",
      revision: detail.revision,
      signature: JSON.stringify([detail.revision, fields]),
      body: { fields },
      note: setEditNote
    });
  };

  const applyTransition = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!detail) return;
    if (!transitionId || !choices) { setTransitionNote("Choose a move first."); return; }
    const transition = choices.transitions.find(item => item.id === transitionId);
    if (!transition) { setTransitionNote("Choose a move first."); return; }
    const fields: Record<string, string> = {};
    const missing: string[] = [];
    for (const field of (transition.fields ?? []).filter(item => item.required === true)) {
      const value = transitionValues[field.id] ?? "";
      if (value) fields[field.id] = value;
      else missing.push(field.name);
    }
    if (missing.length) { setTransitionNote(`${missing.join(", ")} is required before Jira accepts the move.`); return; }
    const path = detailPath(detail.id);
    if (!path) return;
    await runCommand({
      docId: detail.id,
      url: `${path}/transitions`,
      method: "POST",
      revision: choices.taskRevision || detail.revision,
      signature: JSON.stringify([choices.taskRevision, transitionId, fields]),
      body: { transitionId, fields },
      note: setTransitionNote
    });
  };

  const moveByDrop = async (column: TaskColumn) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.failed) return;
    const drop = pickDrop(drag.moves.get(column.id) ?? []);
    if (drop.kind === "none") { setStatus(`No legal move to ${column.name}.`); return; }
    if (drop.kind === "pick") {
      setFocusMoves(drag.id);
      await openDetail(drag.id, { focus: true });
      return;
    }
    const path = detailPath(drag.id);
    if (!path) return;
    setSavingCard({ id: drag.id, label: "Saving" });
    const intent = intentFor(drag.id, JSON.stringify([drag.revision, drop.transition.id, {}]));
    try {
      const receipt = await call<CommandReceipt>(`${path}/transitions`, {
        method: "POST",
        headers: { "if-match": drag.revision, "idempotency-key": intent.idempotencyKey },
        body: { clientIntentId: intent.intentId, transitionId: drop.transition.id, fields: {} }
      });
      if (receipt.state === "uncertain") {
        setSavingCard({ id: drag.id, label: "Checking Jira…" });
        setStatus("Checking Jira…");
        void pollReceipt(receipt.operationId, drag.id, intent, setStatus);
        return;
      }
      if (receipt.state === "applied") {
        intentRef.current = undefined;
        if (detailRef.current?.id === drag.id) await openDetail(drag.id);
        await load(viewRef.current, filtersRef.current);
        document.dispatchEvent(new CustomEvent(TASKS_CHANGED));
        setStatus(`${drop.transition.name} applied.`);
        return;
      }
      setStatus("The move could not be saved.");
    } catch (error) {
      const payload = error instanceof ApiError ? error.payload : null;
      setStatus(error instanceof ApiError && error.status === 412
        ? "The task changed on Jira since the board loaded. Reload the task to compare."
        : payload ? errorText(payload) : "The move could not be saved.");
    } finally {
      setSavingCard(current => current?.id === drag.id ? null : current);
    }
  };

  const startDrag = async (event: React.DragEvent, card: TaskCard) => {
    dragRef.current = { id: card.id, revision: "", moves: new Map(), failed: false, loaded: false };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", card.id);
    const path = detailPath(card.id);
    if (!path) return;
    try {
      const result = await call<TransitionChoices>(`${path}/transitions`);
      if (dragRef.current?.id !== card.id) return;
      dragRef.current.revision = result.taskRevision ?? "";
      dragRef.current.moves = movesByColumn(result.transitions);
      dragRef.current.loaded = true;
    } catch {
      if (dragRef.current?.id !== card.id) return;
      dragRef.current.failed = true;
      dragRef.current.loaded = true;
      setStatus("Jira's moves are unavailable right now.");
    }
  };

  const endDrag = () => {
    dragRef.current = null;
    for (const cell of Array.from(document.querySelectorAll("#tasksBoard .drop-target"))) cell.classList.remove("drop-target");
  };

  const dragOver = (event: React.DragEvent, column: TaskColumn) => {
    const drag = dragRef.current;
    if (!drag?.loaded) return;
    if (!drag.moves.get(column.id)?.length) {
      setStatus(`No legal move to ${column.name}.`);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    event.currentTarget.classList.add("drop-target");
  };

  const dragLeave = (event: React.DragEvent) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.classList.remove("drop-target");
  };

  const dropOn = (event: React.DragEvent, column: TaskColumn) => {
    event.preventDefault();
    event.currentTarget.classList.remove("drop-target");
    void moveByDrop(column);
  };

  const trapFocus = (event: KeyboardEvent) => {
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>("a[href],button,input,select,textarea"))
      .filter(item => !(item as HTMLInputElement).disabled && isVisible(item));
    if (!focusable.length) return;
    const active = document.activeElement;
    if (!panel.contains(active)) { event.preventDefault(); focusable[0]?.focus(); return; }
    if ((event.shiftKey && active === focusable[0]) || (!event.shiftKey && active === focusable.at(-1))) {
      event.preventDefault();
      (event.shiftKey ? focusable.at(-1) : focusable[0])?.focus();
    }
  };

  useEffect(() => {
    const container = document.getElementById("tasksView");
    if (!container) return;
    const observer = new MutationObserver(() => {
      if (container.hidden) return;
      void loadProjects();
      void load(viewRef.current, filtersRef.current);
    });
    observer.observe(container, { attributes: true, attributeFilter: ["hidden"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const user = document.getElementById("user");
    if (!user) return;
    const onIdentity = () => {
      identityRef.current += 1;
      loadRef.current += 1;
      intentRef.current = undefined;
      triggerRef.current = undefined;
      setFilters(emptyFilters());
      setProjects([]);
      setStatuses([]);
      setSummary(null);
      setLoaded(false);
      setCards([]);
      setColumns([]);
      setPage({ nextCursor: null, hasMore: false });
      setStatus("");
      setDetail(null);
      setUnavailable(false);
      setChoices(null);
      setEditNote("");
      setFieldErrors({});
      setTransitionNote("");
      setDiscardArmed(false);
      setFocusMoves(null);
    };
    user.addEventListener("change", onIdentity);
    return () => user.removeEventListener("change", onIdentity);
  }, []);

  useEffect(() => {
    const onWorkspace = (event: Event) => {
      const loaded = (event as CustomEvent<{ mode?: string; documents?: number; documentIds?: string[] }>).detail;
      setWorkspace({ mode: loaded?.mode ?? "", documents: loaded?.documents ?? 0, documentIds: loaded?.documentIds ?? [] });
      applyDeepLink();
    };
    document.addEventListener(WORKSPACE_LOADED, onWorkspace);
    return () => document.removeEventListener(WORKSPACE_LOADED, onWorkspace);
  }, []);

  const applyDeepLink = () => {
    if (deepLinkRef.current) return;
    const params = new URLSearchParams(location.search);
    if (params.get("view") !== "tasks") return;
    deepLinkRef.current = true;
    document.querySelector<HTMLElement>('[data-view="tasks"]')?.click();
    const task = params.get("task");
    if (task) document.dispatchEvent(new CustomEvent<OpenTaskDetail>(OPEN_TASK, { detail: { id: task } }));
  };

  useEffect(() => {
    const onOpenTask = (event: Event) => {
      const requested = (event as CustomEvent<OpenTaskDetail>).detail;
      if (!requested?.id) return;
      triggerRef.current = { id: requested.id, element: requested.element };
      void openDetailRef.current(requested.id);
    };
    const onShowAll = () => {
      const seeded = { ...emptyFilters(), mine: true, due: "throughToday" };
      setFilters(seeded);
      void load("list", seeded);
    };
    document.addEventListener(OPEN_TASK, onOpenTask);
    document.addEventListener(SHOW_ALL_TASKS, onShowAll);
    return () => {
      document.removeEventListener(OPEN_TASK, onOpenTask);
      document.removeEventListener(SHOW_ALL_TASKS, onShowAll);
    };
  }, []);

  useEffect(() => {
    if (!focusMoves || !choices) return;
    const select = movesRef.current;
    if (!select || select.disabled || select.options.length === 0) return;
    select.focus();
    setFocusMoves(null);
  }, [focusMoves, choices]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!detail && !unavailable) return;
      if (event.key === "Escape") {
        if (dirty && !discardArmed) {
          setDiscardArmed(true);
          setStatus("Close anyway? Unsaved edits would be lost. Press Escape again to close.");
          return;
        }
        closeDetail();
        return;
      }
      if (event.key === "Tab") trapFocus(event);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [detail, unavailable, dirty, discardArmed]);

  const switchView = (next: View) => {
    if (next === view) return;
    setView(next);
    void load(next, filters);
  };

  const applyFilters = (next: Filters) => {
    setFilters(next);
    void load(viewRef.current, next);
  };

  const clearFilters = () => {
    const cleared = emptyFilters();
    setFilters(cleared);
    void load(viewRef.current, cleared);
  };

  const tiles = summary ? [
    ["Open", countText(summary.open)],
    ["Due this week", countText(summary.dueThisWeek)],
    ["Overdue", countText(summary.overdue)],
    [doneTileLabel(summary), countText(summary.doneThisWeek?.knownCount)]
  ] : [];

  const requiredFields = (choices?.transitions.find(item => item.id === transitionId)?.fields ?? []).filter(field => field.required === true);
  const editable = detail?.capabilities?.edit === true && Boolean(detail.revision);

  return (
    <div className="tasks-surface">
      <div className="view-heading">
        <p className="eyebrow">JIRA TASKS</p>
        <h1 id="tasksHeading">Tasks</h1>
        <p>Everything Jira reports that this identity can see. Counts and board columns come from the API&apos;s one authorized snapshot; Broppy doesn&apos;t recount, re-bucket or estimate them.</p>
      </div>

      <p id="tasksCountsText" className="sr-only" role="status">{summary ? countsText(summary) : ""}</p>
      <div id="tasksCounts" className="health-grid">
        {tiles.map(([label, number]) => (
          <Surface key={label} className="surface">
            <strong>{number}</strong>
            <p className="muted">{label}</p>
          </Surface>
        ))}
      </div>

      <div className="toolbar">
        <div role="group" aria-label="List or board">
          <Button type="button" id="tasksListView" className="secondary-button" variant="secondary"
            aria-pressed={view === "list"} onPress={() => switchView("list")}>List</Button>
          <Button type="button" id="tasksBoardView" className="secondary-button" variant="secondary"
            aria-pressed={view === "board"} onPress={() => switchView("board")}>Board</Button>
        </div>
        <Button type="button" id="tasksClear" variant="ghost" onPress={clearFilters}>Clear filters</Button>
        <span id="tasksStatus" role="status" className="muted">{status}</span>
      </div>

      <form id="tasksFilterForm" className="audit-search" onSubmit={event => event.preventDefault()}>
        <div className="task-filter-row">
          <label>Projects
            <select id="tasksProjects" aria-label="Projects" multiple size={4} value={filters.projectIds}
              onChange={event => applyFilters({ ...filters, projectIds: Array.from(event.target.selectedOptions).map(option => option.value).filter(Boolean) })}>
              <option value="">All projects</option>
              {projects.map(project => <option key={project.key} value={project.key}>{project.name}</option>)}
            </select>
          </label>
          <label className="audit-toggle">
            <input id="tasksMine" type="checkbox" checked={filters.mine}
              onChange={event => applyFilters({ ...filters, mine: event.target.checked })} />Mine only
          </label>
          <label>Priority
            <select id="tasksPriority" aria-label="Priority" value={filters.priority}
              onChange={event => applyFilters({ ...filters, priority: event.target.value })}>
              <option value="">All priorities</option>
              {PRIORITIES.map(priority => <option key={priority} value={priority}>{priority}</option>)}
            </select>
          </label>
          <label>Status
            <select id="tasksStatusFilter" aria-label="Status" value={filters.status}
              onChange={event => applyFilters({ ...filters, status: event.target.value })}>
              <option value="">All statuses</option>
              {statuses.map(status => <option key={status} value={status}>{status}</option>)}
            </select>
          </label>
          <label>Due
            <select id="tasksDue" aria-label="Due" value={filters.due}
              onChange={event => applyFilters({ ...filters, due: event.target.value })}>
              {DUE_CHOICES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>Show
            <select id="tasksPreset" aria-label="Show" value={filters.preset}
              onChange={event => applyFilters({ ...filters, preset: event.target.value })}>
              {PRESET_CHOICES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>Search
            <input id="tasksSearch" type="search" maxLength={200} value={filters.q} placeholder="Words in a key, title or project"
              autoComplete="off"
              onChange={event => {
                const next = { ...filters, q: event.target.value };
                setFilters(next);
                clearTimeout(searchTimer.current);
                searchTimer.current = setTimeout(() => { void load(viewRef.current, next); }, 250);
              }} />
          </label>
        </div>
      </form>

      <div id="tasksList" hidden={view !== "list"}>
        {cards.length === 0 ? loaded ? <p className="empty">{emptyText}</p> : null : cards.map(card => (
          <TaskCardView key={card.id} card={card} variant="list" saving={savingCard?.id === card.id ? savingCard.label : undefined}
            onOpen={() => { triggerRef.current = { id: card.id }; void openDetail(card.id); }} />
        ))}
        {page.hasMore && page.nextCursor ? (
          <Button type="button" className="show-more" variant="ghost"
            onPress={() => void load(view, filters, page.nextCursor ?? undefined)}>Show more tasks</Button>
        ) : null}
      </div>

      <div id="tasksBoard" className="health-grid" hidden={view !== "board"}>
        {columns.length === 0 ? loaded ? <p className="empty">{emptyText}</p> : null : columns.map(column => (
          <Surface key={column.id} className="surface board-column"
            onDragOver={event => dragOver(event, column)}
            onDragLeave={dragLeave}
            onDrop={event => dropOn(event, column)}>
            <h2>{column.name} <span className="muted">{countText(column.total)}</span></h2>
            <div className="stack">
              {column.items.length === 0 ? <p className="empty">No tasks</p> : column.items.map(card => (
                <TaskCardView key={card.id} card={card} variant="board" saving={savingCard?.id === card.id ? savingCard.label : undefined}
                  onOpen={() => { triggerRef.current = { id: card.id }; void openDetail(card.id); }}
                  onDragStart={event => void startDrag(event, card)} onDragEnd={endDrag} />
              ))}
            </div>
          </Surface>
        ))}
      </div>

      <div id="tasksDetail" className="selected-detail" ref={panelRef} hidden={!detail && !unavailable}>
        {detail ? (
          <>
            <Button type="button" className="task-detail-close" variant="ghost" size="sm" onPress={closeDetail}>Close</Button>
            <p className="eyebrow">{["Jira", detail.key ?? "", nameText(detail.status?.name)].join(" · ")}</p>
            <h3 ref={headingRef} tabIndex={-1}>{nameText(detail.title)}</h3>
            <p className="detail-meta">{[
              detail.dueDate ? `Due ${dayText(detail.dueDate)}` : dueText(detail.dueDate),
              detail.priority ? `${detail.priority} priority` : priorityText(detail.priority)
            ].join(" · ")}</p>
            {detail.mine === true ? <Badge className="badge min-h-0 min-w-0" variant="soft" color="accent">Mine</Badge> : null}
            {detail.description ? <p>{detail.description}</p> : null}
            {detail.links?.length ? (
              <div className="linked-items">
                <strong>Linked items</strong>
                {detail.links.map(link => workspace.documentIds.includes(link.id)
                  ? <Button key={link.id} type="button" variant="ghost" className="text-button"
                      onPress={() => document.dispatchEvent(new CustomEvent(OPEN_DOC, { detail: { id: link.id } }))}>
                      {nameText(link.title)}
                    </Button>
                  : <span key={link.id}>{nameText(link.title)}</span>)}
              </div>
            ) : null}
            {isDemoAddress(detail.url)
              ? <p className="muted demo-note">Demo document: there&apos;s no live Jira page.</p>
              : <a className="text-button" href={detail.url} target="_blank" rel="noopener noreferrer">Open in Jira ↗</a>}

            {editable ? (
              <form id="tasksEditForm" className="stack task-edit" onSubmit={event => void saveEdit(event)}>
                <TextField.Root name="summary" maxLength={250} value={draft.summary}
                  onChange={value => setDraft(current => ({ ...current, summary: value }))}>
                  <Label>Summary</Label>
                  <Input />
                  {fieldErrors.summary ? <FieldError>{fieldErrors.summary}</FieldError> : null}
                </TextField.Root>
                <TextField.Root name="dueDate" type="date" value={draft.dueDate}
                  onChange={value => setDraft(current => ({ ...current, dueDate: value }))}>
                  <Label>Due date</Label>
                  <Input />
                  {fieldErrors.dueDate ? <FieldError>{fieldErrors.dueDate}</FieldError> : null}
                </TextField.Root>
                <div className="task-field">
                  <label htmlFor="tasksEditPriority">Priority</label>
                  <select id="tasksEditPriority" className="task-select" name="priority" value={draft.priority}
                    onChange={event => setDraft(current => ({ ...current, priority: event.target.value }))}>
                    <option value="">No priority</option>
                    {PRIORITIES.map(priority => <option key={priority} value={priority}>{priority}</option>)}
                  </select>
                </div>
                {fieldErrors.priority ? <FieldError>{fieldErrors.priority}</FieldError> : null}
                <Button type="submit" variant="primary" isDisabled={saving}>Save changes</Button>
                <span className="muted task-edit-note">{editNote}</span>
              </form>
            ) : null}

            {editable ? (
              <form id="taskTransitionsForm" className="stack task-transitions" onSubmit={event => void applyTransition(event)}>
                <div className="task-field">
                  <label htmlFor="tasksMoveTo">Move to</label>
                  <select id="tasksMoveTo" className="task-select" name="transition" ref={movesRef} value={transitionId}
                    disabled={!choices || choices.transitions.length === 0}
                    onChange={event => { setTransitionId(event.target.value); setTransitionValues({}); }}>
                    {choices?.transitions.map(transition => <option key={transition.id} value={transition.id}>{nameText(transition.name)}</option>)}
                  </select>
                </div>
                <div className="stack transition-fields">
                  {requiredFields.map(field => (
                    <div className="task-field" key={field.id}>
                      <label htmlFor={`tasksField-${field.id}`}>{field.name}</label>
                      {field.supported === false ? <p className="muted">This must be set in Jira.</p> : (
                        <select id={`tasksField-${field.id}`} className="task-select" name={field.id}
                          value={transitionValues[field.id] ?? ""}
                          onChange={event => setTransitionValues(current => ({ ...current, [field.id]: event.target.value }))}>
                          <option value="">Choose a {String(field.name).toLowerCase()}</option>
                          {(field.allowedValues ?? []).map(value => <option key={value.id} value={value.id}>{value.name}</option>)}
                        </select>
                      )}
                    </div>
                  ))}
                </div>
                <Button type="submit" variant="primary" isDisabled={saving || !choices}>Move</Button>
                <span className="muted task-transitions-note">{transitionNote}</span>
              </form>
            ) : null}
          </>
        ) : unavailable ? (
          <>
            <Button type="button" className="task-detail-close" variant="ghost" size="sm" onPress={closeDetail}>Close</Button>
            <h3 ref={headingRef} tabIndex={-1}>Task unavailable.</h3>
            <p className="muted">Broppy couldn&apos;t open it. It may not exist, or this identity may not have access to it.</p>
          </>
        ) : null}
      </div>
    </div>
  );
}

type TaskCardViewProps = {
  card: TaskCard;
  variant: "list" | "board";
  saving?: string;
  onOpen: () => void;
  onDragStart?: (event: React.DragEvent) => void;
  onDragEnd?: () => void;
};

function TaskCardView({ card, variant, saving, onOpen, onDragStart, onDragEnd }: TaskCardViewProps) {
  const due = card.dueDate ? `Due ${dayText(card.dueDate)}` : dueText(card.dueDate);
  const priority = card.priority ? `${card.priority} priority` : priorityText(card.priority);
  const meta = variant === "board"
    ? [card.key ?? "", due].join(" · ")
    : [card.key ?? "", card.projectKey ?? "", due, priority].join(" · ");
  return (
    <Button type="button" variant="secondary" className="activity-item flex h-auto w-full flex-col items-start gap-1 whitespace-normal text-left"
      data-task-id={card.id} onPress={onOpen}>
      <span className="item-title">{nameText(card.title)}</span>
      <span className="item-meta">{meta}</span>
      <span className="flex flex-wrap items-center gap-1">
        <span className="status-badge">{nameText(card.status?.name)}</span>
        {card.mine === true ? <span className="badge">Mine</span> : null}
        {saving ? <span className="badge task-saving">{saving}</span> : null}
      </span>
      {variant === "board" ? (
        <span className="drag-handle" draggable title="Drag to another column" aria-hidden="true"
          onDragStart={onDragStart} onDragEnd={onDragEnd}>⠿</span>
      ) : null}
    </Button>
  );
}
