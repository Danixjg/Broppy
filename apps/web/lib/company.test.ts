import { afterEach, describe, expect, it, vi } from "vitest";
import { asksForCompany, pinnedOrganization, safeReturn, signInPath, signupMode } from "./company";
import { allow } from "./visitor-limit";

afterEach(() => vi.unstubAllEnvs());

describe("one company or many", () => {
  it("keeps the single fixed company until sign-up is switched on or closed", () => {
    vi.stubEnv("AUTH0_ORG_ID", "org_home");
    expect([signupMode(), asksForCompany(), pinnedOrganization(), signInPath("/workspace/setup.html")]).toEqual(["off", false, "org_home", "/auth/login?returnTo=%2Fworkspace%2Fsetup.html"]);
    vi.stubEnv("SELF_SIGNUP", "nonsense");
    expect(signupMode()).toBe("off");
  });

  it("asks which company when sign-up is on or closed, and stops pinning one", () => {
    vi.stubEnv("AUTH0_ORG_ID", "org_home");
    for (const mode of ["on", "closed"]) {
      vi.stubEnv("SELF_SIGNUP", mode);
      expect([asksForCompany(), pinnedOrganization()]).toEqual([true, undefined]);
    }
    expect(signInPath()).toBe("/signin");
    expect(signInPath("/workspace/index.html?ask=x")).toBe("/signin?returnTo=%2Fworkspace%2Findex.html%3Fask%3Dx");
  });

  it("only returns to a page on this site", () => {
    expect(safeReturn("/workspace/setup.html?welcome=1")).toBe("/workspace/setup.html?welcome=1");
    for (const value of [undefined, "", "https://evil.test/", "//evil.test", "/..//x", "/a/../b", "javascript:alert(1)", "/x".repeat(200)]) {
      expect(safeReturn(value)).toBe("/workspace/index.html");
    }
  });
});

describe("visitor limit", () => {
  it("lets a visitor through until the limit", () => {
    const key = `test:${Math.random()}`;
    expect([1, 2, 3].map(() => allow(key, 2, 60_000))).toEqual([true, true, false]);
  });
});
