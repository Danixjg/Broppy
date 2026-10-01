import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { LlmClient, SemanticEmbeddingClient } from "@brain/retrieval";
import { createHunyuanEmbeddingClientFromEnv } from "./embedding.js";
import { chatLlmFromEnv, estimateTokens, ModelCallError, ModelUnavailable, positiveInteger, type TokenUsage }
  from "./llm.js";

export interface BudgetLimits {
  /** Chat tokens in total. */
  chatTokens?: number;
  /** Embedding tokens in total. */
  embeddingTokens?: number;
  /** Model answers per UTC day. */
  dailyAnswers?: number;
}

interface Usage {
  chatTokens: number;
  embeddingTokens: number;
  day: string;
  answersToday: number;
}

const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const tally = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Counts model tokens and answers against the limits. With a file, the counts survive restarts. Anything wrong with
 * the file stops the model (fail closed) until the process restarts.
 */
export class UsageMeter {
  private memory: Usage;
  private broken = false;
  // Calls still running hold room against the limits, so questions asked at the same moment can't all get through
  // before any of them is counted.
  private readonly running = { chatTokens: 0, embeddingTokens: 0, answers: 0 };

  constructor(private readonly file: string | undefined, readonly limits: BudgetLimits,
    private readonly now: () => Date = () => new Date()) {
    this.memory = { chatTokens: 0, embeddingTokens: 0, day: dayOf(this.now()), answersToday: 0 };
  }

