import { useState } from "react";
import { Button } from "@heroui/react";
import { safeText } from "../lib/workspace.js";
import type { Commitment, WorkspaceDocument, WorkspaceOwner } from "./api";

export type ReviewCommand = {
  id: string;
  revision: number;
  action: "edit" | "dismiss" | "link";
  summary?: string;
  ownerSlackId?: string;
  dueDate?: string;
  issueDocId?: string;
};

export function SuggestionCard({ item, thread, owners, canCreateTask, live, documents, onReview, onCreate, onOpenIssue }: {
  item: Commitment;
  thread?: WorkspaceDocument;
  owners: WorkspaceOwner[];
  canCreateTask: boolean;
  live: boolean;
  documents: WorkspaceDocument[];
  onReview: (command: ReviewCommand) => Promise<void>;
  onCreate: () => Promise<void>;
  onOpenIssue: (docId: string) => void;
}) {
  const [summary, setSummary] = useState(item.summary);
  const [owner, setOwner] = useState(item.ownerSlackId ?? "");
  const [dueDate, setDueDate] = useState(item.dueDate ?? "");
  const [busy, setBusy] = useState(false);
  const [chosenIssue, setChosenIssue] = useState("");
  const saved = { summary: item.summary, owner: item.ownerSlackId ?? "", dueDate: item.dueDate ?? "" };
  const dirty = summary !== saved.summary || owner !== saved.owner || dueDate !== saved.dueDate;
  const summaryId = `commitment-summary-${item.id}`;
  const ownerId = `commitment-owner-${item.id}`;
  const dueId = `commitment-due-${item.id}`;
  const visibleIssues = documents.filter(doc => doc.source === "jira" && doc.metadata?.project === item.project);

  const run = async (command: ReviewCommand | null, create = false) => {
    setBusy(true);
    try {
      if (create) await onCreate();
      else if (command) await onReview(command);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agreement" data-proposal-id={item.id} tabIndex={-1}>
      <strong>Commitment in {thread?.title ?? item.threadDocId}</strong>
      <blockquote>{item.sentence}</blockquote>
      {item.permalink ? (
        <a href={item.permalink} target="_blank" rel="noopener noreferrer">Open exact Slack message ↗</a>
      ) : (
        <p className="muted">Legacy thread evidence. An exact message reference is unavailable.</p>
      )}
      {item.status !== "pending" ? (
        <>
          <p>{item.status === "created" ? "Created" : "Linked to"} {safeText(item.issueTitle)}.</p>
          <Button type="button" className="text-button" variant="ghost"
            onPress={() => item.issueDocId && onOpenIssue(item.issueDocId)}>Open linked Jira task</Button>
        </>
      ) : (
        <>
          {item.notice ? <p className="muted">{item.notice}</p> : null}
          {item.importNotice ? <p className="muted">{item.importNotice}</p> : null}
          <form className="commitment-review" onSubmit={event => {
            event.preventDefault();
            void run({ id: item.id, revision: item.revision, action: "edit", summary, ownerSlackId: owner, dueDate });
          }}>
            <label htmlFor={summaryId}>Summary</label>
            <input id={summaryId} name="summary" maxLength={200} required value={summary}
              onChange={event => setSummary(event.target.value)} />
            <label htmlFor={ownerId}>Owner</label>
            <select id={ownerId} name="owner" value={owner} onChange={event => setOwner(event.target.value)}>
              <option value="">Unknown / unassigned</option>
              {owners.map(person => <option key={person.slackId} value={person.slackId}>{person.name}</option>)}
              {item.ownerSlackId && !owners.some(person => person.slackId === item.ownerSlackId) ? (
                <option value={item.ownerSlackId}>Source owner unresolved</option>
              ) : null}
            </select>
            <label htmlFor={dueId}>Due date (blank means unknown)</label>
            <input id={dueId} name="dueDate" type="date" value={dueDate}
              onChange={event => setDueDate(event.target.value)} />
            <Button type="submit" className="secondary-button" variant="secondary" isDisabled={busy}>Save review</Button>
          </form>
          {item.canCreate && canCreateTask ? (
            <>
              <Button type="button" variant="primary" isDisabled={busy || dirty} onPress={() => void run(null, true)}>
                Create Jira task in {item.project} ↗
              </Button>
              {live ? (
                <p className="muted">This creates the issue in your company&apos;s Jira. Everyone who can see the {item.project} project there will see its title.</p>
              ) : null}
            </>
          ) : item.jiraUrl ? (
            <a href={item.jiraUrl} target="_blank" rel="noopener noreferrer">Open {item.project} in Jira ↗</a>
          ) : null}
          <Button type="button" className="text-button" variant="ghost" isDisabled={busy}
            onPress={() => void run({ id: item.id, revision: item.revision, action: "dismiss" })}>Dismiss</Button>
          {item.candidates?.length ? (
            <>
              <p className="muted">Possible existing work. Similarity requires your review.</p>
              {item.candidates.map(candidate => (
                <div className="candidate-review" key={candidate.docId}>
                  <a href={candidate.url} target="_blank" rel="noopener noreferrer">{candidate.title}</a>
                  <Button type="button" className="secondary-button" variant="secondary" isDisabled={busy}
                    onPress={() => void run({ id: item.id, revision: item.revision, action: "link", issueDocId: candidate.docId })}>
                    Link existing
                  </Button>
                </div>
              ))}
            </>
          ) : (
            <p className="muted">No title or text match found in the visible project sources. This does not establish that work is untracked.</p>
          )}
          {visibleIssues.length ? (
            <label className="commitment-review">
              Review another visible Jira issue
              <select value={chosenIssue} onChange={event => setChosenIssue(event.target.value)}>
                <option value="">Choose an issue</option>
                {visibleIssues.map(issue => <option key={issue.docId} value={issue.docId}>{issue.title}</option>)}
              </select>
              <Button type="button" className="text-button" variant="ghost" isDisabled={!chosenIssue || busy}
                onPress={() => onOpenIssue(chosenIssue)}>Open selected issue</Button>
              <Button type="button" className="secondary-button" variant="secondary" isDisabled={!chosenIssue || busy}
                onPress={() => void run({ id: item.id, revision: item.revision, action: "link", issueDocId: chosenIssue })}>
                Link selected issue
              </Button>
            </label>
          ) : null}
        </>
      )}
    </div>
  );
}
