import { describe, expect, test } from 'bun:test';
import type { Response, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import { z } from 'zod';
import {
  BudgetExceededError,
  MetaApiError,
  MetaOutputError,
  MetaTimeoutError,
  createMetaClient,
} from '../../lib/meta/client';
import { sparkCostUsd } from '../../lib/meta/pricing';
import type { AiCallLog, MetaClientDeps, ResponsesCreateFn } from '../../lib/meta/client';

const TestSchema = z.object({ name: z.string(), score: z.number().nullable() });
const ValidJson = JSON.stringify({ name: 'derivatives', score: null });

function responseWith(text: string): Response {
  return {
    id: 'resp_test',
    object: 'response',
    output_text: text,
    output: [],
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      total_tokens: 1500,
      input_tokens_details: { cache_write_tokens: 0, cached_tokens: 200 },
      output_tokens_details: { reasoning_tokens: 100 },
    },
  } as unknown as Response;
}

class HttpLikeError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  constructor(status: number, headers: Record<string, string> = {}) {
    super(`http ${status}`);
    this.name = 'HttpLikeError';
    this.status = status;
    this.headers = headers;
  }
}

type Step = { ok: true; value: Response } | { ok: false; error: unknown };
const ok = (text: string): Step => ({ ok: true, value: responseWith(text) });
const fail = (error: unknown): Step => ({ ok: false, error });

type CapturedCall = { body: ResponseCreateParamsNonStreaming; options?: { signal?: AbortSignal } };

function makeHarness(overrides?: {
  steps?: Step[];
  getTodaySpend?: () => Promise<number>;
  logAiCall?: (row: AiCallLog) => Promise<void>;
  dailyBudgetUsd?: number;
  create?: ResponsesCreateFn;
}) {
  const calls: CapturedCall[] = [];
  const logs: AiCallLog[] = [];
  const delays: number[] = [];
  const queue = [...(overrides?.steps ?? [])];
  const innerCreate: ResponsesCreateFn = () => {
    const step = queue.shift();
    if (!step) return Promise.reject(new Error('fake client: no queued step'));
    return step.ok ? Promise.resolve(step.value) : Promise.reject(step.error);
  };
  const rawCreate = overrides?.create ?? innerCreate;
  const create: ResponsesCreateFn = (body, options) => {
    calls.push({ body, options });
    return rawCreate(body, options);
  };

  let tick = 0;
  const deps: MetaClientDeps = {
    openai: { responses: { create } },
    model: 'muse-spark-1.3',
    dailyBudgetUsd: overrides?.dailyBudgetUsd ?? 10,
    logAiCall: overrides?.logAiCall ?? (async (row) => { logs.push(row); }),
    getTodaySpend: overrides?.getTodaySpend ?? (async () => 0),
    sleep: async (ms) => { delays.push(ms); },
    now: () => (tick += 10), // deterministic latency: every attempt measures 10ms
  };
  return { deps, calls, logs, delays };
}

