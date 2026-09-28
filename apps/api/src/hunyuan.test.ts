import { describe, expect, it, vi } from "vitest";
import { HunyuanLlm } from "./hunyuan.js";

const context = [{ citation: "jira:PAY-101:0", text: "Cutover starts at 2 PM." }];

describe("HunyuanLlm", () => {
  it("sends only the supplied context and question to the documented endpoint", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "At 2 PM. [jira:PAY-101:0]" } }]
    }), { status: 200 }));
    const client = new HunyuanLlm({ apiKey: "secret-key", model: "hunyuan-turbos-latest", fetch: fetcher as typeof fetch });
    const supplied = [{ ...context[0], title: "restricted-title-sentinel" }];
    expect(await client.generate(supplied, "When is cutover?")).toBe("At 2 PM. [jira:PAY-101:0]");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.hunyuan.cloud.tencent.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({ Authorization: "Bearer secret-key", "Content-Type": "application/json" });
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("hunyuan-turbos-latest");
    expect(body.stream).toBe(false);
    expect(body.enable_enhancement).toBe(false);
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual(["system", "user"]);
    expect(JSON.parse(body.messages[1].content)).toEqual({ question: "When is cutover?", context });
    expect(init.body).not.toContain("restricted-title-sentinel");
  });

  it("rejects empty context or question without contacting Hunyuan", async () => {
    const fetcher = vi.fn();
    const client = new HunyuanLlm({ apiKey: "key", model: "model", fetch: fetcher as typeof fetch });
    await expect(client.generate([], "question")).rejects.toThrow("Invalid Hunyuan input");
    await expect(client.generate(context, " ")).rejects.toThrow("Invalid Hunyuan input");
    await expect(client.generate([{ citation: "", text: "text" }], "question")).rejects.toThrow("Invalid Hunyuan input");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed on provider errors and malformed output without logging context", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const response of [
        new Response("sensitive provider body", { status: 500 }),
        new Response("not json", { status: 200 }),
        new Response(JSON.stringify({ choices: [] }), { status: 200 }),
        new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }] }), { status: 200 }),
        new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { role: "assistant", content: "truncated" } }] }), { status: 200 })
      ]) {
        const fetcher = vi.fn(async () => response);
        const client = new HunyuanLlm({ apiKey: "key", model: "model", fetch: fetcher as typeof fetch });
        await expect(client.generate(context, "question")).rejects.toThrow();
      }
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("requires a configured key and model", () => {
    expect(() => new HunyuanLlm({ apiKey: "", model: "model" })).toThrow();
    expect(() => new HunyuanLlm({ apiKey: "key", model: "" })).toThrow();
  });
});
