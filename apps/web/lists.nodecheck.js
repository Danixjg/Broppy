import test from "node:test";
import assert from "node:assert/strict";
import { LIST_LIMIT, showMoreLabel, visibleItems } from "./lists.js";

const items = count => Array.from({ length: count }, (_, index) => `item ${index + 1}`);

test("shows the first eight items of a long list, and says how many wait behind the button", () => {
  assert.equal(LIST_LIMIT, 8);
  const { shown, hidden } = visibleItems(items(20), false);
  assert.deepEqual(shown, items(8));
  assert.equal(hidden, 12);
});

test("names what the button shows, so each list's button makes sense on its own", () => {
  assert.equal(showMoreLabel(12, "thread"), "Show 12 more threads");
  assert.equal(showMoreLabel(1, "task"), "Show 1 more task");
  assert.equal(showMoreLabel(297, "source"), "Show 297 more sources");
});

test("shows a short list whole, and a long one whole once it is expanded", () => {
  assert.deepEqual(visibleItems(items(8), false), { shown: items(8), hidden: 0 });
  assert.deepEqual(visibleItems(items(3), false), { shown: items(3), hidden: 0 });
  assert.deepEqual(visibleItems(items(20), true), { shown: items(20), hidden: 0 });
  assert.deepEqual(visibleItems([], false), { shown: [], hidden: 0 });
});
