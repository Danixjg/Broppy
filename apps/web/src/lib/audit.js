// Pure helpers for the compliance console: the local stand-in for the API's own audit search, and the CSV
// the export writes. Nothing here touches the page or the API.

import { eventSummary } from "./trace.js";

const STOP_WORDS = ["for", "the", "a", "an", "show", "find", "me", "events", "event", "about"];
const MEANINGS = { denied: "false", allowed: "true", permission: "permission", access: "access" };

/**
 * The entries a question matches when the API's own search is not available. The words a person asks with
 * are reduced to the terms that carry meaning, and every entry is matched on all of them.
 *
 * @param {any[]} entries
 * @param {string} query
 * @returns {any[]}
 */
export function localAuditSearch(entries, query) {
  const text = String(query ?? "").trim().toLowerCase();
  if (!text) return entries;
  const terms = text.split(/\s+/).filter(term => !STOP_WORDS.includes(term));
  const normalized = terms.map(term => MEANINGS[term] || term);
  return entries.filter(entry => normalized.every(term =>
    `${entry.type} ${entry.actor} ${eventSummary(entry)}`.toLowerCase().includes(term)));
}

/**
 * A spreadsheet cell: quoted, and never a formula a spreadsheet would run.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function csvCell(value) {
  const text = String(value ?? "");
  return `"${(/^[\s]*[=+\-@]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
}

/**
 * The audit log as CSV: the header that names the columns, then one line per entry.
 *
 * @param {any[]} entries
 * @returns {string}
 */
export function auditCsv(entries) {
  const rows = [["sequence", "timestamp", "type", "actor", "details", "hash"].map(csvCell).join(",")];
  for (const entry of entries) {
    rows.push([entry.sequence, entry.timestamp, entry.type, entry.actor,
      JSON.stringify(entry.data || {}), entry.hash].map(csvCell).join(","));
  }
  return rows.join("\r\n");
}
