// Long workspace lists show their first items and a button for the rest, so a person who can open hundreds of
// documents still sees the top of each list at a glance.
export const LIST_LIMIT = 8;

/** The items to show, and how many wait behind the "Show more" button. */
export function visibleItems(items, expanded, limit = LIST_LIMIT) {
  const shown = expanded || items.length <= limit ? items : items.slice(0, limit);
  return { shown, hidden: items.length - shown.length };
}

/** The button's label, naming what it shows: "Show 12 more threads". Someone moving between buttons hears each one
 * without its list's heading, so the label says which list it opens. */
export function showMoreLabel(hidden, noun) {
  return `Show ${hidden} more ${noun}${hidden === 1 ? "" : "s"}`;
}
