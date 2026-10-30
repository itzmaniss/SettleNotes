import OpenAI from 'openai';
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseInputContent,
} from 'openai/resources/responses/responses';
import { z } from 'zod';
import { sparkCostUsd } from './pricing';
import { assertStrictSubset, toStrictJsonSchema } from './strict-schema';

export type AiPurpose = 'understand' | 'checklist' | 'flashcards' | 'math' | 'transcribe';

// Meta Muse Spark rejects effort "none"; see docs/meta-api/reasoning.md.
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type InputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; base64: string; mimeType?: string }
  | { type: 'pdf'; base64: string; filename: string };

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  latencyMs: number;
};

// Structurally identical to lib/db LogAiCallInput, defined locally so this
// module never imports lib/db (everything is injected).
export type AiCallLog = {
  userId?: string | null;
  purpose: string;
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  audioSeconds?: number | null;
  costUsd?: number | null;
  latencyMs?: number | null;
  ok: boolean;
};

export type GenerateObjectOptions<T> = {
  purpose: AiPurpose;
  userId?: string;
  schema: z.ZodType<T>;
  schemaName: string;
  system: string;
  input: InputPart[];
  effort: ReasoningEffort;
  timeoutMs?: number;
};

// Minimal structural slice of the SDK client that generateObject actually
// uses, so tests can pass a fake object instead of a real OpenAI instance.
export type ResponsesCreateFn = (
  body: ResponseCreateParamsNonStreaming,
  options?: { signal?: AbortSignal },
) => Promise<Response>;

export type MetaClientDeps = {
  openai: { responses: { create: ResponsesCreateFn } };
  model: string;
  dailyBudgetUsd: number;
  logAiCall: (row: AiCallLog) => Promise<void>;
  getTodaySpend: () => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type MetaClient = {
  generateObject: <T>(opts: GenerateObjectOptions<T>) => Promise<{ data: T; usage: Usage }>;
};

export class BudgetExceededError extends Error {
  readonly spentUsd: number;
  readonly budgetUsd: number;
  constructor(spentUsd: number, budgetUsd: number) {
    super(`Daily AI budget exceeded: spent $${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} limit`);
    this.name = 'BudgetExceededError';
    this.spentUsd = spentUsd;
    this.budgetUsd = budgetUsd;
  }
}

export class MetaApiError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  constructor(status: number, message: string, retryAfterMs: number | null = null) {
    super(`Meta API error (HTTP ${status}): ${message}`);
    this.name = 'MetaApiError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export class MetaTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Meta API call timed out after ${timeoutMs}ms`);
    this.name = 'MetaTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class MetaOutputError extends Error {
  constructor(schemaName: string, detail: string) {
    super(`Model output did not match schema "${schemaName}": ${detail}`);
    this.name = 'MetaOutputError';
  }
}

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_API_RETRIES = 3; // 429/5xx retries, per ARCHITECTURE 4.1
const BASE_BACKOFF_MS = 500; // docs/meta-api/pricing-rate-limits.md: start at 500ms, double each time
const OUTPUT_ATTEMPTS = 2; // initial attempt + ONE retry on parse/validation failure

function toContentPart(part: InputPart): ResponseInputContent {
  switch (part.type) {
    case 'text':
      return { type: 'input_text', text: part.text };
    case 'image':
      // image_url is a plain string on the Responses API (data URL inline).
      return {
        type: 'input_image',
        image_url: `data:${part.mimeType ?? 'image/jpeg'};base64,${part.base64}`,
        detail: 'auto',
      };
    case 'pdf':
      return { type: 'input_file', filename: part.filename, file_data: `data:application/pdf;base64,${part.base64}` };
  }
}

function toApiError(err: unknown): MetaApiError {
  if (err instanceof MetaApiError) return err;
  const maybeStatus = (err as { status?: unknown } | null)?.status;
  const status = typeof maybeStatus === 'number' ? maybeStatus : 0;
  const headers = (err as { headers?: Record<string, string> | null | undefined } | null)?.headers;
  const retryAfterRaw = headers ? headers['retry-after'] : undefined;
  const retryAfterSeconds = Number(retryAfterRaw);
  const retryAfterMs =
    retryAfterRaw != null && Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : null;
  const message = err instanceof Error ? err.message : String(err);
  return new MetaApiError(status, message, retryAfterMs);
}

type ParseResult<T> = { ok: true; data: T } | { ok: false; detail: string };

function parseOutput<T>(response: Response, schema: z.ZodType<T>): ParseResult<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(response.output_text);
  } catch (err) {
    return { ok: false, detail: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return { ok: false, detail: issue ? `${where}: ${issue.message}` : 'validation failed' };
  }
  return { ok: true, data: result.data };
}

