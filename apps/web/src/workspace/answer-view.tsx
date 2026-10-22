import { Button } from "@heroui/react";
import { answerLines, isDemoAddress, leftOutNote, numberSources } from "../../answer.js";
import { formatDate, quotesOf, safeText, safeUrl, scopeText } from "../lib/workspace.js";
import type { AnswerResult, Citation, WorkspaceDocument } from "./api";

const NO_RESULT_TEXT = "No accessible information was found for this query.";

type AnswerLine = { text: string; refs: number[]; kind?: string; support?: string[] };

export function AnswerView({ result, question, documents, nothingRead, onOpenSource, onTrace }: {
  result: AnswerResult;
  question?: string;
  documents: WorkspaceDocument[];
  nothingRead: boolean;
  onOpenSource: (source: Citation, quotes: string[]) => void;
  onTrace: (traceId: string) => void;
}) {
  const sources = numberSources(result.citations ?? []);
  const lines = answerLines(safeText(result.text), sources, result.check) as AnswerLine[];
  const note = leftOutNote(result.check);
  const scope = scopeText(result.scope);
  const text = nothingRead && !sources.length
    ? "Broppy hasn't read any of your tools yet, so it has nothing to answer from. Connect a tool, or choose what Broppy reads, in Setup."
    : safeText(result.text) === NO_RESULT_TEXT
      ? "Hmm, I couldn't find anything on that. If you expected an answer, the file may be out of date or not in Broppy yet. Check with your admin or manager."
      : safeText(result.text) || "No answer returned.";
  return (
    <>
      {question ? <p>{question}</p> : null}
      <div className="answer-lines">
        {lines.map((line, index) => (
          <p className="answer-line" key={index}>
            {line.text}
            {line.kind === "reworded" ? (
              <span className="reworded-tag" title="In the writer's words. Open its source to see the sentence it's based on.">reworded</span>
            ) : null}
            {line.refs.map((number: number) => {
              const source = sources[number - 1] as Citation | undefined;
              if (!source) return null;
              return (
                <button type="button" className="cite" key={`${index}-${number}`} title={safeText(source.title)}
                  aria-label={`Source ${number}: ${safeText(source.title)}`}
                  onClick={() => onOpenSource(source, quotesOf(line))}>{number}</button>
              );
            })}
          </p>
        ))}
      </div>
      {note ? <p className="checker-note">{note}</p> : null}
      {scope ? <p className="muted">{scope}</p> : null}
      <CitationList sources={sources as Citation[]} lines={lines} documents={documents} onOpenSource={onOpenSource} />
      {result.traceId ? (
        <Button type="button" className="text-button" variant="ghost"
          onPress={() => onTrace(result.traceId as string)}>Why this result? View trace ↗</Button>
      ) : null}
    </>
  );
}

function CitationList({ sources, lines, documents, onOpenSource }: {
  sources: Citation[];
  lines: AnswerLine[];
  documents: WorkspaceDocument[];
  onOpenSource: (source: Citation, quotes: string[]) => void;
}) {
  if (!sources.length) return null;
  const byId = new Map(documents.map(doc => [doc.docId, doc]));
  return (
    <div className="citation-list">
      <strong>Sources</strong>
      <ol className="source-list">
        {sources.map(source => {
          const via = typeof source.linkedFrom === "string"
            ? ` · linked from ${byId.get(source.linkedFrom)?.title ?? source.linkedFrom}` : "";
          const label = `${safeText(source.title)} · v${source.version} · edited ${formatDate(source.updatedAt)}${via}`;
          const quotes = lines.filter(line => line.refs.includes(source.number)).flatMap(line => quotesOf(line));
          return (
            <li key={source.number}>
              {byId.get(source.docId) ? (
                <button type="button" className="source-button" onClick={() => onOpenSource(source, quotes)}>{label}</button>
              ) : isDemoAddress(source.url) || !safeUrl(source.url) ? (
                <span>{label}</span>
              ) : (
                <a href={source.url} target="_blank" rel="noopener noreferrer">{label}</a>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
