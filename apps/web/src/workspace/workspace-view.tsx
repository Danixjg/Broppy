import { useEffect, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { isDemoAddress, looksLikeAuditQuestion, quotedRanges } from "../../answer.js";
import { chosenProject, documentStatus, formatDate, linkedTask, omittedNotes, safeText, safeUrl,
  searchMatches, sentencesOf, showMoreLabel, sourceName, taskIsDone, visibleItems } from "../lib/workspace.js";
import { traceDetails } from "../lib/trace.js";
import { PersonalWidget } from "../tasks/personal-widget";
import { IDENTITY_CHANGED, OPEN_DOC, SEARCH_AUDIT, SHOW_TRACE, WORKSPACE_DATA, WORKSPACE_LOADED, WORKSPACE_RELOAD,
  type AuditSearch, type OpenTaskDetail, type TraceRequest, type WorkspaceIdentity } from "../tasks/events";
import { AnswerView } from "./answer-view";
import { SuggestionCard, type ReviewCommand } from "./suggestion-card";
import { ApiError, askApi, catchUpApi, createTaskApi, loadWorkspace, markDoneApi, post, reviewCommitment, traceApi,
  type AnswerResult, type CatchUpResponse, type ChatTurn, type Citation, type QueryResponse, type TraceEntry,
  type WorkspaceDocument, type WorkspaceDuplicate, type WorkspacePayload } from "./api";

type Selection = { docId: string; quotes: string[] };
type Turn = { id: number; question: string; result?: QueryResponse; error?: string };
type Notice = { text: string; retry?: boolean; link?: { href: string; text: string } };
type CatchUpState = { kind: "pending" } | { kind: "empty" } | { kind: "error"; text: string } | { kind: "result"; result: CatchUpResponse };
type TraceState = { traceId: string; entries: TraceEntry[]; error?: string };

const LISTS = { slack: "slackList", jira: "jiraList", drive: "driveList", sources: "allSources" };
const LANDING = ["master", "activity", "files"];
const LANDING_TARGETS: Record<string, string> = { master: "docHeading", activity: "slackTitle", files: "driveList" };

const shellStatus = (message: string) => {
  const element = document.getElementById("globalStatus");
  if (element) element.textContent = message;
};

const scrollTo = (element: Element | null) => {
  element?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
};

const messageOf = (error: unknown, fallback: string) => error instanceof ApiError ? error.message : fallback;

const readStored = (key: string) => {
  try { return localStorage.getItem(key); } catch { return null; }
};

const storeValue = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch { /* The choice is only remembered when storage works. */ }
};

