import { useEffect, useRef, useState } from "react";
import { Button, Surface } from "@heroui/react";
import { healthLine, timeAgo } from "../lib/health.js";
import { currentIdentity, type Identity } from "../lib/identity";
import { formatDate, sourceName } from "../lib/workspace.js";
import { IDENTITY_CHANGED, WORKSPACE_RELOAD, type WorkspaceIdentity } from "../tasks/events";
import { loadHealth, syncNow, type HealthSource } from "./api";

const messageOf = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

export function OperationsView() {
  const [sources, setSources] = useState<HealthSource[]>([]);
  const [status, setStatus] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [identity, setIdentity] = useState<Identity>(currentIdentity);

  const identityRef = useRef<Identity>(currentIdentity());
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const loadRef = useRef(0);

  const isAdmin = identity.role === "admin";

  const schedule = (delay: number, who: Identity) => {
    clearTimeout(timerRef.current);
    if (!delay) return;
    timerRef.current = setTimeout(() => {
      if (document.getElementById("operationsView")?.hidden) return;
      if (who !== identityRef.current) return;
      void load();
    }, delay);
  };

  const load = async () => {
    const who = identityRef.current;
    const request = ++loadRef.current;
    setStatus("Loading…");
    try {
      const result = await loadHealth();
      if (request !== loadRef.current || who !== identityRef.current) return;
      const list = result.sources ?? [];
      setSources(list);
      const connected = list.filter(item => item.status !== "Not connected").length;
      setStatus(`${connected} of ${list.length} tools connected`);
      const reading = list.some(item => item.job?.status === "running" || item.status === "Importing");
      schedule(reading ? 4000 : 0, who);
    } catch (error) {
      if (request !== loadRef.current || who !== identityRef.current) return;
      setStatus(`${messageOf(error, "The sync health could not be loaded.")} Trying again…`);
      schedule(5000, who);
    }
  };

  const sync = async () => {
    const who = identityRef.current;
    setSyncing(true);
    setStatus("Syncing your connected tools… this can take a minute.");
    try {
      const result = await syncNow();
      if (who !== identityRef.current) return;
      await load();
      document.dispatchEvent(new CustomEvent(WORKSPACE_RELOAD));
      const results = result?.results ?? [];
      const failed = results.filter(item => !item.ok).map(item => sourceName(item.source));
      setStatus(!results.length ? "No tools are connected yet, so there was nothing to sync."
        : failed.length ? `Synced, except ${failed.join(", ")}. Check ${failed.length === 1 ? "it" : "them"} below.`
        : `Synced ${results.map(item => sourceName(item.source)).join(", ")}.`);
    } catch (error) {
      if (who === identityRef.current) setStatus(messageOf(error, "The sync could not be started."));
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    const onIdentity = (event: Event) => {
      const next = (event as CustomEvent<WorkspaceIdentity>).detail;
      identityRef.current = next;
      setIdentity(next);
      loadRef.current += 1;
      clearTimeout(timerRef.current);
      setSources([]);
      setStatus("");
    };
    document.addEventListener(IDENTITY_CHANGED, onIdentity);
    return () => document.removeEventListener(IDENTITY_CHANGED, onIdentity);
  }, []);

  useEffect(() => {
    const container = document.getElementById("operationsView");
    if (!container) return;
    const observer = new MutationObserver(() => {
      if (container.hidden) return;
      void load();
    });
    observer.observe(container, { attributes: true, attributeFilter: ["hidden"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <div className="operations-surface">
      <div className="view-heading">
        <p className="eyebrow">SYSTEM STATUS</p>
        <h1 id="operationsHeading">Sync health</h1>
        <p>Where each of your company&apos;s tools stands, and how answers are put together.</p>
      </div>

      <div className="toolbar">
        <Button type="button" id="refreshHealth" onPress={() => void load()}>Refresh</Button>
        <Button type="button" id="retrySync" className="secondary-button" variant="secondary" hidden={!isAdmin}
          isDisabled={syncing} onPress={() => void sync()}>Sync now</Button>
      </div>

      <p id="healthStatus" role="status">{status}</p>

      <div id="healthCards" className="health-grid">
        {sources.map(item => {
          const line = healthLine(item, isAdmin);
          return (
            <Surface key={item.source} className="surface">
              <h2>{sourceName(item.source)}</h2>
              <p className={line.kind} title={line.detail}>{line.text}</p>
              {item.status !== "Not connected" ? (
                <>
                  <p className="muted" title={item.lastSync ? formatDate(item.lastSync) : undefined}>
                    {item.lastSync ? `Last synced ${timeAgo(item.lastSync) || formatDate(item.lastSync)}` : "Not synced yet"}
                  </p>
                  {item.pending ? <p className="muted">{item.pending} item{item.pending === 1 ? "" : "s"} still to read</p> : null}
                  {isAdmin && identity.mode !== "demo" ? <a href="./setup.html?step=read">Change what Broppy reads</a> : null}
                </>
              ) : isAdmin && identity.mode !== "demo" ? <a href="./setup.html">Connect it in setup</a> : null}
            </Surface>
          );
        })}
      </div>

      <figure className="surface architecture" aria-labelledby="architectureTitle">
        <figcaption id="architectureTitle">Answer path and trust boundaries</figcaption>
        <div className="architecture-grid">
          <div><span className="boundary">Browser</span><strong>Workspace &amp; chat</strong><p>Identity and question</p></div>
          <div><span className="boundary">API</span><strong>Hybrid retrieval</strong><p>Vector + keyword candidates, then linked items</p></div>
          <div><span className="boundary">Authorization</span><strong>FGA and tier</strong><p>Document IDs checked first</p></div>
          <div><span className="boundary">Source platforms</span><strong>Live recheck</strong><p>Access and version verified</p></div>
          <div><span className="boundary">API</span><strong>Grounded answer</strong><p>Authorized chunks → LLM client → output checker</p></div>
          <div><span className="boundary">Audit store</span><strong>Evidence</strong><p>Decisions → hash chain → Merkle proof</p></div>
        </div>
        <p className="muted">Content sync updates the index; permission sync updates access facts. Denied candidates do not enter the answer context.</p>
      </figure>
    </div>
  );
}
