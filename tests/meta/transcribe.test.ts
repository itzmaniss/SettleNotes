import { describe, expect, test } from "bun:test";
import { BudgetExceededError, MetaApiError, MetaTimeoutError, type AiCallLog } from "@/lib/meta/client";
import { transcribeCostUsd } from "@/lib/meta/pricing";
import {
  cleanKeywords,
  courseKeywords,
  createTranscriber,
  transcribeUrl,
  type TranscribeArgs,
  type TranscribeDeps,
  type TranscribeResult,
} from "@/lib/meta/transcribe";

const API_KEY = "test-meta-key-123";
const WAV = Buffer.from("fake-wav-bytes");
const BASE_URL = "https://api.meta.ai/v1";
const MODEL = "muse-voice-transcribe-1.0";

type Step = { status: number; body?: string; json?: unknown; headers?: Record<string, string> } | { throw: unknown };

type Harness = {
  deps: TranscribeDeps;
  calls: Array<{ url: string; init: RequestInit }>;
  logs: AiCallLog[];
  delays: number[];
};

function makeHarness(overrides: {
  steps?: Step[];
  getTodaySpend?: () => Promise<number>;
  logAiCall?: (row: AiCallLog) => Promise<void>;
  dailyBudgetUsd?: number;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
} = {}): Harness {
  const calls: Harness["calls"] = [];
  const logs: AiCallLog[] = [];
  const delays: number[] = [];
  const queue = [...(overrides.steps ?? [])];
  const queueFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const step = queue.shift();
    if (!step) throw new Error("fake fetch: no queued response");
    if ("throw" in step) throw step.throw;
    const body = step.json === undefined ? (step.body ?? "") : JSON.stringify(step.json);
    return new Response(body, { status: step.status, headers: step.headers });
  };
  let tick = 0;
  const deps: TranscribeDeps = {
    apiKey: API_KEY,
    baseUrl: overrides.baseUrl ?? BASE_URL,
    model: MODEL,
    dailyBudgetUsd: overrides.dailyBudgetUsd ?? 10,
    logAiCall: overrides.logAiCall ?? (async (row) => { logs.push(row); }),
    getTodaySpend: overrides.getTodaySpend ?? (async () => 0),
    fetch: overrides.fetch ?? (queueFetch as unknown as typeof fetch),
    sleep: async (ms) => { delays.push(ms); },
    now: () => (tick += 5), // every attempt measures 5ms
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
  };
  return { deps, calls, logs, delays };
}

function transcribe(harness: Harness, keywords: string[] = ["CS2030"], seconds = 30): Promise<TranscribeResult> {
  return createTranscriber(harness.deps).transcribe({ userId: "user-1", wav: WAV, seconds, keywords });
}

async function requestPart(call: { init: RequestInit }): Promise<Record<string, unknown>> {
  const form = call.init.body as FormData;
  const part = form.get("request") as Blob;
  return JSON.parse(await part.text()) as Record<string, unknown>;
}

async function audioPart(call: { init: RequestInit }): Promise<Blob> {
  const form = call.init.body as FormData;
  return form.get("audio") as Blob;
}

function neverRespectsAbortFetch(): typeof fetch {
  const hanging = (_url: string | URL, init?: RequestInit): Promise<Response> =>
    new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted", "AbortError")),
      );
    });
  return hanging as unknown as typeof fetch;
}

describe("transcribeUrl", () => {
  test("never produces a double /v1 and tolerates a trailing slash", () => {
    expect(transcribeUrl("https://api.meta.ai/v1")).toBe("https://api.meta.ai/v1/asr/transcribe");
    expect(transcribeUrl("https://api.meta.ai/v1/")).toBe("https://api.meta.ai/v1/asr/transcribe");
    expect(transcribeUrl("https://api.meta.ai")).toBe("https://api.meta.ai/v1/asr/transcribe");
    expect(transcribeUrl("https://api.meta.ai/")).toBe("https://api.meta.ai/v1/asr/transcribe");
  });
});

