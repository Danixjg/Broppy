import type { LlmClient } from "@brain/retrieval";
import { ChatLlm, ORG_PROVIDERS, publicHttpsBaseUrl, type LlmProvider } from "./llm.js";
import type { Persistence } from "./persistence.js";

type Stored = { provider: LlmProvider; model: string; baseUrl?: string; apiKey: string; updatedBy: string; updatedAt: string };
/** What an administrator may see about the organization's model. The key is never part of it. */
export type OrgModelSummary = Omit<Stored, "apiKey"> & { keySet: true };

/** Room for a reasoning model's thinking as well as the answer. */
const ORG_MAX_TOKENS = 4000;
/** A change made on another API instance is picked up within this long. */
const CACHE_MS = 30_000;

/**
 * The chat model an organization's admin chose in settings. The provider, model, address and API key are stored with the
 * key in Supabase Vault, keyed by organization, and the key stays inside the API.
 */
export class OrgModel {
  private cached?: { at: number; stored?: Stored; client?: ChatLlm };

  constructor(private readonly persistence: Persistence, private readonly transport?: typeof fetch,
    private readonly now: () => number = Date.now) {}

  private client(stored: Stored): ChatLlm {
    return new ChatLlm({ provider: stored.provider, apiKey: stored.apiKey, model: stored.model, baseUrl: stored.baseUrl,
      maxTokens: ORG_MAX_TOKENS, fetch: this.transport });
  }

  private async load(): Promise<{ stored?: Stored; client?: ChatLlm }> {
    if (this.cached && this.now() - this.cached.at < CACHE_MS) return this.cached;
    const row = await this.persistence.request("rpc/read_org_model", "POST", { organization: this.persistence.orgId });
    const stored: Stored | undefined = row && typeof row === "object" ? row : undefined;
    this.cached = { at: this.now(), stored, client: stored ? this.client(stored) : undefined };
    return this.cached;
  }

  /** The organization's model, or undefined when none is chosen. Throws when settings can't be read. */
  async current(): Promise<LlmClient | undefined> {
    return (await this.load()).client;
  }

  async summary(): Promise<OrgModelSummary | undefined> {
    const { stored } = await this.load();
    if (!stored) return undefined;
    const { apiKey: _key, ...rest } = stored;
    return { ...rest, keySet: true };
  }

  /**
   * Checks the settings with one small real call, then saves them. Without an apiKey the stored key is kept, so an
   * admin can change the model name without pasting the key again.
   */
  async save(actor: string, input: Record<string, unknown>): Promise<OrgModelSummary> {
    const provider = input.provider;
    if (typeof provider !== "string" || !(ORG_PROVIDERS as readonly string[]).includes(provider)) throw new Error("Invalid provider");
    if (typeof input.model !== "string" || !input.model.trim() || input.model.length > 200) throw new Error("Invalid model");
    if (input.apiKey !== undefined && (typeof input.apiKey !== "string" || !input.apiKey.trim() || input.apiKey.length > 2000)) {
      throw new Error("Invalid key");
    }
    if (input.baseUrl !== undefined && input.baseUrl !== null && input.baseUrl !== "" && typeof input.baseUrl !== "string") {
      throw new Error("Invalid address");
    }
    const given = typeof input.baseUrl === "string" && input.baseUrl.trim() ? publicHttpsBaseUrl(input.baseUrl.trim()) : undefined;
    if (provider === "openai_compatible" && !given) throw new Error("Invalid address");
    // Anthropic and OpenAI have fixed addresses; a custom one is only for compatible servers and gateways.
    const baseUrl = given;
    const keep = (await this.load().catch(() => ({ stored: undefined }))).stored;
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : keep?.apiKey;
    if (!apiKey) throw new Error("Invalid key");
    const stored: Stored = { provider: provider as LlmProvider, model: input.model.trim(), baseUrl, apiKey, updatedBy: actor,
      updatedAt: new Date().toISOString() };
    let client: ChatLlm;
    try {
      client = this.client(stored);
      await client.generate([{ citation: "[1]", text: "Broppy checks this connection." }], "What does Broppy check?");
    } catch (error) {
      throw new ModelCheckFailed(error instanceof Error && error.message === "Model request refused");
    }
    await this.persistence.request("rpc/store_org_model", "POST", { organization: this.persistence.orgId,
      provider_name: stored.provider, model_name: stored.model, endpoint: baseUrl ?? null, api_key: apiKey, actor });
    this.cached = { at: this.now(), stored, client };
    const { apiKey: _key, ...rest } = stored;
    return { ...rest, keySet: true };
  }

  async remove(): Promise<void> {
    await this.persistence.request("rpc/remove_org_model", "POST", { organization: this.persistence.orgId });
    this.cached = { at: this.now() };
  }
}

/** The provider refused the settings (wrong key, model name or address) or could not be reached. */
export class ModelCheckFailed extends Error {
  constructor(readonly refused: boolean) {
    super(refused ? "Model check refused" : "Model check failed");
  }
}
