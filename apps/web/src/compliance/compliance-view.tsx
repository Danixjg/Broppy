import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { auditSummary, isRoutineSync } from "../../answer.js";
import { auditCsv, localAuditSearch } from "../lib/audit.js";
import { currentIdentity, type Identity } from "../lib/identity";
import { formatDate } from "../lib/workspace.js";
import { traceDetails } from "../lib/trace.js";
import { IDENTITY_CHANGED, SEARCH_AUDIT, SHOW_TRACE, type AuditSearch, type TraceRequest, type WorkspaceIdentity } from "../tasks/events";
import { loadAudit, loadProof, loadTrace, sealAudit, searchAudit, verifyAudit,
  type AuditEntry, type AuditPayload, type MerkleProof, type TraceEntry } from "./api";

type ProofState = { sequence: number; proof?: MerkleProof; error?: string };
type Verdict = { sequence: number; verified: boolean; local: boolean; error?: string };
type TraceState = { traceId: string; entries: TraceEntry[]; error?: string };
type Focus = "proof" | "trace" | null;

const messageOf = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

const reveal = (element: Element | null) => {
  element?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
};

const hashPair = async (left: string, right: string) => {
  const bytes = new TextEncoder().encode(`${left}:${right}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
};

export function ComplianceView() {
  const [audit, setAudit] = useState<AuditPayload | null>(null);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [hideRoutine, setHideRoutine] = useState(true);
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState("");
  const [summary, setSummary] = useState("");
  const [proof, setProof] = useState<ProofState | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [trace, setTrace] = useState<TraceState | null>(null);
  const [rawOpen, setRawOpen] = useState<number[]>([]);
  const [focus, setFocus] = useState<Focus>(null);

  const identityRef = useRef<Identity>(currentIdentity());
  const auditRef = useRef<AuditPayload | null>(null);
  const entriesRef = useRef<AuditEntry[]>([]);
  const proofRef = useRef<ProofState | null>(null);
  const fromRef = useRef("");
  const toRef = useRef("");
  const searchRef = useRef(false);
  const loadRef = useRef(0);
  const proofHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const traceHeadingRef = useRef<HTMLHeadingElement | null>(null);

  auditRef.current = audit;
  entriesRef.current = entries;
  proofRef.current = proof;
  fromRef.current = from;
  toRef.current = to;

  const shown = hideRoutine ? entries.filter(entry => !isRoutineSync(entry)) : entries;
  const hidden = entries.length - shown.length;

  const load = async () => {
    const who = identityRef.current;
    const request = ++loadRef.current;
    setStatus("Loading audit…");
    try {
      const result = await loadAudit();
      if (request !== loadRef.current || who !== identityRef.current) return;
      setAudit(result);
      setEntries(result.entries ?? []);
      setSummary(`${result.entries?.length || 0} events · ${result.batches?.length || 0} sealed batches · Chain ${result.chainValid ? "valid" : "invalid"}`);
      setStatus("");
    } catch (error) {
      if (request === loadRef.current && who === identityRef.current) setStatus(messageOf(error, "The audit log could not be loaded."));
    }
  };

  const runSearch = async (question: string) => {
    const who = identityRef.current;
    searchRef.current = true;
    try {
      if (!auditRef.current) await load();
      if (who !== identityRef.current) return;
      setStatus("Searching audit…");
      try {
        const result = await searchAudit(question, fromRef.current, toRef.current);
        if (who !== identityRef.current) return;
        setEntries(result.entries ?? []);
        setStatus(`${result.entries?.length || 0} matching event${result.entries?.length === 1 ? "" : "s"}`);
      } catch (error) {
        if (who !== identityRef.current) return;
        if ((error as { status?: number }).status !== 404) {
          setStatus(messageOf(error, "The audit log could not be searched."));
          return;
        }
        const found = localAuditSearch(auditRef.current?.entries ?? [], question);
        setEntries(found);
        setStatus(`${found.length} matching event${found.length === 1 ? "" : "s"} · local search`);
      }
    } finally {
      searchRef.current = false;
    }
  };

  const inspectProof = async (sequence: number) => {
    const who = identityRef.current;
    setProof({ sequence });
    setVerdict(null);
    setFocus("proof");
    try {
      const result = await loadProof(sequence);
      if (who !== identityRef.current) return;
      setProof({ sequence, proof: result.proof });
    } catch (error) {
      if (who === identityRef.current) setProof({ sequence, error: messageOf(error, "The proof could not be loaded.") });
    }
  };

  const verifyLocally = async (sequence: number) => {
    const current = proofRef.current?.proof;
    const batch = auditRef.current?.batches?.find(item => sequence >= item.firstSequence && sequence <= item.lastSequence);
    const entry = auditRef.current?.entries?.find(item => item.sequence === sequence);
    if (!current || !batch || !entry || entry.hash !== current.leaf) return false;
    let running = current.leaf;
    for (const sibling of current.siblings) {
      running = sibling.position === "left" ? await hashPair(sibling.hash, running) : await hashPair(running, sibling.hash);
    }
    return running === batch.root && current.root === batch.root;
  };

  const verify = async (sequence: number) => {
    const who = identityRef.current;
    try {
      let result: { verified?: boolean; valid?: boolean; local?: boolean };
      try { result = await verifyAudit(sequence); }
      catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
        result = { valid: await verifyLocally(sequence), local: true };
      }
      if (who !== identityRef.current) return;
      setVerdict({ sequence, verified: Boolean(result.verified ?? result.valid), local: result.local === true });
    } catch (error) {
      if (who === identityRef.current) setVerdict({ sequence, verified: false, local: false, error: messageOf(error, "The proof could not be verified.") });
    }
  };

  const showTrace = async (traceId: string) => {
    const who = identityRef.current;
    setTrace({ traceId, entries: [] });
    setFocus("trace");
    try {
      const result = await loadTrace(traceId);
      if (who !== identityRef.current) return;
      setTrace({ traceId: result.traceId, entries: [...(result.entries ?? [])].sort((a, b) => a.sequence - b.sequence) });
    } catch (error) {
      if (who === identityRef.current) {
        setTrace({ traceId, entries: [], error: (error as { status?: number }).status === 404 ? "Trace endpoint is not available yet." : messageOf(error, "The trace could not be loaded.") });
      }
    }
  };

  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob([auditCsv(entriesRef.current)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "internal-brain-audit.csv";
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const seal = async () => {
    const who = identityRef.current;
    try {
      const result = await sealAudit();
      if (who !== identityRef.current) return;
      await load();
      setStatus(result.batch ? "Audit batch sealed." : "No new events to seal.");
    } catch (error) {
      if (who === identityRef.current) setStatus(messageOf(error, "The audit log could not be sealed."));
    }
  };

  useEffect(() => {
    const onIdentity = (event: Event) => {
      const next = (event as CustomEvent<WorkspaceIdentity>).detail;
      identityRef.current = next;
      loadRef.current += 1;
      setAudit(null);
      setEntries([]);
      setStatus("");
      setSummary("");
      setProof(null);
      setVerdict(null);
      setTrace(null);
      setQuery("");
      setFrom("");
      setTo("");
      setHideRoutine(true);
    };
    document.addEventListener(IDENTITY_CHANGED, onIdentity);
    return () => document.removeEventListener(IDENTITY_CHANGED, onIdentity);
  }, []);

  useEffect(() => {
    const container = document.getElementById("complianceView");
    if (!container) return;
    const observer = new MutationObserver(() => {
      if (container.hidden || searchRef.current) return;
      void load();
    });
    observer.observe(container, { attributes: true, attributeFilter: ["hidden"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onShowTrace = (event: Event) => {
      const traceId = (event as CustomEvent<TraceRequest>).detail?.traceId;
      if (!traceId || identityRef.current.role !== "compliance") return;
      document.querySelector<HTMLElement>('[data-view="compliance"]')?.click();
      void showTrace(traceId);
    };
    const onSearchAudit = (event: Event) => {
      const question = (event as CustomEvent<AuditSearch>).detail?.question;
      if (!question || identityRef.current.role !== "compliance") return;
      document.querySelector<HTMLElement>('[data-view="compliance"]')?.click();
      setQuery(question);
      void runSearch(question);
    };
    document.addEventListener(SHOW_TRACE, onShowTrace);
    document.addEventListener(SEARCH_AUDIT, onSearchAudit);
    return () => {
      document.removeEventListener(SHOW_TRACE, onShowTrace);
      document.removeEventListener(SEARCH_AUDIT, onSearchAudit);
    };
  }, []);

  useEffect(() => {
    if (!focus) return;
    setFocus(null);
    const target = focus === "proof" ? proofHeadingRef.current : traceHeadingRef.current;
    target?.focus({ preventScroll: true });
    reveal(target);
  }, [focus]);

  const traceRows = useMemo(() => {
    let rank = 0;
    return (trace?.entries ?? []).map(entry => {
      if (entry.type === "candidate_ranked") rank += 1;
      return { entry, rank };
    });
  }, [trace]);

  return (
    <div className="compliance-surface">
      <div className="view-heading">
        <p className="eyebrow">NUR · COMPLIANCE</p>
        <h1 id="complianceHeading">Audit console</h1>
        <p>Inspect events, Merkle proofs, and query traces.</p>
      </div>

      <form id="auditSearchForm" className="audit-search" onSubmit={event => {
        event.preventDefault();
        void runSearch(query);
      }}>
        <label htmlFor="auditSearch">Ask the audit log</label>
        <div>
          <input id="auditSearch" type="search" placeholder="e.g. access denied for Ravi" value={query}
            onChange={event => setQuery(event.target.value)} />
          <Button type="submit">Search</Button>
        </div>
        <label htmlFor="auditFrom">From</label>
        <input id="auditFrom" type="date" value={from} onChange={event => setFrom(event.target.value)} />
        <label htmlFor="auditTo">To</label>
        <input id="auditTo" type="date" value={to} onChange={event => setTo(event.target.value)} />
      </form>

      <div className="toolbar">
        <Button type="button" id="refreshAudit" className="secondary-button" variant="secondary"
          onPress={() => void load()}>Refresh events</Button>
        <Button type="button" id="sealAudit" className="secondary-button" variant="secondary"
          onPress={() => void seal()}>Seal current events</Button>
        <Button type="button" id="exportAudit" className="secondary-button" variant="secondary"
          onPress={exportCsv}>Export CSV</Button>
        <span id="auditStatus" role="status">{status}</span>
      </div>

      <div className="audit-summary">
        <span id="auditSummary">{summary}</span>
        <label className="audit-toggle">
          <input id="hideRoutine" type="checkbox" checked={hideRoutine}
            onChange={event => setHideRoutine(event.target.checked)} />Hide routine sync checks
        </label>
        <span id="routineHidden" aria-live="polite">{hidden ? `${hidden} hidden` : ""}</span>
      </div>

      <div className="table-wrap">
        <table>
          <caption className="sr-only">Audit events</caption>
          <thead>
            <tr>
              <th scope="col"># / time</th>
              <th scope="col">Event</th>
              <th scope="col">Actor</th>
              <th scope="col">Details</th>
              <th scope="col">Proof</th>
            </tr>
          </thead>
          <tbody id="auditRows">
            {shown.map(entry => (
              <tr key={entry.sequence}>
                <td>#{entry.sequence} · {formatDate(entry.timestamp)}</td>
                <td>{entry.type}</td>
                <td>{entry.actor}</td>
                <td>
                  <p className="audit-line">{auditSummary(entry)}</p>
                  <details className="raw-data" onToggle={event => {
                    if (event.currentTarget.open) setRawOpen(current => current.includes(entry.sequence) ? current : [...current, entry.sequence]);
                  }}>
                    <summary>Raw data</summary>
                    {rawOpen.includes(entry.sequence) ? <pre>{JSON.stringify(entry, null, 2)}</pre> : null}
                  </details>
                </td>
                <td>
                  <Button type="button" variant="ghost" onPress={() => void inspectProof(entry.sequence)}>Inspect proof</Button>
                </td>
              </tr>
            ))}
            {shown.length === 0 ? (
              <tr>
                <td className="empty" colSpan={5}>
                  {hidden ? "Only routine sync checks match. Untick “Hide routine sync checks” to see them." : "No matching audit events."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div id="proofPanel" className="proof-panel" hidden={!proof}>
        {proof ? (
          <>
            <h2 ref={proofHeadingRef} tabIndex={-1}>Merkle proof · event #{proof.sequence}</h2>
            {proof.error ? <p className="muted">{proof.error}</p> : null}
            {proof.proof ? (
              <>
                <p className="muted">Leaf {proof.proof.leaf}</p>
                {proof.proof.siblings.map((sibling, index) => (
                  <div className="proof-step" key={`${index}-${sibling.position}`}>
                    <strong>Step {index + 1} · {sibling.position} sibling </strong>
                    <code>{sibling.hash}</code>
                  </div>
                ))}
                <p className="muted">Root {proof.proof.root}</p>
                <Button type="button" className="secondary-button" variant="secondary"
                  onPress={() => void verify(proof.sequence)}>Verify proof</Button>
              </>
            ) : null}
            {verdict && verdict.sequence === proof.sequence ? (
              verdict.error
                ? <p className="muted">{verdict.error}</p>
                : <p className={verdict.verified ? "badge" : "status-badge superseded"}>
                  {verdict.verified
                    ? `Proof verified${verdict.local ? " locally against the loaded audit batch" : ""}`
                    : "Proof verification failed"}
                </p>
            ) : null}
          </>
        ) : null}
      </div>

      <div id="tracePanel" className="trace-panel" hidden={!trace}>
        {trace ? (
          <>
            <h2 ref={traceHeadingRef} tabIndex={-1}>Query trace</h2>
            <p className="detail-meta">Trace {trace.traceId}</p>
            {trace.error ? <p className="muted">{trace.error}</p> : null}
            {trace.entries.length === 0 && !trace.error ? <p className="empty">No trace events available.</p> : null}
            <ol className="trace-events">
              {traceRows.map(({ entry, rank }) => {
                const [title, description] = traceDetails(entry, rank);
                return (
                  <li className="trace-event" key={`${entry.sequence}-${entry.type}`}>
                    <span className="trace-time">#{entry.sequence} · {formatDate(entry.timestamp)}</span>
                    <strong>{title}</strong>
                    <p>{description}</p>
                  </li>
                );
              })}
            </ol>
          </>
        ) : null}
      </div>
    </div>
  );
}