  /** The counts so far, with today's answers reset on a new UTC day. */
  usage(): Usage {
    if (this.broken) throw new ModelUnavailable("meter");
    let usage = this.memory;
    if (this.file) {
      try {
        let raw: string | undefined;
        try {
          raw = readFileSync(this.file, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (raw === undefined) {
          // Creating the file up front proves it can be written before any model call.
          usage = { chatTokens: 0, embeddingTokens: 0, day: dayOf(this.now()), answersToday: 0 };
          this.write(usage);
        } else {
          const parsed: unknown = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object" || !("chatTokens" in parsed) || !tally(parsed.chatTokens) ||
            !("embeddingTokens" in parsed) || !tally(parsed.embeddingTokens) || !("answersToday" in parsed) ||
            !tally(parsed.answersToday) || !("day" in parsed) || typeof parsed.day !== "string") {
            throw new Error("Invalid usage file");
          }
          usage = parsed as Usage;
        }
      } catch {
        this.broken = true;
        throw new ModelUnavailable("meter");
      }
    }
    const today = dayOf(this.now());
    return usage.day === today ? { ...usage } : { ...usage, day: today, answersToday: 0 };
  }

  /** Holds `reserve` tokens for one answer, or throws when the budget or today's allowance is taken. */
  beforeAnswer(reserve: number): void {
    const usage = this.usage();
    if (this.limits.chatTokens !== undefined && usage.chatTokens + this.running.chatTokens >= this.limits.chatTokens) {
      throw new ModelUnavailable("budget");
    }
    if (this.limits.dailyAnswers !== undefined && usage.answersToday + this.running.answers >= this.limits.dailyAnswers) {
      throw new ModelUnavailable("daily_limit");
    }
    this.running.chatTokens += reserve;
    this.running.answers += 1;
  }

  /** Releases what beforeAnswer held, then counts the tokens the call may be billed for, and its answer if any. */
  afterAnswer(reserved: number, tokens: number, answered: boolean): void {
    this.running.chatTokens -= reserved;
    this.running.answers -= 1;
    if (!tokens && !answered) return;
    const usage = this.usage();
    this.save({ ...usage, chatTokens: usage.chatTokens + tokens, answersToday: usage.answersToday + (answered ? 1 : 0) });
  }

  beforeEmbedding(reserve: number): void {
    if (this.embeddingSpent(this.usage())) throw new ModelUnavailable("budget");
    this.running.embeddingTokens += reserve;
  }

  afterEmbedding(reserved: number, tokens: number): void {
    this.running.embeddingTokens -= reserved;
    if (!tokens) return;
    const usage = this.usage();
    this.save({ ...usage, embeddingTokens: usage.embeddingTokens + tokens });
  }

  embeddingAvailable(): boolean {
    try {
      return !this.embeddingSpent(this.usage());
    } catch {
      return false;
    }
  }

  private embeddingSpent(usage: Usage): boolean {
    return this.limits.embeddingTokens !== undefined &&
      usage.embeddingTokens + this.running.embeddingTokens >= this.limits.embeddingTokens;
  }

  private save(usage: Usage): void {
    if (!this.file) {
      this.memory = usage;
      return;
    }
    try {
      this.write(usage);
    } catch {
      this.broken = true;
      throw new ModelUnavailable("meter");
    }
  }

  private write(usage: Usage): void {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(usage)}\n`);
    renameSync(temporary, this.file!);
  }
}

export interface UsageReportingLlm {
  /** The most one call may use, held against the budget while it runs. */
  reservation(context: Array<{ citation: string; text: string }>, question: string): number;
  generateWithUsage(context: Array<{ citation: string; text: string }>, question: string):
    Promise<{ text: string; usage: TokenUsage }>;
}

/** A chat model that only answers while the meter allows it, and records what each answer used. */
export class BudgetedLlm implements LlmClient {
  constructor(private readonly inner: UsageReportingLlm, readonly meter: UsageMeter) {}

  async generate(context: Array<{ citation: string; text: string }>, question: string): Promise<string> {
    return (await this.generateWithUsage(context, question)).text;
  }

  async generateWithUsage(context: Array<{ citation: string; text: string }>, question: string):
    Promise<{ text: string; usage: TokenUsage }> {
    const reserved = this.inner.reservation(context, question);
    this.meter.beforeAnswer(reserved);
    let tokens = 0;
    let answered = false;
    try {
      const result = await this.inner.generateWithUsage(context, question);
      tokens = result.usage.total;
      answered = true;
      return result;
    } catch (error) {
      // It may have reached the provider: count what it reported, or the whole reservation when that's unknown.
      if (error instanceof ModelCallError) tokens = error.usage?.total ?? reserved;
      throw error;
    } finally {
      this.meter.afterAnswer(reserved, tokens, answered);
    }
  }
}

export interface UsageReportingEmbedding {
  embedWithUsage(text: string): Promise<{ vector: number[]; tokens: number }>;
}

/** An embedding client that stops at its budget; sync asks `available()` first and keeps keyword search. */
export class BudgetedEmbedding implements SemanticEmbeddingClient {
  constructor(private readonly inner: UsageReportingEmbedding, readonly meter: UsageMeter) {}

  available(): boolean {
    return this.meter.embeddingAvailable();
  }

  async embed(text: string): Promise<number[]> {
    const reserved = estimateTokens(text);
    this.meter.beforeEmbedding(reserved);
    let tokens = 0;
    try {
      const result = await this.inner.embedWithUsage(text);
      tokens = result.tokens;
      return result.vector;
    } catch (error) {
      if (error instanceof ModelCallError) tokens = error.usage?.total ?? reserved;
      throw error;
    } finally {
      this.meter.afterEmbedding(reserved, tokens);
    }
  }
}

/**
 * The chat model and embeddings from settings, each behind the usage meter. Without settings, the built-in writer
 * answers and search uses keywords only.
 */
export function modelsFromEnv(env: NodeJS.ProcessEnv = process.env): { llm?: BudgetedLlm; embedding?: BudgetedEmbedding } {
  const chat = chatLlmFromEnv(env);
  const embedder = createHunyuanEmbeddingClientFromEnv(env);
  const file = env.LLM_USAGE_FILE?.trim() || undefined;
  const limits: BudgetLimits = {
    chatTokens: positiveInteger(env.LLM_TOKEN_BUDGET, "LLM_TOKEN_BUDGET"),
    embeddingTokens: positiveInteger(env.EMBEDDING_TOKEN_BUDGET, "EMBEDDING_TOKEN_BUDGET"),
    dailyAnswers: positiveInteger(env.LLM_DAILY_ANSWERS, "LLM_DAILY_ANSWERS")
  };
  if (!chat && !embedder) return {};
  // Past its free tokens, Tencent bills only if postpaid is turned on in its console. The budget is a second stop that
  // survives restarts, whatever that setting says.
  if (chat?.provider === "hunyuan" && (!file || limits.chatTokens === undefined)) {
    throw new Error("Hunyuan needs LLM_USAGE_FILE and LLM_TOKEN_BUDGET, so it stops before its free tokens run out");
  }
  if (embedder && (!file || limits.embeddingTokens === undefined)) {
    throw new Error("Hunyuan embeddings need LLM_USAGE_FILE and EMBEDDING_TOKEN_BUDGET, so they stop before their " +
      "free tokens run out");
  }
  const meter = new UsageMeter(file, limits);
  return {
    ...(chat ? { llm: new BudgetedLlm(chat, meter) } : {}),
    ...(embedder ? { embedding: new BudgetedEmbedding(embedder, meter) } : {})
  };
}
