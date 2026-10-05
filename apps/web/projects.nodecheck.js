import test from "node:test";
import assert from "node:assert/strict";
import { chosenProject } from "./projects.js";

const keys = ["DB", "PAY", "PLAT"];

test("keeps the project on screen while the person may still open it, All sources included", () => {
  assert.equal(chosenProject("PAY", "DB", keys), "PAY");
  assert.equal(chosenProject("", "DB", keys), "");
});

test("starts from the project last chosen, All sources included, else the first", () => {
  assert.equal(chosenProject(null, "PLAT", keys), "PLAT");
  assert.equal(chosenProject(null, "", keys), "");
  assert.equal(chosenProject(null, null, keys), "DB");
});

test("moves on from a project the person can no longer open, and shows All sources when they have none", () => {
  assert.equal(chosenProject("VEND", "PLAT", keys), "PLAT");
  assert.equal(chosenProject("VEND", "KYC", keys), "DB");
  assert.equal(chosenProject(null, "PLAT", []), "");
  assert.equal(chosenProject(null, null, []), "");
});