function generate(harness: ReturnType<typeof makeHarness>, timeoutMs?: number) {
  const client = createMetaClient(harness.deps);
  return client.generateObject({
    purpose: 'checklist',
    userId: 'user-1',
    schema: TestSchema,
    schemaName: 'TestOutput',
    system: 'You are a stable system prompt.',
    input: [
      { type: 'text', text: 'hello' },
      { type: 'image', base64: 'QUJD', mimeType: 'image/png' },
      { type: 'pdf', base64: 'UERG', filename: 'notes.pdf' },
    ],
    effort: 'low',
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

type LooseMessage = { type: string; role: string; content: Array<Record<string, unknown>> };

function firstCallBody(harness: ReturnType<typeof makeHarness>): ResponseCreateParamsNonStreaming {
  return harness.calls[0].body;
}

function firstCallContent(harness: ReturnType<typeof makeHarness>): Array<Record<string, unknown>> {
  return (firstCallBody(harness).input as unknown as LooseMessage[])[0].content;
}

describe('createMetaClient.generateObject', () => {
  test('success: request shape, input part mapping, usage to cost, ok log', async () => {
    const harness = makeHarness({ steps: [ok(ValidJson)] });
    const { data, usage } = await generate(harness);

    expect(harness.calls.length).toBe(1);
    const body = firstCallBody(harness);
    expect(body.model).toBe('muse-spark-1.3');
    expect(body.instructions).toBe('You are a stable system prompt.');
    expect(body.reasoning?.effort).toBe('low');

    const format = body.text?.format as
      | { type: string; name: string; strict?: boolean | null; schema: Record<string, unknown> }
      | undefined;
    expect(format?.type).toBe('json_schema');
    expect(format?.name).toBe('TestOutput');
    expect(format?.strict).toBe(true);
    expect(format?.schema).toBeTypeOf('object');

    const content = firstCallContent(harness);
    expect(content[0]).toEqual({ type: 'input_text', text: 'hello' });
    expect(content[1]).toEqual({
      type: 'input_image',
      image_url: 'data:image/png;base64,QUJD',
      detail: 'auto',
    });
    expect(content[2]).toEqual({
      type: 'input_file',
      filename: 'notes.pdf',
      file_data: 'data:application/pdf;base64,UERG',
    });
    expect(harness.calls[0].options?.signal).toBeInstanceOf(AbortSignal);

    // 800 uncached in * 1.25 + 200 cached in * 0.15 + 500 out * 4.25, per 1M
    expect(data).toEqual({ name: 'derivatives', score: null });
    expect(usage).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      cachedTokens: 200,
      costUsd: 0.003155,
      latencyMs: 10,
    });

    expect(harness.logs.length).toBe(1);
    const log = harness.logs[0];
    expect(log.ok).toBe(true);
    expect(log.purpose).toBe('checklist');
    expect(log.model).toBe('muse-spark-1.3');
    expect(log.userId).toBe('user-1');
    expect(log.inputTokens).toBe(1000);
    expect(log.outputTokens).toBe(500);
    expect(log.cachedTokens).toBe(200);
    expect(log.audioSeconds).toBeNull();
    expect(log.costUsd).toBe(0.003155);
    expect(harness.delays).toEqual([]);
  });

  test('invalid JSON then valid: retries once and succeeds after 2 calls', async () => {
    const harness = makeHarness({ steps: [ok('this is not json'), ok(ValidJson)] });
    const { data } = await generate(harness);
    expect(harness.calls.length).toBe(2);
    expect(data).toEqual({ name: 'derivatives', score: null });
    expect(harness.delays).toEqual([]);
    expect(harness.logs.map((l) => l.ok)).toEqual([false, true]);
  });

  test('a bad-output attempt is logged with its tokens and cost', async () => {
    const harness = makeHarness({ steps: [ok('not json'), ok(ValidJson)] });
    await generate(harness);
    expect(harness.logs[0]).toMatchObject({
      ok: false,
      inputTokens: 1000,
      outputTokens: 500,
      cachedTokens: 200,
      costUsd: 0.003155,
    });
  });

  test('invalid JSON twice: MetaOutputError after the one retry', async () => {
    const harness = makeHarness({ steps: [ok('nope'), ok('still nope')] });
    let caught: unknown;
    try {
      await generate(harness);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MetaOutputError);
    expect((caught as Error).message).toContain('TestOutput');
    expect(harness.calls.length).toBe(2);
    expect(harness.logs.map((l) => l.ok)).toEqual([false, false]);
  });

  test('zod-invalid JSON then valid: retries once and succeeds', async () => {
    const harness = makeHarness({ steps: [ok(JSON.stringify({ name: 42 })), ok(ValidJson)] });
    const { data } = await generate(harness);
    expect(harness.calls.length).toBe(2);
    expect(data).toEqual({ name: 'derivatives', score: null });
  });

  test('429 twice then success: exponential backoff delays recorded', async () => {
    const harness = makeHarness({
      steps: [fail(new HttpLikeError(429)), fail(new HttpLikeError(429)), ok(ValidJson)],
    });
    const { data } = await generate(harness);
    expect(harness.calls.length).toBe(3);
    expect(harness.delays).toEqual([500, 1000]);
    expect(data).toEqual({ name: 'derivatives', score: null });
    expect(harness.logs.map((l) => l.ok)).toEqual([false, false, true]);
  });

  test('429 beyond max retries: MetaApiError after 4 calls and 3 backoffs', async () => {
    const harness = makeHarness({
      steps: [fail(new HttpLikeError(429)), fail(new HttpLikeError(429)), fail(new HttpLikeError(429)), fail(new HttpLikeError(429))],
    });
    let caught: unknown;
    try {
      await generate(harness);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MetaApiError);
    expect((caught as MetaApiError).status).toBe(429);
    expect(harness.calls.length).toBe(4);
    expect(harness.delays).toEqual([500, 1000, 2000]);
    expect(harness.logs.map((l) => l.ok)).toEqual([false, false, false, false]);
  });

  test('429 with Retry-After header waits at least that long', async () => {
    const harness = makeHarness({
      steps: [fail(new HttpLikeError(429, { 'retry-after': '2' })), ok(ValidJson)],
    });
    await generate(harness);
    expect(harness.delays).toEqual([2000]);
  });

  test('5xx is retried like a rate limit', async () => {
    const harness = makeHarness({ steps: [fail(new HttpLikeError(503)), ok(ValidJson)] });
    await generate(harness);
    expect(harness.calls.length).toBe(2);
    expect(harness.delays).toEqual([500]);
  });

  test('4xx non-429 is not retried', async () => {
    const harness = makeHarness({ steps: [fail(new HttpLikeError(400))] });
    let caught: unknown;
    try {
      await generate(harness);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MetaApiError);
    expect((caught as MetaApiError).status).toBe(400);
    expect(harness.calls.length).toBe(1);
    expect(harness.delays).toEqual([]);
  });

  test('errors without a status are wrapped as status 0 and not retried', async () => {
    const harness = makeHarness({ steps: [fail(new Error('socket hangup'))] });
    let caught: unknown;
    try {
      await generate(harness);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MetaApiError);
    expect((caught as MetaApiError).status).toBe(0);
    expect(harness.calls.length).toBe(1);
  });

  test('budget exceeded: BudgetExceededError and no openai call, boundary inclusive', async () => {
    const atLimit = makeHarness({ getTodaySpend: async () => 10 });
    let caught: unknown;
    try {
      await generate(atLimit);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BudgetExceededError);
    expect(atLimit.calls.length).toBe(0);
    expect(atLimit.logs.length).toBe(0);

    const overLimit = makeHarness({ getTodaySpend: async () => 12.5 });
    try {
      await generate(overLimit);
      throw new Error('expected BudgetExceededError');
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
    }
    expect(overLimit.calls.length).toBe(0);
  });

  test('timeout: aborts the request and throws MetaTimeoutError', async () => {
    let abortObserved = false;
    const harness = makeHarness({
      create: (_body, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            abortObserved = true;
            reject(new Error('request aborted'));
          });
        }),
    });
    let caught: unknown;
    try {
      await generate(harness, 15);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MetaTimeoutError);
    expect((caught as MetaTimeoutError).timeoutMs).toBe(15);
    expect(abortObserved).toBe(true);
    expect(harness.calls.length).toBe(1);
    expect(harness.logs.length).toBe(1);
    expect(harness.logs[0].ok).toBe(false);
  });

  test('logAiCall rejection is swallowed on success and on failure', async () => {
    const boom = async () => {
      throw new Error('db down');
    };
    const successHarness = makeHarness({ steps: [ok(ValidJson)], logAiCall: boom });
    const { data } = await generate(successHarness);
    expect(data).toEqual({ name: 'derivatives', score: null });

    const failureHarness = makeHarness({ steps: [fail(new HttpLikeError(400))], logAiCall: boom });
    let caught: unknown;
    try {
      await generate(failureHarness);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MetaApiError);
  });
});

