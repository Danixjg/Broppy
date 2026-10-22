import { useEffect, useRef, useState } from "react";
import { Button, Surface } from "@heroui/react";
import { narrowerPermissionError } from "../../permissions.js";
import { nativeRestriction } from "../lib/admin.js";
import { currentIdentity, type Identity } from "../lib/identity";
import { sourceName } from "../lib/workspace.js";
import { IDENTITY_CHANGED, WORKSPACE_DATA, WORKSPACE_RELOAD, type WorkspaceIdentity } from "../tasks/events";
import { applyContent, applyTier, loadPermissions, previewAccess, removeChannelMember, removeGroup, savePermissions,
  type SourcePermissions } from "./api";

type AdminDocument = { docId: string; title: string; source: string; tier?: string };
type WorkspaceData = { documents?: AdminDocument[]; capabilities?: { mode?: string } };
type Preview = { name: string; documents: { docId: string; title: string; reason: string }[] };

const messageOf = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

export function AdminView() {
  const [documents, setDocuments] = useState<AdminDocument[]>([]);
  const [docId, setDocId] = useState("");
  const [tier, setTier] = useState("internal");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState("");
  const [nativeLabel, setNativeLabel] = useState("Select an accessible document.");
  const [nativeDocId, setNativeDocId] = useState("");
  const [nativePermissions, setNativePermissions] = useState<SourcePermissions | null>(null);
  const [nativeText, setNativeText] = useState("");
  const [nativeRestrictionText, setNativeRestrictionText] = useState("");
  const [nativeStatus, setNativeStatus] = useState("");
  const [nativeReload, setNativeReload] = useState(0);
  const [memberUser, setMemberUser] = useState("ravi");  const [memberGroup, setMemberGroup] = useState("");
  const [channelDoc, setChannelDoc] = useState("");
  const [previewUser, setPreviewUser] = useState("alex");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewStatus, setPreviewStatus] = useState("");
  const [identity, setIdentity] = useState<Identity>(currentIdentity);

  const documentsRef = useRef<AdminDocument[]>([]);
  const identityRef = useRef<Identity>(currentIdentity());
  const docIdRef = useRef("");
  const loadRef = useRef(0);
  const previewRef = useRef<HTMLDivElement | null>(null);

  documentsRef.current = documents;
  docIdRef.current = docId;

  useEffect(() => {
    const onData = (event: Event) => {
      const detail = (event as CustomEvent<WorkspaceData>).detail;
      const docs = (detail?.documents ?? []).filter(doc => doc && typeof doc.docId === "string" && typeof doc.title === "string");
      setDocuments(docs);
      setDocId(current => docs.some(doc => doc.docId === current) ? current : docs[0]?.docId ?? "");
    };
    document.addEventListener(WORKSPACE_DATA, onData);
    return () => document.removeEventListener(WORKSPACE_DATA, onData);
  }, []);

  // The tier control starts at the chosen document's own tier, so applying it narrows from where the
  // document really is rather than from a guess.
  useEffect(() => {
    const current = documents.find(doc => doc.docId === docId)?.tier;
    if (current) setTier(current);
  }, [documents, docId]);

  useEffect(() => {
    const onIdentity = (event: Event) => {
      const next = (event as CustomEvent<WorkspaceIdentity>).detail;
      identityRef.current = next;
      setIdentity(next);
      loadRef.current += 1;
      setStatus("");
      setContent("");
      setMemberGroup("");
      setChannelDoc("");
      setPreview(null);
      setPreviewStatus("");
      setNativeDocId("");
      setNativePermissions(null);
      setNativeText("");
      setNativeRestrictionText("");
      setNativeStatus("");
      setNativeLabel("Select an accessible document.");
    };
    document.addEventListener(IDENTITY_CHANGED, onIdentity);
    return () => document.removeEventListener(IDENTITY_CHANGED, onIdentity);
  }, []);

  useEffect(() => {
    const request = ++loadRef.current;
    const who = identityRef.current;
    setNativeDocId("");
    setNativePermissions(null);
    setNativeText("");
    setNativeRestrictionText("");
    setNativeStatus("");
    if (who.role !== "admin" || !docId) { setNativeLabel("Select an accessible document."); return; }
    const doc = documentsRef.current.find(item => item.docId === docId);
    setNativeLabel(`${doc?.title || docId} · ${sourceName(doc?.source)}`);
    setNativeStatus("Loading current source permissions…");
    void (async () => {
      try {
        const result = await loadPermissions(docId);
        if (request !== loadRef.current || who !== identityRef.current) return;
        if (result.docId !== docId || result.source !== doc?.source || !result.permissions || typeof result.permissions !== "object") {
          throw new Error("The API returned invalid source permissions.");
        }
        if (narrowerPermissionError(result.permissions, result.permissions, result.source)) {
          throw new Error("The API returned incomplete source permissions.");
        }
        setNativeDocId(docId);
        setNativePermissions(result.permissions);
        setNativeText(JSON.stringify(result.permissions, null, 2));
        setNativeRestrictionText(nativeRestriction(result.source, result.permissions.native));
        setNativeStatus("Current permissions loaded. Only narrower changes will be accepted.");
      } catch (error) {
        if (request === loadRef.current && who === identityRef.current) {
          setNativeStatus(messageOf(error, "The source permissions could not be loaded."));
        }
      }
    })();
  }, [docId, nativeReload, identity.role]);

  const run = async (send: () => Promise<unknown>, success: string) => {
    const who = identityRef.current;
    if (who.role !== "admin") return;
    setStatus("Applying change…");
    try {
      await send();
      if (who !== identityRef.current) return;
      setStatus(success);
      document.dispatchEvent(new CustomEvent(WORKSPACE_RELOAD));
    } catch (error) {
      if (who === identityRef.current) setStatus(messageOf(error, "The change could not be applied."));
    }
  };

  const saveNative = async (event: React.FormEvent) => {
    event.preventDefault();
    const who = identityRef.current;
    if (docId !== nativeDocId) { setNativeStatus("Load this document’s current permissions first."); return; }
    let permissions: unknown;
    try { permissions = JSON.parse(nativeText); }
    catch { setNativeStatus("Enter valid JSON permissions."); return; }
    const doc = documentsRef.current.find(item => item.docId === docId);
    const problem = narrowerPermissionError(permissions, nativePermissions ?? undefined, doc?.source);
    if (problem) { setNativeStatus(problem); return; }
    setNativeStatus("Applying narrower source permissions…");
    try {
      await savePermissions(docId, permissions);
      if (who !== identityRef.current || docId !== docIdRef.current) return;
      document.dispatchEvent(new CustomEvent(WORKSPACE_RELOAD));
      setNativeStatus("Source permissions saved and workspace refreshed.");
    } catch (error) {
      if (who === identityRef.current) setNativeStatus(messageOf(error, "The source permissions could not be saved."));
    }
  };

  const showPreview = async () => {
    const who = identityRef.current;
    setPreview(null);
    setPreviewStatus("Loading preview…");
    try {
      const result = await previewAccess(previewUser);
      if (who !== identityRef.current) return;
      setPreview({
        name: result.user.name,
        documents: result.documents.map(doc => ({
          docId: doc.docId,
          title: doc.title,
          reason: Array.isArray(result.reasons?.[doc.docId]) ? result.reasons[doc.docId].join(" · ") : `Tier: ${doc.tier}`
        }))
      });
      setPreviewStatus("");
      requestAnimationFrame(() => previewRef.current?.focus({ preventScroll: true }));
    } catch (error) {
      if (who === identityRef.current) setPreviewStatus(messageOf(error, "The preview could not be loaded."));
    }
  };

  return (
    <div className="admin-surface">
      <div className="view-heading">
        <p className="eyebrow">MAYA · ADMIN SIMULATION</p>
        <h1 id="adminHeading">Source controls</h1>
        <p>Changes update the mock source and sync through the API. Tiers and brain grants can only narrow access.</p>
      </div>

      <div className="admin-grid">
        <form id="contentForm" className="surface" onSubmit={event => {
          event.preventDefault();
          void run(() => applyContent(docId, content), "Content updated and synced.");
        }}>
          <h2>Edit source content</h2>
          <label htmlFor="adminDoc">Accessible document</label>
          <select id="adminDoc" required value={docId} onChange={event => setDocId(event.target.value)}>
            {documents.map(doc => <option key={doc.docId} value={doc.docId}>{doc.title} · {doc.docId}</option>)}
          </select>
          <label htmlFor="adminContent">Replacement content</label>
          <textarea id="adminContent" required maxLength={50000} placeholder="Enter the full replacement content"
            value={content} onChange={event => setContent(event.target.value)} />
          <Button type="submit">Apply content change</Button>
        </form>

        <Surface className="surface">
          <h2>Access controls</h2>
          <p className="muted">Changes apply to the selected document above.</p>
          <label htmlFor="tier">Narrow access tier</label>
          <select id="tier" value={tier} onChange={event => setTier(event.target.value)}>
            <option value="internal">Team</option>
            <option value="restricted">Restricted</option>
          </select>
          <Button type="button" id="applyTier" onPress={() => void run(() => applyTier(docId, tier), "Access tier narrowed.")}>
            Apply tier
          </Button>
          <hr />
          <p>Remove all indexed brain user and group grants for this item. Native source permissions are retained.</p>
          <Button type="button" id="revokeBrain" variant="danger" className="danger-button"
            onPress={() => void run(() => savePermissions(docId, { users: [], groups: [], public: false }),
              "Brain grants revoked and synced. Native permissions remain unchanged.")}>
            Revoke brain grants
          </Button>
        </Surface>

        <form id="nativePermissionForm" className="surface" onSubmit={event => void saveNative(event)}>
          <h2>Native source permissions</h2>
          <p id="nativeDocLabel" className="muted">{nativeLabel}</p>
          <p id="nativeRestriction" className="muted">{nativeRestrictionText}</p>
          <label htmlFor="nativePermissions">Full permissions JSON</label>
          <textarea id="nativePermissions" spellCheck={false} required aria-describedby="nativeRestriction nativeStatus"
            value={nativeText} onChange={event => setNativeText(event.target.value)} />
          <p className="muted">Only remove access. Keep source identifiers and required fields. Submit the full object.</p>
          <Button type="submit" id="saveNativePermissions" isDisabled={!nativePermissions}>Apply narrower permissions</Button>
          <Button type="button" id="reloadNativePermissions" className="secondary-button" variant="secondary"
            onPress={() => setNativeReload(current => current + 1)}>Reload current permissions</Button>
          <p id="nativeStatus" role="status">{nativeStatus}</p>
        </form>

        <Surface className="surface">
          <h2>Membership changes</h2>
          <label htmlFor="memberUser">User</label>
          <select id="memberUser" value={memberUser} onChange={event => setMemberUser(event.target.value)}>
            <option value="ravi">Ravi</option>
            <option value="alex">Alex</option>
            <option value="david">David</option>
            <option value="wei">Wei Ming</option>
          </select>
          <label htmlFor="memberGroup">Group to remove</label>
          <input id="memberGroup" placeholder="Group name" autoComplete="off" value={memberGroup}
            onChange={event => setMemberGroup(event.target.value)} />
          <Button type="button" id="removeGroup" onPress={() => {
            const group = memberGroup.trim();
            if (!group) { setStatus("Enter a group name."); return; }
            void run(() => removeGroup(memberUser, group), "Group membership removed. The next query uses updated access.");
          }}>Remove from group</Button>
          <hr />
          <label htmlFor="memberChannelDoc">Slack channel document ID</label>
          <input id="memberChannelDoc" placeholder="Enter channel document ID" autoComplete="off" value={channelDoc}
            onChange={event => setChannelDoc(event.target.value)} />
          <p className="muted">Removing a member affects the next live source check.</p>
          <Button type="button" id="removeChannelMember" variant="danger" className="danger-button" onPress={() => {
            const channel = channelDoc.trim();
            if (!channel) { setStatus("Enter a Slack channel document ID."); return; }
            void run(() => removeChannelMember(channel, memberUser),
              "Channel membership removed. The next query uses updated live access.");
          }}>Remove user from channel</Button>
        </Surface>

        <Surface className="surface">
          <h2>New-hire preview</h2>
          <label htmlFor="previewUser">View as</label>
          <select id="previewUser" value={previewUser} onChange={event => setPreviewUser(event.target.value)}>
            <option value="alex">Alex · intern</option>
            <option value="wei">Wei Ming · contractor</option>
            <option value="ravi">Ravi</option>
          </select>
          <Button type="button" id="previewAccess" onPress={() => void showPreview()}>Preview access</Button>
          <div id="previewResult" className="preview-result" aria-live="polite" tabIndex={-1} ref={previewRef}>
            {previewStatus ? <p>{previewStatus}</p> : null}
            {preview ? (
              <>
                <strong>{preview.name} · {preview.documents.length} accessible documents</strong>
                {preview.documents.length ? (
                  <ul>{preview.documents.map(doc => <li key={doc.docId}>{doc.title} · {doc.reason}</li>)}</ul>
                ) : <p className="empty">No accessible documents for this identity.</p>}
              </>
            ) : null}
          </div>
        </Surface>
      </div>

      <p id="adminStatus" role="status">{status}</p>
    </div>
  );
}