export function WorkspaceView() {
  const [payload, setPayload] = useState<WorkspacePayload | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Selection | null>(null);
  const [notice, setNotice] = useState<Notice>({ text: "Loading accessible documents…" });
  const [role, setRole] = useState<"member" | "admin" | "compliance">("member");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [landing, setLanding] = useState(() => {
    const stored = readStored("brain-landing");
    return stored && LANDING.includes(stored) ? stored : "master";
  });
  const [chatOpen, setChatOpen] = useState(true);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [asking, setAsking] = useState(false);
  const [queryStatus, setQueryStatus] = useState("");
  const [catchUpState, setCatchUpState] = useState<CatchUpState | null>(null);
  const [traceState, setTraceState] = useState<TraceState | null>(null);
  const [previewMerge, setPreviewMerge] = useState<string | null>(null);
  const [busyDoc, setBusyDoc] = useState<string | null>(null);

  const payloadRef = useRef<WorkspacePayload | null>(null);
  const projectRef = useRef<string | null>(null);
  const selectedRef = useRef<Selection | null>(null);
  const roleRef = useRef<"member" | "admin" | "compliance">("member");
  const historyRef = useRef<ChatTurn[]>([]);
  const identityRef = useRef(0);
  const loadRef = useRef(0);
  const deepLinkRef = useRef(false);
  const focusHeadingRef = useRef(false);
  const pendingFocus = useRef<{ id: string; index: number } | null>(null);
  const turnIdRef = useRef(0);
  const landingAppliedRef = useRef(false);
  const landingRef = useRef(landing);

  const documents = payload?.documents ?? [];
  const capabilities = payload?.capabilities ?? {};
  const live = capabilities.mode === "live";
  const nothingRead = documents.length === 0 && live;

  const openDoc = (doc: WorkspaceDocument, quotes: string[] = [], focus = false) => {
    selectedRef.current = { docId: doc.docId, quotes };
    focusHeadingRef.current = focus;
    setSelected({ docId: doc.docId, quotes });
  };

  const currentProject = payload?.projects.find(item => item.key === project);
  const master = currentProject ? documents.find(doc => doc.docId === currentProject.masterDocId) : undefined;
  const projectDocIds = currentProject ? currentProject.docIds : null;

  const filtered = (source?: string) => documents.filter(doc =>
    (!source || doc.source === source)
    && (!projectDocIds || projectDocIds.includes(doc.docId))
    && searchMatches(doc, search));

  const slackDocs = filtered("slack");
  const jiraDocs = filtered("jira");
  const driveDocs = filtered("drive");
  const sourceDocs = filtered();

  const load = async () => {
    const request = ++loadRef.current;
    const identity = identityRef.current;
    setNotice({ text: "Loading accessible documents…" });
    try {
      const result = await loadWorkspace();
      if (request !== loadRef.current || identity !== identityRef.current) return;
      payloadRef.current = result;
      setPayload(result);
      const mode = result.capabilities?.mode ?? "";
      const badge = document.getElementById("workspaceMode");
      if (badge) badge.textContent = mode === "live" ? "Live workspace" : mode === "demo" ? "Demo workspace" : "Workspace";
      const keys = result.projects.map(item => item.key);
      const next = chosenProject(projectRef.current, readStored("brain-project"), keys);
      projectRef.current = next;
      setProject(next);
      document.dispatchEvent(new CustomEvent(WORKSPACE_LOADED, {
        detail: { mode, documents: result.documents.length, documentIds: result.documents.map(doc => doc.docId) }
      }));
      document.dispatchEvent(new CustomEvent(WORKSPACE_DATA, { detail: result }));
      if (!result.documents.length && mode === "live") {
        setNotice(roleRef.current === "admin"
          ? { text: "Broppy hasn't read anything yet.", link: { href: "./setup.html?step=read", text: "Connect a tool or choose what Broppy reads" } }
          : { text: "Broppy hasn't read anything you can see yet. Your admin connects tools and chooses what Broppy reads." });
      } else {
        setNotice({ text: `${result.documents.length} accessible sources · Contents and links are limited to this identity.${result.importNotice ? ` ${result.importNotice}` : ""}` });
      }
      const open = selectedRef.current;
      if (open) {
        const doc = result.documents.find(item => item.docId === open.docId);
        if (doc) setSelected({ docId: doc.docId, quotes: open.quotes });
        else { selectedRef.current = null; setSelected(null); }
      }
      await applyDeepLink(result);
      if (!landingAppliedRef.current) {
        landingAppliedRef.current = true;
        if (landingRef.current !== "master" || window.innerWidth <= 700) {
          requestAnimationFrame(() => scrollTo(document.getElementById(LANDING_TARGETS[landingRef.current])));
        }
      }
    } catch (error) {
      if (request !== loadRef.current || identity !== identityRef.current) return;
      setNotice({
        text: error instanceof ApiError && error.status === 401 ? "Log in to view your accessible documents." : messageOf(error, "The workspace could not be loaded."),
        retry: !(error instanceof ApiError && error.status === 401)
      });
    }
  };

  const applyDeepLink = async (result: WorkspacePayload) => {
    if (deepLinkRef.current) return;
    const params = new URLSearchParams(location.search);
    if (params.get("view") === "tasks") return;
    if (!["task", "ask", "doc", "proposal", "project"].some(key => params.has(key))) return;
    deepLinkRef.current = true;
    const requested = params.get("project");
    if (requested && !result.projects.some(item => item.key === requested)) {
      shellStatus("The linked project is unavailable to this identity.");
      return;
    }
    const proposal = result.commitments.find(item => item.id === params.get("proposal"));
    const wanted = params.get("doc");
    const doc = wanted ? result.documents.find(item => item.docId === wanted)
      : proposal?.issueDocId ? result.documents.find(item => item.docId === proposal.issueDocId)
      : linkedTask(result.documents, params.get("task") ?? "");
    const holder = doc ? result.projects.find(item => item.docIds.includes(doc.docId)) : undefined;
    if (requested) { projectRef.current = requested; setProject(requested); }
    else if (holder) { projectRef.current = holder.key; setProject(holder.key); }
    if (doc) openDoc(doc, [], true);
    else if (proposal) {
      const holder = result.projects.find(item => item.docIds.includes(proposal.threadDocId));
      if (holder) { projectRef.current = holder.key; setProject(holder.key); }
      requestAnimationFrame(() => {
        const card = document.querySelector<HTMLElement>(`[data-proposal-id="${proposal.id}"]`);
        card?.focus();
        scrollTo(card);
      });
    } else if (params.has("task")) {
      const term = (params.get("task") ?? "").slice(0, 200);
      setSearch(term);
      const input = document.getElementById("search") as HTMLInputElement | null;
      if (input) input.value = term;
      shellStatus("Searching your accessible sources for the linked task title.");
    } else if (params.has("doc") || params.has("proposal")) {
      shellStatus("The linked item is unavailable to this identity.");
    }
    const asked = params.get("ask");
    if (asked && asked.length <= 500) {
      if (!requested) { projectRef.current = null; setProject(null); }
      await ask(asked);
    }
  };

  const ask = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = ++turnIdRef.current;
    setAsking(true);
    setQueryStatus("Checking permissions and source versions…");
    setTurns(current => [...current, { id, question: trimmed }]);
    try {
      const result = await askApi(trimmed, historyRef.current, projectRef.current ?? undefined);
      setTurns(current => current.map(turn => turn.id === id ? { ...turn, result } : turn));
      historyRef.current = [...historyRef.current,
        { role: "user", text: trimmed },
        { role: "assistant", text: safeText(result.text).replace(/\s*\[[^\]]+\]/g, "") }].slice(-6) as ChatTurn[];
      setQueryStatus(result.kind === "action" ? "Review the ticket, then confirm."
        : result.kind === "chat" ? ""
        : result.citations?.length ? "Answer grounded in authorized sources."
        : !payloadRef.current?.documents.length ? "Broppy hasn't read anything yet, so there's nothing to answer from." : "");
      setQuestion("");
    } catch (error) {
      setTurns(current => current.map(turn => turn.id === id ? { ...turn, error: messageOf(error, "The question could not be answered.") } : turn));
      setQueryStatus("Query failed.");
    } finally {
      setAsking(false);
    }
  };

  const openCitation = (source: Citation, quotes: string[]) => {
    const doc = payloadRef.current?.documents.find(item => item.docId === source.docId);
    if (doc) openDoc(doc, quotes, true);
  };

  const loadTrace = async (traceId: string) => {
    if (roleRef.current === "compliance") {
      document.dispatchEvent(new CustomEvent<TraceRequest>(SHOW_TRACE, { detail: { traceId } }));
      return;
    }
    setTraceState({ traceId, entries: [] });
    try {
      const result = await traceApi(traceId);
      setTraceState({ traceId: result.traceId, entries: result.entries });
    } catch (error) {
      setTraceState({ traceId, entries: [], error: error instanceof ApiError && error.status === 404 ? "Trace endpoint is not available yet." : messageOf(error, "The trace could not be loaded.") });
    }
  };

  const runCatchUp = async () => {
    if (nothingRead) { setCatchUpState({ kind: "empty" }); return; }
    setCatchUpState({ kind: "pending" });
    try {
      const result = await catchUpApi(projectRef.current ?? undefined);
      setCatchUpState({ kind: "result", result });
    } catch (error) {
      setCatchUpState({ kind: "error", text: messageOf(error, "The catch-up could not be prepared.") });
    }
  };

  const review = async (command: ReviewCommand) => {
    try {
      await reviewCommitment(command);
      await load();
      shellStatus(command.action === "edit" ? "Review saved. Create or link after reviewing the saved fields." : "Commitment review saved.");
    } catch (error) {
      shellStatus(messageOf(error, "The review could not be saved."));
    }
  };

  const createTask = async (item: { id: string; revision: number; threadDocId: string; sentence: string }) => {
    shellStatus("Creating the Jira task…");
    try {
      const result = await createTaskApi({
        threadDocId: item.threadDocId, sentence: item.sentence, proposalId: item.id, revision: item.revision
      });
      await load();
      shellStatus([`Created ${safeText(result.title)}.`, ...omittedNotes(result.omitted)].join(" "));
      const created = payloadRef.current?.documents.find(doc => doc.docId === result.docId);
      if (created) openDoc(created);
    } catch (error) {
      shellStatus(messageOf(error, "The Jira task could not be created."));
    }
  };

  const markDone = async (doc: WorkspaceDocument) => {
    setBusyDoc(doc.docId);
    shellStatus("Marking the task done…");
    try {
      await markDoneApi(doc.docId);
      await load();
      shellStatus(`${doc.title} is done.`);
    } catch (error) {
      shellStatus(messageOf(error, "The task could not be marked done."));
    } finally {
      setBusyDoc(null);
    }
  };

  const appendConclusion = async (value: string) => {
    if (!master) return;
    shellStatus("Saving conclusion…");
    try {
      await post("/v1/admin/content", { docId: master.docId, content: `${master.content.trim()}\n${value}` });
      await load();
      shellStatus("Conclusion saved to Confluence master.");
    } catch (error) {
      shellStatus(messageOf(error, "The conclusion could not be saved."));
    }
  };

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    const onIdentity = (event: Event) => {
      const identity = (event as CustomEvent<WorkspaceIdentity>).detail;
      identityRef.current += 1;
      deepLinkRef.current = false;
      roleRef.current = identity?.role ?? "member";
      setRole(roleRef.current);
      projectRef.current = null;
      selectedRef.current = null;
      setProject(null);
      setSelected(null);
      setSearch("");
      setExpanded([]);
      setTurns([]);
      historyRef.current = [];
      setQuestion("");
      setQueryStatus("");
      setCatchUpState(null);
      setTraceState(null);
      setPreviewMerge(null);
      void load();
    };
    document.addEventListener(IDENTITY_CHANGED, onIdentity);
    return () => document.removeEventListener(IDENTITY_CHANGED, onIdentity);
  }, []);

  useEffect(() => {
    const onReload = () => { void load(); };
    document.addEventListener(WORKSPACE_RELOAD, onReload);
    return () => document.removeEventListener(WORKSPACE_RELOAD, onReload);
  }, []);

  useEffect(() => {
    const onOpenDoc = (event: Event) => {
      const requested = (event as CustomEvent<OpenTaskDetail>).detail;
      const doc = payloadRef.current?.documents.find(item => item.docId === requested?.id);
      if (doc) openDoc(doc, [], true);
    };
    document.addEventListener(OPEN_DOC, onOpenDoc);
    return () => document.removeEventListener(OPEN_DOC, onOpenDoc);
  }, []);

  useEffect(() => {
    const input = document.getElementById("search") as HTMLInputElement | null;
    if (!input) return;
    const onInput = () => { setSearch(input.value); setExpanded([]); };
    input.addEventListener("input", onInput);
    return () => input.removeEventListener("input", onInput);
  }, []);

  useEffect(() => {
    const select = document.getElementById("projectSelect") as HTMLSelectElement | null;
    if (!select) return;
    const onChange = () => {
      const next = select.value;
      projectRef.current = next;
      setProject(next);
      setExpanded([]);
      setCatchUpState(null);
      storeValue("brain-project", next);
    };
    select.addEventListener("change", onChange);
    return () => select.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const select = document.getElementById("projectSelect") as HTMLSelectElement | null;
    if (!select) return;
    const options = (payload?.projects ?? []).map(item => {
      const option = document.createElement("option");
      option.value = item.key;
      option.textContent = item.name;
      return option;
    });
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "All sources";
    select.replaceChildren(...options, all);
    select.value = project ?? "";
    select.disabled = !(payload?.projects.length);
  }, [payload, project]);

  useEffect(() => {
    if (!selected || !focusHeadingRef.current) return;
    focusHeadingRef.current = false;
    const heading = document.querySelector<HTMLElement>("#selectedDetail h3");
    heading?.focus({ preventScroll: true });
    const mark = document.querySelector<HTMLElement>("#selectedDetail mark");
    scrollTo(mark ?? document.getElementById("selectedDetail"));
  }, [selected]);

  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = null;
    document.querySelector<HTMLElement>(`[data-list-item="${pending.id}:${pending.index}"]`)?.focus({ preventScroll: true });
  }, [expanded]);

  useEffect(() => {
    const history = document.getElementById("chatHistory");
    if (history) history.scrollTop = history.scrollHeight;
  }, [turns, asking]);

  const expand = (id: string, index: number) => {
    pendingFocus.current = { id, index };
    setExpanded(current => current.includes(id) ? current : [...current, id]);
  };

  const showMore = (id: string, items: WorkspaceDocument[], noun: string) => {
    const { shown, hidden } = visibleItems(items, expanded.includes(id));
    if (!hidden) return null;
    return (
      <Button type="button" className="text-button show-more" variant="ghost"
        onPress={() => expand(id, shown.length)}>{showMoreLabel(hidden, noun)}</Button>
    );
  };

  const selectedDoc = selected ? documents.find(doc => doc.docId === selected.docId) : undefined;
  const commitments = (payload?.commitments ?? []).filter(item =>
    (!projectDocIds || projectDocIds.includes(item.threadDocId))
    && documents.some(doc => doc.docId === item.threadDocId));
  const latest = payload?.latest.find(item =>
    (item.project || "") === (project ?? "") && documents.some(doc => doc.docId === item.docId));
  const duplicates = (payload?.duplicates ?? []).filter(pair =>
    driveDocs.some(doc => doc.docId === pair.keep || doc.docId === pair.other)
    && documents.some(doc => doc.docId === pair.keep) && documents.some(doc => doc.docId === pair.other));
  const slackShown = visibleItems(slackDocs, expanded.includes(LISTS.slack));
  const jiraShown = visibleItems(jiraDocs, expanded.includes(LISTS.jira));
  const driveShown = visibleItems(driveDocs, expanded.includes(LISTS.drive));
  const sourcesShown = visibleItems(sourceDocs, expanded.includes(LISTS.sources));

  return (
    <div className={`workspace-surface workspace-layout${chatOpen ? "" : " chat-collapsed"}`}>
      <aside className="activity-panel" aria-label="Project activity">
        <div className="panel-heading">
          <div><p className="eyebrow">INBOX</p><h1>Project activity</h1></div>
          <span id="activityCount" className="count">{slackDocs.length + jiraDocs.length}</span>
        </div>
        <PersonalWidget />
        <section className="activity-section" aria-labelledby="slackTitle">
          <div className="section-title"><h2 id="slackTitle">Slack threads</h2><span className="source-dot slack" aria-hidden="true" /></div>
          <div id="slackList" className="stack">
            {slackShown.shown.map((doc, index) => (
              <Button key={doc.docId} type="button" variant="secondary" data-list-item={`${LISTS.slack}:${index}`}
                className="activity-item flex h-auto w-full flex-col items-start gap-1 whitespace-normal text-left"
                onPress={() => openDoc(doc)}>
                <span className="item-title">{doc.title}</span>
                <span className="item-meta">{sourceName(doc.source)} · {documentStatus(doc)} · {formatDate(doc.updatedAt)}</span>
              </Button>
            ))}
            {showMore(LISTS.slack, slackDocs, "thread")}
            {slackDocs.length === 0 ? <p className="empty">{nothingRead ? "Slack threads appear here once Broppy has read them." : "No Slack threads here yet."}</p> : null}
          </div>
        </section>
        <section className="activity-section" aria-labelledby="jiraTitle">
          <div className="section-title"><h2 id="jiraTitle">Jira tasks</h2><span className="source-dot jira" aria-hidden="true" /></div>
          <div id="jiraList" className="stack">
            {jiraShown.shown.map((doc, index) => (
              <Button key={doc.docId} type="button" variant="secondary" data-list-item={`${LISTS.jira}:${index}`}
                className="activity-item flex h-auto w-full flex-col items-start gap-1 whitespace-normal text-left"
                onPress={() => openDoc(doc)}>
                <span className="item-title">{doc.title}</span>
                <span className="item-meta">{sourceName(doc.source)} · {documentStatus(doc)} · {formatDate(doc.updatedAt)}</span>
              </Button>
            ))}
            {showMore(LISTS.jira, jiraDocs, "task")}
            {jiraDocs.length === 0 ? <p className="empty">{nothingRead ? "Jira tasks appear here once Broppy has read them." : "No Jira tasks here yet."}</p> : null}
          </div>
        </section>
        <section className="activity-section" aria-labelledby="suggestionTitle">
          <div className="section-title"><h2 id="suggestionTitle">From conversation to task</h2></div>
          <div id="suggestion" className="suggestion">
            {commitments.length === 0 ? (
              <p className="empty">{nothingRead ? "Commitments from your conversations appear here once Broppy has read them." : "No commitments are waiting for review."}</p>
            ) : commitments.map(item => (
              <SuggestionCard key={`${item.id}:${item.revision}`} item={item}
                thread={documents.find(doc => doc.docId === item.threadDocId)}
                owners={payload?.owners ?? []} canCreateTask={capabilities.createTask === true} live={live}
                documents={documents} onReview={review} onCreate={() => createTask(item)}
                onOpenIssue={docId => {
                  const doc = documents.find(entry => entry.docId === docId);
                  if (doc) openDoc(doc, [], true);
                }} />
            ))}
          </div>
        </section>
      </aside>

      <section className="document-panel" aria-labelledby="docHeading">
        <div className="breadcrumb"><span id="projectCrumb">{currentProject ? currentProject.name : "All sources"}</span><span aria-hidden="true">/</span><span>Confluence master</span></div>
        <div className="doc-topline">
          <div><p className="eyebrow">SOURCE OF TRUTH</p><h1 id="docHeading">{currentProject ? currentProject.name : "All sources"}</h1></div>
          <div id="masterBadge">{master ? <StatusBadge doc={master} /> : null}</div>
        </div>
        <p id="workspaceNotice" className="muted" role="status">
          {notice.text}
          {notice.link ? <> <a href={notice.link.href}>{notice.link.text}</a>.</> : null}
          {notice.retry ? <> <button type="button" className="link-button" onClick={() => void load()}>Try again</button></> : null}
        </p>
        <div id="masterContent" className="master-content">
          {master ? (
            <>
              <p>{master.content}</p>
              <p className="detail-meta">Version {master.version} · Edited {formatDate(master.updatedAt)}</p>
              <SourceLink url={master.url} source={master.source} />
            </>
          ) : (
            <p className="empty">{nothingRead ? "Once Broppy has read your tools, each project's main page shows here."
              : payload?.projects.length ? "Choose a project to see its main page." : "None of your projects has a main page you can open yet. Everything you can open is listed below."}</p>
          )}
        </div>
        <div className="section-title">
          <h2>Key conclusions</h2>
          <button type="button" id="catchUp" className="text-button" onClick={() => void runCatchUp()}>
            Get catch-up summary <span aria-hidden="true">↗</span>
          </button>
        </div>
        <div id="conclusions" className="conclusions">
          {master && sentencesOf(master.content).length
            ? sentencesOf(master.content).map(text => <div className="conclusion" key={text}>{text}</div>)
            : <p className="empty">{master ? "Conclusions will appear with authorized master content." : "Conclusions appear on a project's master page."}</p>}
          {role === "admin" && master?.content ? (
            <form className="conclusion-form" onSubmit={event => {
              event.preventDefault();
              const value = new FormData(event.currentTarget).get("conclusion");
              const text = typeof value === "string" ? value.trim() : "";
              if (!text) return;
              event.currentTarget.reset();
              void appendConclusion(text);
            }}>
              <label htmlFor="newConclusion">Append conclusion to master</label>
              <textarea id="newConclusion" name="conclusion" required maxLength={1000} placeholder="Write a conclusion grounded in the project sources" />
              <button type="submit">Append conclusion</button>
            </form>
          ) : null}
        </div>
        <div id="catchUpResult" className="answer-block" hidden={!catchUpState}>
          {catchUpState?.kind === "pending" ? <Pending label="Preparing your catch-up…" /> : null}
          {catchUpState?.kind === "empty" ? <p className="empty">There&apos;s nothing to catch up on yet: Broppy hasn&apos;t read any of your tools.</p> : null}
          {catchUpState?.kind === "error" ? <p className="muted">{catchUpState.text}</p> : null}
          {catchUpState?.kind === "result" && catchUpState.result.kind === "audit" ? (
            <>
              <strong>Audit trail, last 7 days</strong>
              <ul>{catchUpState.result.lines.map(line => <li key={line}>{line}</li>)}</ul>
            </>
          ) : null}
          {catchUpState?.kind === "result" && catchUpState.result.kind === "question" ? (
            <AnswerView result={{ ...catchUpState.result.answer, traceId: catchUpState.result.traceId } as AnswerResult}
              question={`Asked: ${safeText(catchUpState.result.question)}`} documents={documents} nothingRead={nothingRead}
              onOpenSource={openCitation} onTrace={traceId => void loadTrace(traceId)} />
          ) : null}
        </div>
        <div className="section-title documents-heading"><h2>Linked Drive documents</h2><span id="driveCount" className="muted">{driveDocs.length} accessible</span></div>
        <div id="driveList" className="file-list">
          {driveShown.shown.map((doc, index) => (
            <Button key={doc.docId} type="button" variant="secondary" data-list-item={`${LISTS.drive}:${index}`}
              className="file-row w-full justify-start text-left" onPress={() => openDoc(doc)}>
              <span className="file-icon">D</span>
              <span className="file-main"><span className="item-title">{doc.title}</span><span className="item-meta">Edited {formatDate(doc.updatedAt)} · v{doc.version}</span></span>
              <StatusBadge doc={doc} />
              {latest?.docId === doc.docId ? <span className="badge">Latest</span> : null}
            </Button>
          ))}
          {showMore(LISTS.drive, driveDocs, "file")}
          {driveDocs.length === 0 ? <p className="empty">{nothingRead ? "Linked Google Drive files appear here once Broppy has read them." : "No linked Drive files here yet."}</p> : null}
        </div>
        <div id="latestExplanation" className="muted">
          {latest ? (
            <>
              <p>Latest: {documents.find(doc => doc.docId === latest.docId)?.title}. Superseded copies never count.</p>
              <details className="latest-reasons">
                <summary>Why latest?</summary>
                <ul>{latest.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
              </details>
            </>
          ) : null}
        </div>
        <div id="duplicate" className="duplicate" hidden={duplicates.length === 0}>
          {duplicates.map(pair => {
            const keep = documents.find(doc => doc.docId === pair.keep);
            const other = documents.find(doc => doc.docId === pair.other);
            if (!keep || !other) return null;
            return (
              <div className="duplicate-pair" key={pair.other}>
                <strong>Possible duplicate · review before merging</strong>
                <p>{other.title} looks like a copy of {keep.title}: {pair.reasons.join("; ")}.</p>
                <button type="button" aria-expanded={previewMerge === pair.other}
                  onClick={() => setPreviewMerge(current => current === pair.other ? null : pair.other)}>Preview merge</button>
                {previewMerge === pair.other ? <MergePreview pair={pair} keep={keep} other={other} /> : null}
              </div>
            );
          })}
        </div>
        <div className="section-title all-heading">
          <h2>Accessible project sources</h2>
          <label className="sort-label">Landing view
            <select id="landingPreference" value={landing} onChange={event => {
              const next = event.target.value;
              landingRef.current = next;
              setLanding(next);
              storeValue("brain-landing", next);
              scrollTo(document.getElementById(LANDING_TARGETS[next] ?? "docHeading"));
            }}>
              <option value="master">Master page</option>
              <option value="activity">Activity</option>
              <option value="files">Files</option>
            </select>
          </label>
        </div>
        <div id="allSources" className="source-grid">
          {sourcesShown.shown.map((doc, index) => (
            <Button key={doc.docId} type="button" variant="secondary" data-list-item={`${LISTS.sources}:${index}`}
              className="source-item flex h-auto w-full flex-col items-start gap-1 whitespace-normal text-left"
              onPress={() => openDoc(doc)}>
              <span className="item-title">{doc.title}</span>
              <span className="item-meta">{sourceName(doc.source)} · {documentStatus(doc)}</span>
            </Button>
          ))}
          {showMore(LISTS.sources, sourceDocs, "source")}
          {sourceDocs.length === 0 ? <p className="empty">{nothingRead ? "Nothing read yet." : "Nothing matches your search."}</p> : null}
        </div>
        <div id="selectedDetail" className="selected-detail" hidden={!selectedDoc}>
          {selectedDoc ? (
            <>
              <p className="eyebrow">{sourceName(selectedDoc.source)} · {documentStatus(selectedDoc)}</p>
              <h3 tabIndex={-1}>{selectedDoc.title}</h3>
              <p className="detail-meta">Version {selectedDoc.version} · Edited {formatDate(selectedDoc.updatedAt)} · Tier {selectedDoc.tier}</p>
              {selectedDoc.lastIndexedAt ? <p className="detail-meta">Indexed {formatDate(selectedDoc.lastIndexedAt)}</p> : null}
              {selectedDoc.lastPermissionSyncAt ? <p className="detail-meta">Permissions synced {formatDate(selectedDoc.lastPermissionSyncAt)}</p> : null}
              <p className="detail-meta">Access tier {selectedDoc.tier} narrows source access; native source permissions still apply.</p>
              {selectedDoc.content
                ? <DocumentText content={selectedDoc.content} quotes={selected?.quotes ?? []} />
                : <p className="muted">Preview is loading from the workspace API. Open the source or ask the Brain for a cited summary.</p>}
              <SourceLink url={selectedDoc.url} source={selectedDoc.source} />
              <LinkedItems doc={selectedDoc} documents={documents} onOpen={openDoc} />
              {selectedDoc.source === "jira" ? (
                <TaskDetail doc={selectedDoc} documents={documents} canMarkDone={capabilities.markDone === true}
                  busy={busyDoc === selectedDoc.docId} onMarkDone={() => void markDone(selectedDoc)} onOpen={openDoc} />
              ) : null}
            </>
          ) : null}
        </div>
        <div id="workspaceTrace" className="trace-panel" hidden={!traceState}>
          {traceState ? (
            <>
              <h2>Query trace</h2>
              <p className="detail-meta">Trace {traceState.traceId}</p>
              {traceState.error ? <p className="muted">{traceState.error}</p> : (
                <ol className="trace-events">
                  {traceState.entries.map(entry => {
                    const [title, description] = traceDetails(entry, entry.sequence);
                    return (
                      <li className="trace-event" key={`${entry.sequence}-${entry.type}`}>
                        <span className="trace-time">#{entry.sequence} · {formatDate(entry.timestamp)}</span>
                        <strong>{title}</strong>
                        <p>{description}</p>
                      </li>
                    );
                  })}
                </ol>
              )}
            </>
          ) : null}
        </div>
      </section>

      <aside id="chatPanel" className={`chat-panel${chatOpen ? "" : " minimized"}`} aria-labelledby="chatTitle">
        <div className="chat-heading">
          <div><p className="eyebrow">ASK THE BRAIN</p><h2 id="chatTitle">Project chat</h2></div>
          <button type="button" id="minimizeChat" className="icon-button" aria-expanded={chatOpen}
            aria-label={chatOpen ? "Minimize chat" : "Expand chat"}
            onClick={() => setChatOpen(current => !current)}>{chatOpen ? "−" : "+"}</button>
        </div>
        <div id="chatBody" className="chat-body">
          <p className="muted">Ask across sources you can access. Answers include citations.</p>
          <div id="chatHistory" className="chat-history" aria-live="polite">
            {turns.map(turn => (
              <div key={turn.id}>
                <div className="message question">{turn.question}</div>
                <div className="message answer">
                  {turn.error ? turn.error : turn.result ? (
                    <>
                      {turn.result.kind === "action" && turn.result.proposal
                        ? <TicketProposal result={turn.result} onCreated={() => void load()} />
                        : <AnswerView result={turn.result} documents={documents} nothingRead={nothingRead}
                          onOpenSource={openCitation} onTrace={traceId => void loadTrace(traceId)} />}
                      {role === "compliance" && looksLikeAuditQuestion(turn.question) ? (
                        <div className="audit-hint">
                          <p>This looks like a question for the audit log, which records who asked and opened what.</p>
                          <Button type="button" className="secondary-button" variant="secondary"
                            onPress={() => document.dispatchEvent(new CustomEvent<AuditSearch>(SEARCH_AUDIT, { detail: { question: turn.question } }))}>
                            Search the audit log
                          </Button>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>
            ))}
            {asking ? <div className="message answer"><Pending label="Checking permissions and sources…" /></div> : null}
          </div>
          <form id="queryForm" className="query-form" onSubmit={event => {
            event.preventDefault();
            void ask(question);
          }}>
            <label className="sr-only" htmlFor="question">Ask a question</label>
            <textarea id="question" maxLength={500} placeholder="Ask across your sources…" required
              value={question} onChange={event => setQuestion(event.target.value)} />
            <button type="submit" id="askButton" disabled={asking}>Ask <span aria-hidden="true">↗</span></button>
          </form>
          <p id="queryStatus" role="status" className="muted">{queryStatus}</p>
        </div>
      </aside>
    </div>
  );
}

function StatusBadge({ doc }: { doc: WorkspaceDocument }) {
  const status = documentStatus(doc);
  const tone = { "in review": "review", draft: "draft", superseded: "superseded" }[status] ?? "";
  return <span className={`status-badge ${tone}`}>{status}</span>;
}

function SourceLink({ url, source }: { url: string; source: string }) {
  if (isDemoAddress(url)) return <span className="muted demo-note">Demo document: there&apos;s no live {sourceName(source)} page.</span>;
  const href = safeUrl(url);
  if (!href) return <span className="muted">Source link unavailable</span>;
  return <a className="text-button" href={href} target="_blank" rel="noopener noreferrer">Open in {sourceName(source)} ↗</a>;
}

function DocumentText({ content, quotes }: { content: string; quotes: string[] }) {
  const ranges = quotedRanges(content, quotes) as [number, number][];
  const parts: React.ReactNode[] = [];
  let position = 0;
  ranges.forEach(([start, end], index) => {
    parts.push(content.slice(position, start));
    parts.push(<mark key={index}>{content.slice(start, end)}</mark>);
    position = end;
  });
  parts.push(content.slice(position));
  return <p className="document-text">{parts}</p>;
}

function LinkedItems({ doc, documents, onOpen }: {
  doc: WorkspaceDocument;
  documents: WorkspaceDocument[];
  onOpen: (doc: WorkspaceDocument, quotes?: string[], focus?: boolean) => void;
}) {
  const linked = (doc.links ?? [])
    .map(id => documents.find(item => item.docId === id))
    .filter((item): item is WorkspaceDocument => Boolean(item));
  if (!linked.length) return null;
  return (
    <div className="linked-items">
      <strong>Linked items</strong>
      {linked.map(item => (
        <Button key={item.docId} type="button" className="text-button" variant="ghost"
          onPress={() => onOpen(item)}>{sourceName(item.source)} · {item.title}</Button>
      ))}
    </div>
  );
}

function TaskDetail({ doc, documents, canMarkDone, busy, onMarkDone, onOpen }: {
  doc: WorkspaceDocument;
  documents: WorkspaceDocument[];
  canMarkDone: boolean;
  busy: boolean;
  onMarkDone: () => void;
  onOpen: (doc: WorkspaceDocument, quotes?: string[], focus?: boolean) => void;
}) {
  const key = doc.docId.split(":")[1] ?? "";
  const work = (doc.links ?? [])
    .map(id => documents.find(item => item.docId === id))
    .filter((item): item is WorkspaceDocument => item !== undefined)
    .filter(item => ["confluence", "drive"].includes(item.source));
  const target = work.find(item => sentencesOf(item.content).some(sentence => sentence.includes(key))) ?? work[0];
  const facts = [
    doc.metadata?.dueDate ? `Due ${safeText(doc.metadata.dueDate)}` : "",
    doc.metadata?.priority ? `${safeText(doc.metadata.priority)} priority` : ""
  ].filter(Boolean);
  const sentence = target ? sentencesOf(target.content).find(item => item.includes(key)) ?? sentencesOf(target.content)[0] ?? "" : "";
  return (
    <div className="answer-block">
      {facts.length ? <p className="detail-meta">{facts.join(" · ")}</p> : null}
      {target ? (
        <>
          <strong>Working doc: {target.title}</strong>
          <p>{sentence}</p>
          <Button type="button" className="text-button" variant="ghost"
            onPress={() => onOpen(target, sentence ? [sentence] : [], true)}>Open {target.title}</Button>
          {!isDemoAddress(target.url) ? <> <SourceLink url={target.url} source={target.source} /></> : null}
        </>
      ) : <p className="muted">No linked page or file that you can open.</p>}
      {taskIsDone(doc) ? <p className="muted">This task is done.</p>
        : canMarkDone ? <Button type="button" className="secondary-button" variant="secondary" isDisabled={busy} onPress={onMarkDone}>Mark done</Button>
        : <SourceLink url={doc.url} source={doc.source} />}
    </div>
  );
}

function MergePreview({ pair, keep, other }: { pair: WorkspaceDuplicate; keep: WorkspaceDocument; other: WorkspaceDocument }) {
  return (
    <div className="merge-preview">
      <strong>Merge preview</strong>
      <p>Keep {keep.title}. {other.title} would be marked superseded, with a link to {keep.title}.</p>
      {([[other, pair.onlyInOther], [keep, pair.onlyInKeep]] as [WorkspaceDocument, string[]][]).map(([doc, only]) =>
        only.length ? (
          <div key={doc.docId}>
            <p>Only in {doc.title}:</p>
            <ul>{only.map(line => <li key={line}>{line}</li>)}</ul>
          </div>
        ) : null)}
      <p className="muted">Preview only: nothing was changed.</p>
    </div>
  );
}

function Pending({ label }: { label: string }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <p className="pending">
      <span className="spinner" aria-hidden="true" />
      {label}
      <span className="pending-seconds" aria-hidden="true">{seconds} s</span>
    </p>
  );
}

function TicketProposal({ result, onCreated }: { result: QueryResponse; onCreated: () => void }) {
  const proposal = result.proposal!;
  const [project, setProject] = useState(safeText(proposal.project));
  const [summary, setSummary] = useState(safeText(proposal.summary));
  const [description, setDescription] = useState(safeText(proposal.description));
  const [dueDate, setDueDate] = useState(safeText(proposal.dueDate));
  const [status, setStatus] = useState("");
  const [cancelled, setCancelled] = useState(false);
  const [created, setCreated] = useState<{ key: string; url?: string } | null>(null);
  if (cancelled) return <p className="muted">Cancelled. Nothing was created.</p>;
  if (created) {
    return (
      <p>Created {created.url?.startsWith("https://")
        ? <a href={created.url} target="_blank" rel="noopener noreferrer">{created.key}</a>
        : created.key}.</p>
    );
  }
  return (
    <>
      <p>{safeText(result.text)}</p>
      <form className="proposal" onSubmit={event => {
        event.preventDefault();
        setStatus("Creating the ticket…");
        void post<{ key: string; url: string }>("/v1/actions/jira-issue", {
          proposalId: proposal.id, project: project.trim().toUpperCase(), summary: summary.trim(), description,
          ...(dueDate ? { dueDate } : {})
        }).then(created => { setCreated(created); onCreated(); })
          .catch(error => { setStatus(messageOf(error, "The ticket could not be created.")); });
      }}>
        <label className="proposal-field"><span>Project key (required)</span>
          <input value={project} maxLength={10} required placeholder="For example DB" pattern="[A-Za-z][A-Za-z0-9]{0,9}"
            onChange={event => setProject(event.target.value)} />
        </label>
        <label className="proposal-field"><span>Title</span>
          <input value={summary} maxLength={250} required onChange={event => setSummary(event.target.value)} />
        </label>
        <label className="proposal-field"><span>Description</span>
          <textarea value={description} maxLength={5000} rows={4} onChange={event => setDescription(event.target.value)} />
        </label>
        <label className="proposal-field"><span>Due date (optional)</span>
          <input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} />
        </label>
        <div className="proposal-actions">
          <button type="submit">Confirm and create</button>
          <button type="button" className="text-button" onClick={() => setCancelled(true)}>Cancel</button>
          <p className="muted" role="status">{status}</p>
        </div>
      </form>
    </>
  );
}
