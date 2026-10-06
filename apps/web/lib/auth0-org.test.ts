import { describe, expect, it } from "vitest";
import { orgIdProblem } from "./auth0";

describe("orgIdProblem", () => {
  it("accepts an organization ID and an unset value", () => {
    expect(orgIdProblem("org_AbC123xyz")).toBeUndefined();
    expect(orgIdProblem("")).toBeUndefined();
  });
  it("rejects an organization name", () => {
    expect(orgIdProblem("Company A")).toContain("not its name");
    expect(orgIdProblem("company-a")).toContain("org_");
  });
});