export function createMetaClient(deps: MetaClientDeps): MetaClient {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());

  // Logging must never break the call path it observes.
  async function safeLog(row: AiCallLog): Promise<void> {
    try {
      await deps.logAiCall(row);
    } catch {
      // swallowed on purpose
    }
  }

  async function createWithTimeout(body: ResponseCreateParamsNonStreaming, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await deps.openai.responses.create(body, { signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) throw new MetaTimeoutError(timeoutMs);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function generateObject<T>(opts: GenerateObjectOptions<T>): Promise<{ data: T; usage: Usage }> {
    // Budget guard before anything else: a refused call makes no API attempt
    // and costs nothing, so it is not logged.
    const spentUsd = await deps.getTodaySpend();
    if (spentUsd >= deps.dailyBudgetUsd) {
      throw new BudgetExceededError(spentUsd, deps.dailyBudgetUsd);
    }

    // Fail bad schemas locally instead of as a live HTTP 400.
    const jsonSchema = toStrictJsonSchema(opts.schema);
    assertStrictSubset(jsonSchema);

    const body: ResponseCreateParamsNonStreaming = {
      model: deps.model,
      instructions: opts.system,
      input: [{ type: 'message', role: 'user', content: opts.input.map(toContentPart) }],
      reasoning: { effort: opts.effort },
      text: {
        format: { type: 'json_schema', name: opts.schemaName, schema: jsonSchema, strict: true },
      },
    };

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let outputRetriesLeft = OUTPUT_ATTEMPTS - 1;
    let apiRetriesLeft = MAX_API_RETRIES;
    let backoffStep = 0;

    for (;;) {
      const attemptStart = now();
      let response: Response;
      try {
        response = await createWithTimeout(body, timeoutMs);
      } catch (err) {
        const latencyMs = now() - attemptStart;
        if (err instanceof MetaTimeoutError) {
          await safeLog({
            userId: opts.userId ?? null,
            purpose: opts.purpose,
            model: deps.model,
            latencyMs,
            ok: false,
          });
          throw err;
        }
        const apiErr = toApiError(err);
        await safeLog({
          userId: opts.userId ?? null,
          purpose: opts.purpose,
          model: deps.model,
          latencyMs,
          ok: false,
        });
        const retryable = apiErr.status === 429 || apiErr.status >= 500;
        if (retryable && apiRetriesLeft > 0) {
          apiRetriesLeft -= 1;
          // Exponential backoff; Retry-After (seconds) raises the floor.
          await sleep(Math.max(BASE_BACKOFF_MS * 2 ** backoffStep, apiErr.retryAfterMs ?? 0));
          backoffStep += 1;
          continue;
        }
        throw apiErr;
      }
      const latencyMs = now() - attemptStart;

      const parsed = parseOutput(response, opts.schema);
      const usage = response.usage;
      const inputTokens = usage?.input_tokens ?? 0;
      const outputTokens = usage?.output_tokens ?? 0;
      // cached_tokens sits in usage.input_tokens_details; it is a subset of
      // input_tokens (billed at the cheaper cached rate).
      const cachedTokens = usage?.input_tokens_details?.cached_tokens ?? 0;
      const costUsd = sparkCostUsd({ inputTokens, cachedTokens, outputTokens });
      if (parsed.ok) {
        await safeLog({
          userId: opts.userId ?? null,
          purpose: opts.purpose,
          model: deps.model,
          inputTokens,
          outputTokens,
          cachedTokens,
          audioSeconds: null,
          costUsd,
          latencyMs,
          ok: true,
        });
        return { data: parsed.data, usage: { inputTokens, outputTokens, cachedTokens, costUsd, latencyMs } };
      }

      // A bad-output attempt was still billed, so its tokens count toward the budget.
      await safeLog({
        userId: opts.userId ?? null,
        purpose: opts.purpose,
        model: deps.model,
        inputTokens,
        outputTokens,
        cachedTokens,
        costUsd,
        latencyMs,
        ok: false,
      });
      if (outputRetriesLeft > 0) {
        outputRetriesLeft -= 1;
        continue;
      }
      throw new MetaOutputError(opts.schemaName, parsed.detail);
    }
  }

  return { generateObject };
}

export function createOpenAIClient(apiKey: string, baseURL: string): OpenAI {
  return new OpenAI({ apiKey, baseURL });
}
