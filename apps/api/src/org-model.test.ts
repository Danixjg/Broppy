import { describe, expect, it, vi } from "vitest";
import { Brain } from "./brain.js";
import { publicHttpsBaseUrl } from "./llm.js";
import { ModelCheckFailed, OrgModel } from "./org-model.js";
import type { Persistence } from "./persistence.js";

/** Stands in for the Supabase functions that keep the model and its Vault secret. */
function store() {
  let row: any;
  const request = vi.fn(async (path: string, _method: string, data: any) => {
    if (path === "rpc/store_org_model") row = { provider: data.provider_name, model: data.model_name, baseUrl: data.endpoint ?? undefined, apiKey: data.api_key, updatedBy: data.actor, updatedAt: "2026-10-06T00:00:00Z" };
    if (path === "rpc/read_org_model") return row ?? null;
    if (path === "rpc/remove_org_model") row = undefined;
    return undefined;
  });
  return { request, persistence: { orgId: "org_a", request } as unknown as Persistence };
}
const answer = (text = "ok") => Response.json({ type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });

describe("OrgModel", () => {
  it("checks the settings with a real call, stores the key only through Vault, and never reports it", async () => {
    const { request, persistence } = store();
    const fetcher = vi.fn(async () => answer());
    const model = new OrgModel(persistence, fetcher as typeof fetch);
    const summary = await model.save("maya", { provider: "anthropic", model: "claude-sonnet-5-5", apiKey: "sk-ant-secret" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("rpc/store_org_model", "POST", expect.objectContaining({ organization: "org_a", api_key: "sk-ant-secret", actor: "maya" }));
    expect(summary).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5", keySet: true });
    expect(JSON.stringify(summary)).not.toContain("sk-ant-secret");
    expect(JSON.stringify(await model.summary())).not.toContain("sk-ant-secret");
    expect(await model.current()).toBeDefined();
  });

  it("keeps the stored key when only the model name changes, and refuses a bad key without saving it", async () => {
    const { request, persistence } = store();
    const fetcher = vi.fn(async () => answer());
    const model = new OrgModel(persistence, fetcher as typeof fetch);
    await model.save("maya", { provider: "anthropic", model: "a", apiKey: "sk-1" });
    await model.save("maya", { provider: "anthropic", model: "b" });
    expect(request).toHaveBeenLastCalledWith("rpc/store_org_model", "POST", expect.objectContaining({ model_name: "b", api_key: "sk-1" }));
    request.mockClear();
    const bad = new OrgModel(persistence, (async () => new Response("{}", { status: 401 })) as typeof fetch);
    await expect(bad.save("maya", { provider: "anthropic", model: "b", apiKey: "wrong" })).rejects.toMatchObject({ refused: true });
    await expect(bad.save("maya", { provider: "anthropic", model: "b", apiKey: "x" })).rejects.toBeInstanceOf(ModelCheckFailed);
    expect(request).not.toHaveBeenCalledWith("rpc/store_org_model", expect.anything(), expect.anything());
  });

  it("validates input: provider, key, and a public HTTPS address for compatible servers", async () => {
    const { persistence } = store();
    const model = new OrgModel(persistence, (async () => Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }] })) as typeof fetch);
    await expect(model.save("m", { provider: "hunyuan", model: "x", apiKey: "k" })).rejects.toThrow("Invalid provider");
    await expect(model.save("m", { provider: "openai", model: "", apiKey: "k" })).rejects.toThrow("Invalid model");
    await expect(model.save("m", { provider: "openai" , model: "x" })).rejects.toThrow("Invalid key");
    await expect(model.save("m", { provider: "openai_compatible", model: "x", apiKey: "k" })).rejects.toThrow("Invalid address");
    await expect(model.save("m", { provider: "openai_compatible", model: "x", apiKey: "k", baseUrl: "http://llm.example.com/v1" })).rejects.toThrow("Invalid model address");
    await expect(model.save("m", { provider: "openai_compatible", model: "x", apiKey: "k", baseUrl: "https://169.254.169.254/v1" })).rejects.toThrow("Invalid model address");
    await expect(model.save("m", { provider: "openai_compatible", model: "x", apiKey: "k", baseUrl: "https://llm.example.com/v1" })).resolves.toMatchObject({ baseUrl: "https://llm.example.com/v1" });
  });

  it("picks up a removal, and refreshes after the cache window for changes made elsewhere", async () => {
    const { persistence } = store();
    let now = 0;
    const model = new OrgModel(persistence, (async () => answer()) as typeof fetch, () => now);
    await model.save("maya", { provider: "anthropic", model: "a", apiKey: "k" });
    await model.remove();
    expect(await model.current()).toBeUndefined();
    const other = new OrgModel(persistence, (async () => answer()) as typeof fetch, () => now);
    expect(await other.current()).toBeUndefined();
    await model.save("maya", { provider: "anthropic", model: "a", apiKey: "k" });
    expect(await other.current()).toBeUndefined();
    now = 31_000;
    expect(await other.current()).toBeDefined();
  });
});

describe("publicHttpsBaseUrl", () => {
  it.each(["http://x.example.com", "https://localhost/v1", "https://10.0.0.5/v1", "https://192.168.1.2", "https://172.20.0.1", "https://127.0.0.1", "https://[::1]/v1", "https://svc.internal/v1", "https://u:p@x.example.com", "https://x.example.com/?a=1", "https://intranet/v1"])("refuses %s", value => {
    expect(() => publicHttpsBaseUrl(value)).toThrow("Invalid model address");
  });
  it("accepts a public HTTPS address", () => expect(publicHttpsBaseUrl("https://x.example.com/v1")).toBe("https://x.example.com/v1"));
});

describe("Brain with an organization model", () => {
  const asker = (brain: Brain) => brain.user("ravi")!;
  it("answers with the organization's model before the operator's, and with the built-in writer when its settings can't be read", async () => {
    const calls: string[] = [];
    const operator = { generate: vi.fn(async () => { calls.push("operator"); return ""; }) };
    const org = { generate: vi.fn(async () => { calls.push("org"); return ""; }) };
    const brain = new Brain(operator, { orgLlm: { current: async () => org } });
    await brain.syncAll();
    const user = asker(brain);
    await brain.query(user, "What does PAY-101 need before cutover?");
    expect(calls).toEqual(["org"]);
    const broken = new Brain(operator, { orgLlm: { current: async () => { throw new Error("db down"); } } });
    await broken.syncAll();
    await broken.query(asker(broken), "What does PAY-101 need before cutover?");
    expect(calls).toEqual(["org"]);
    const none = new Brain(operator, { orgLlm: { current: async () => undefined } });
    await none.syncAll();
    await none.query(asker(none), "What does PAY-101 need before cutover?");
    expect(calls).toEqual(["org", "operator"]);
  });
});