describe("cleanKeywords", () => {
  test("unique, trimmed, uppercased, course-code-like, separators dropped", () => {
    expect(
      cleanKeywords(["cs2030", "  MA2001 ", "CS 2030", "Computational Thinking", "", "cs-2103t", "GEA1000", "MA2001"]),
    ).toEqual(["CS2030", "MA2001", "CS2103T", "GEA1000"]);
  });

  test("caps the list at 20 entries", () => {
    const many = Array.from({ length: 30 }, (_, i) => `CS${1000 + i}`);
    expect(cleanKeywords(many)).toHaveLength(20);
  });
});

describe("courseKeywords", () => {
  test("unique non-null course values in order", () => {
    expect(
      courseKeywords([
        { course: "CS2030" },
        { course: null },
        { course: " cs2030 " },
        { course: "MA2001" },
        { course: "" },
        { course: undefined },
      ]),
    ).toEqual(["CS2030", "MA2001"]);
  });
});

describe("createTranscriber", () => {
  test("success: endpoint, headers, multipart fields, cost and the log row", async () => {
    const harness = makeHarness({
      steps: [{ status: 200, json: { sessionId: "s1", transcript: "How is the weather?", audioDurationMs: 30_000 } }],
    });
    const out = await transcribe(harness);

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0].url).toBe("https://api.meta.ai/v1/asr/transcribe");
    expect(harness.calls[0].init.method).toBe("POST");
    const headers = harness.calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);

    const request = await requestPart(harness.calls[0]);
    expect(request).toEqual({
      mode: "PUSH_TO_TALK",
      model: MODEL,
      audioEncoding: "WAV",
      languageBias: ["English"],
      keywords: ["CS2030"],
    });
    const audio = await audioPart(harness.calls[0]);
    expect(audio.type).toBe("audio/wav");
    expect(Buffer.from(await audio.arrayBuffer()).equals(WAV)).toBe(true);

    expect(out).toEqual({ text: "How is the weather?", seconds: 30, costUsd: transcribeCostUsd(30), latencyMs: 5 });
    expect(harness.logs).toEqual([
      {
        userId: "user-1",
        purpose: "transcribe",
        model: MODEL,
        audioSeconds: 30,
        costUsd: transcribeCostUsd(30),
        latencyMs: 5,
        ok: true,
      },
    ]);
  });

  test("the server's audioDurationMs is the billing authority, floored to whole seconds", async () => {
    const harness = makeHarness({
      steps: [{ status: 200, json: { transcript: "hi", audioDurationMs: 8240 } }],
    });
    const out = await transcribe(harness, ["CS2030"], 30);
    expect(out.costUsd).toBe(transcribeCostUsd(8));
    expect(harness.logs[0].audioSeconds).toBe(8);
  });

  test("keywords are cleaned before they reach the request", async () => {
    const harness = makeHarness({
      steps: [{ status: 200, json: { transcript: "hi" } }],
    });
    await transcribe(harness, ["cs2030", "not a code", "MA 2001", "cs2030"]);
    const request = await requestPart(harness.calls[0]);
    expect(request.keywords).toEqual(["CS2030", "MA2001"]);
  });

  test("an empty keyword list is omitted from the request", async () => {
    const harness = makeHarness({ steps: [{ status: 200, json: { transcript: "hi" } }] });
    await transcribe(harness, []);
    const request = await requestPart(harness.calls[0]);
    expect("keywords" in request).toBe(false);
  });

  test("429 twice then success: retried with Retry-After raising the backoff floor", async () => {
    const harness = makeHarness({
      steps: [
        { status: 429, body: "slow down", headers: { "retry-after": "2" } },
        { status: 429, body: "slow down" },
        { status: 200, json: { transcript: "ok", audioDurationMs: 30_000 } },
      ],
    });
    const out = await transcribe(harness);

    expect(harness.calls).toHaveLength(3);
    // max(500, 2000) then max(1000, 0)
    expect(harness.delays).toEqual([2000, 1000]);
    expect(harness.logs).toHaveLength(3);
    expect(harness.logs[0].ok).toBe(false);
    expect(harness.logs[0].costUsd ?? null).toBeNull();
    expect(harness.logs[2].ok).toBe(true);
    expect(out.text).toBe("ok");
  });

  test("5xx exhaustion throws MetaApiError after 3 retries, every attempt logged", async () => {
    const harness = makeHarness({
      steps: [
        { status: 500, body: "boom" },
        { status: 500, body: "boom" },
        { status: 500, body: "boom" },
        { status: 500, body: "boom" },
      ],
    });
    const err = await transcribe(harness).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(MetaApiError);
    expect((err as MetaApiError).status).toBe(500);
    expect(harness.calls).toHaveLength(4);
    expect(harness.delays).toEqual([500, 1000, 2000]);
    expect(harness.logs).toHaveLength(4);
    expect(harness.logs.every((row) => !row.ok)).toBe(true);
    expect(harness.logs.every((row) => row.costUsd == null)).toBe(true);
  });

  test("400 is not retried", async () => {
    const harness = makeHarness({ steps: [{ status: 400, body: "Audio is not a supported WAV file" }] });
    const err = await transcribe(harness).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(MetaApiError);
    expect((err as MetaApiError).status).toBe(400);
    expect((err as MetaApiError).message).toContain("Audio is not a supported WAV file");
    expect(harness.calls).toHaveLength(1);
    expect(harness.delays).toEqual([]);
    expect(harness.logs).toHaveLength(1);
    expect(harness.logs[0].ok).toBe(false);
  });

  test("timeout maps to MetaTimeoutError and is logged", async () => {
    const harness = makeHarness({ fetch: neverRespectsAbortFetch(), timeoutMs: 25 });
    const err = await transcribe(harness).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(MetaTimeoutError);
    expect((err as MetaTimeoutError).timeoutMs).toBe(25);
    expect(harness.logs).toHaveLength(1);
    expect(harness.logs[0].ok).toBe(false);
  });

  test("a network-level failure maps to a non-retried MetaApiError", async () => {
    const harness = makeHarness({ steps: [{ throw: new TypeError("fetch failed") }] });
    const err = await transcribe(harness).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(MetaApiError);
    expect((err as MetaApiError).status).toBe(0);
    expect(harness.calls).toHaveLength(1);
    expect(harness.delays).toEqual([]);
  });

  test("budget exceeded: no request, no log", async () => {
    const harness = makeHarness({ getTodaySpend: async () => 12, dailyBudgetUsd: 10 });
    const err = await transcribe(harness).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(harness.calls).toHaveLength(0);
    expect(harness.logs).toHaveLength(0);
  });

  test("a logging failure never breaks the transcription", async () => {
    const harness = makeHarness({
      steps: [{ status: 200, json: { transcript: "ok" } }],
      logAiCall: async () => {
        throw new Error("db down");
      },
    });
    const out = await transcribe(harness);
    expect(out.text).toBe("ok");
  });

  test("no error message or log row ever contains the API key", async () => {
    const cases: Array<{ run: () => Promise<unknown>; logs: () => AiCallLog[] }> = [];
    {
      const harness = makeHarness({ steps: [{ status: 400, body: "bad request: audio is not a supported WAV file" }] });
      cases.push({ run: () => transcribe(harness), logs: () => harness.logs });
    }
    {
      const harness = makeHarness({
        steps: [
          { status: 500, body: "boom" },
          { status: 500, body: "boom" },
          { status: 500, body: "boom" },
          { status: 500, body: "boom" },
        ],
      });
      cases.push({ run: () => transcribe(harness), logs: () => harness.logs });
    }
    {
      const harness = makeHarness({ fetch: neverRespectsAbortFetch(), timeoutMs: 10 });
      cases.push({ run: () => transcribe(harness), logs: () => harness.logs });
    }
    {
      const harness = makeHarness({ steps: [{ throw: new TypeError("fetch failed") }] });
      cases.push({ run: () => transcribe(harness), logs: () => harness.logs });
    }
    for (const { run, logs } of cases) {
      const err = await run().then(
        (value) => value,
        (e) => e,
      );
      expect(String((err as Error).message)).not.toContain(API_KEY);
      expect(JSON.stringify(logs())).not.toContain(API_KEY);
    }
  });

  test("an omitted userId logs a null user", async () => {
    const harness = makeHarness({ steps: [{ status: 200, json: { transcript: "hi" } }] });
    await createTranscriber(harness.deps).transcribe({ wav: WAV, seconds: 10, keywords: [] });
    expect(harness.logs[0].userId ?? null).toBeNull();
  });
});

// The injected arg shape the voice handler passes through unchanged.
const argsShape: TranscribeArgs | undefined = undefined;
void argsShape;