describe('createOpenAIClient', () => {
  test('builds an SDK client for the given baseURL without env access', async () => {
    const { createOpenAIClient } = await import('../../lib/meta/client');
    const client = createOpenAIClient('test-key', 'https://meta.example/v1');
    expect(client.baseURL).toBe('https://meta.example/v1');
    expect(typeof client.responses.create).toBe('function');
  });
});

describe('per call model override', () => {
  function overrideArgs(model?: string) {
    return {
      purpose: 'understand' as const,
      userId: 'user-1',
      schema: TestSchema,
      schemaName: 'TestOutput',
      system: 'You are a stable system prompt.',
      input: [{ type: 'text' as const, text: 'hello' }],
      effort: 'minimal' as const,
      ...(model != null ? { model } : {}),
    };
  }

  test('an explicit model is used in the request body and the success log', async () => {
    const harness = makeHarness({ steps: [ok(ValidJson)] });
    const client = createMetaClient(harness.deps);
    await client.generateObject(overrideArgs('muse-spark-1.2'));

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0].body.model).toBe('muse-spark-1.2');
    expect(harness.logs).toHaveLength(1);
    expect(harness.logs[0].model).toBe('muse-spark-1.2');
    expect(harness.logs[0].ok).toBe(true);
  });

  test('without an override the client default model is used, as before', async () => {
    const harness = makeHarness({ steps: [ok(ValidJson)] });
    const client = createMetaClient(harness.deps);
    await client.generateObject(overrideArgs());

    expect(harness.calls[0].body.model).toBe('muse-spark-1.3');
    expect(harness.logs[0].model).toBe('muse-spark-1.3');
  });

  test('an unknown model id still prices at the Spark rates and is logged as sent', async () => {
    const harness = makeHarness({ steps: [ok(ValidJson)] });
    const client = createMetaClient(harness.deps);
    const { usage } = await client.generateObject(overrideArgs('some-future-model'));

    // usage: 1000 input (200 cached), 500 output, priced by the shared table.
    expect(usage.costUsd).toBe(sparkCostUsd({ inputTokens: 1000, cachedTokens: 200, outputTokens: 500 }));
    expect(harness.logs[0].model).toBe('some-future-model');
    expect(harness.logs[0].costUsd).toBe(usage.costUsd);
  });

  test('a failed attempt also logs the model actually used', async () => {
    // 400 is not retryable, so exactly one attempt and one log row.
    const harness = makeHarness({ steps: [fail(new HttpLikeError(400))] });
    const client = createMetaClient(harness.deps);
    await client.generateObject(overrideArgs('muse-spark-1.2')).catch(() => {});

    expect(harness.logs).toHaveLength(1);
    expect(harness.logs[0].model).toBe('muse-spark-1.2');
    expect(harness.logs[0].ok).toBe(false);
  });
});
