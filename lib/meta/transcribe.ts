// Muse Voice Transcribe client (docs/meta-api/speech-to-text.md): multipart
// POST of a request JSON part plus a WAV part to /v1/asr/transcribe, with the
// same budget guard, retry and call-logging rules as lib/meta/client.ts.
import {
  BudgetExceededError,
  MetaApiError,
  MetaTimeoutError,
  type AiCallLog,
} from "@/lib/meta/client";
import { transcribeCostUsd } from "@/lib/meta/pricing";

// The docs set no keyword cap; a small list keeps the bias effective.
export const MAX_TRANSCRIBE_KEYWORDS = 20;
const BASE_BACKOFF_MS = 500;
const MAX_API_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ERROR_CHARS = 200;
const LANGUAGE_BIAS = ["English"] as const;
// Appended to a base URL that already ends in /v1 (see transcribeUrl).
const TRANSCRIBE_PATH = "/asr/transcribe";

export type TranscribeArgs = {
  userId?: string;
  wav: Buffer;
  seconds: number;
  keywords: string[];
};

export type TranscribeResult = {
  text: string;
  seconds: number;
  costUsd: number;
  latencyMs: number;
};

export type Transcriber = {
  transcribe: (args: TranscribeArgs) => Promise<TranscribeResult>;
};

export type TranscribeDeps = {
  apiKey: string;
  baseUrl: string;
  model: string;
  dailyBudgetUsd: number;
  logAiCall: (row: AiCallLog) => Promise<void>;
  getTodaySpend: () => Promise<number>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
};

// The student's course codes as raw keyword candidates: unique non-empty
// course values. Code-like filtering and capping happen in cleanKeywords.
export function courseKeywords(
  tasks: ReadonlyArray<{ course: string | null | undefined }>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const task of tasks) {
    const course = task.course?.trim();
    if (course == null || course.length === 0) continue;
    const key = course.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(course);
  }
  return out;
}

// Course-code-like only (letters, then 3 to 4 digits, optional trailing
// letter), separators dropped so "cs 2030" biases as "CS2030". Course names a
// student typed as words are dropped rather than biased on.
const COURSE_CODE_RE = /^[A-Z]{2,4}\d{3,4}[A-Z]?$/;

export function cleanKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of keywords) {
    if (seen.size >= MAX_TRANSCRIBE_KEYWORDS) break;
    const normalized = raw.trim().toUpperCase().replace(/[\s.-]+/g, "");
    if (normalized.length === 0 || !COURSE_CODE_RE.test(normalized)) continue;
    seen.add(normalized);
  }
  return [...seen];
}

// The documented endpoint is POST /v1/asr/transcribe. Our env base already
// ends in /v1, so never produce a double /v1, and cope with a trailing slash.
export function transcribeUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}${TRANSCRIBE_PATH}` : `${base}/v1${TRANSCRIBE_PATH}`;
}

type TranscribeResponse = {
  transcript?: unknown;
  audioDurationMs?: unknown;
};

export function createTranscriber(deps: TranscribeDeps): Transcriber {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Logging must never break the call it observes.
  async function safeLog(row: AiCallLog): Promise<void> {
    try {
      await deps.logAiCall(row);
    } catch {
      // swallowed on purpose
    }
  }

  function requestJson(keywords: string[]): Record<string, unknown> {
    // Same settings as the realtime handshake minus authorization; a voice
    // note is a single turn, so PUSH_TO_TALK. languageBias per ARCHITECTURE 4.6.
    const body: Record<string, unknown> = {
      mode: "PUSH_TO_TALK",
      model: deps.model,
      audioEncoding: "WAV",
      languageBias: [...LANGUAGE_BIAS],
    };
    const cleaned = cleanKeywords(keywords);
    if (cleaned.length > 0) body.keywords = cleaned;
    return body;
  }

  async function postWithTimeout(url: string, form: FormData): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // fetch sets the multipart Content-Type (with boundary) itself; the
      // Authorization header lives only in this request, never in a log or error.
      return await doFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${deps.apiKey}` },
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new MetaTimeoutError(timeoutMs);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function transcribe(args: TranscribeArgs): Promise<TranscribeResult> {
    // Budget guard before anything else: a refused call makes no request and
    // is not logged, matching lib/meta/client.ts.
    const spentUsd = await deps.getTodaySpend();
    if (spentUsd >= deps.dailyBudgetUsd) {
      throw new BudgetExceededError(spentUsd, deps.dailyBudgetUsd);
    }

    const url = transcribeUrl(deps.baseUrl);
    const form = new FormData();
    form.append(
      "request",
      new Blob([JSON.stringify(requestJson(args.keywords))], { type: "application/json" }),
      "request.json",
    );
    form.append("audio", new Blob([new Uint8Array(args.wav)], { type: "audio/wav" }), "audio.wav");

    let retriesLeft = MAX_API_RETRIES;
    let backoffStep = 0;

    for (;;) {
      const attemptStart = now();
      let response: Response;
      try {
        response = await postWithTimeout(url, form);
      } catch (err) {
        const latencyMs = now() - attemptStart;
        if (err instanceof MetaTimeoutError) {
          await safeLog({
            userId: args.userId ?? null,
            purpose: "transcribe",
            model: deps.model,
            audioSeconds: billedSeconds(args.seconds, null),
            latencyMs,
            ok: false,
          });
          throw err;
        }
        // Network-level failures carry no status and are not retried, like
        // the chat client treats status 0.
        const apiErr = new MetaApiError(0, describeNetworkError(err), null);
        await safeLog({
          userId: args.userId ?? null,
          purpose: "transcribe",
          model: deps.model,
          latencyMs,
          ok: false,
        });
        throw apiErr;
      }
      const latencyMs = now() - attemptStart;

      if (!response.ok) {
        const apiErr = new MetaApiError(
          response.status,
          await errorMessage(response),
          retryAfterMsOf(response),
        );
        await safeLog({
          userId: args.userId ?? null,
          purpose: "transcribe",
          model: deps.model,
          audioSeconds: billedSeconds(args.seconds, null),
          latencyMs,
          ok: false,
        });
        const retryable = apiErr.status === 429 || apiErr.status >= 500;
        if (retryable && retriesLeft > 0) {
          retriesLeft -= 1;
          // Exponential backoff; Retry-After (seconds) raises the floor.
          await sleep(Math.max(BASE_BACKOFF_MS * 2 ** backoffStep, apiErr.retryAfterMs ?? 0));
          backoffStep += 1;
          continue;
        }
        throw apiErr;
      }

      let data: TranscribeResponse;
      try {
        data = (await response.json()) as TranscribeResponse;
      } catch {
        const apiErr = new MetaApiError(response.status, "transcription response was not valid JSON", null);
        await safeLog({
          userId: args.userId ?? null,
          purpose: "transcribe",
          model: deps.model,
          latencyMs,
          ok: false,
        });
        throw apiErr;
      }

      const text = typeof data.transcript === "string" ? data.transcript : "";
      const billed = billedSeconds(args.seconds, data.audioDurationMs);
      const costUsd = transcribeCostUsd(billed);
      await safeLog({
        userId: args.userId ?? null,
        purpose: "transcribe",
        model: deps.model,
        audioSeconds: billed,
        costUsd,
        latencyMs,
        ok: true,
      });
      return { text, seconds: args.seconds, costUsd, latencyMs };
    }
  }

  return {
    transcribe: (args: TranscribeArgs) => transcribe(args),
  };
}

// Billed audio is whole seconds, rounded down, and the server's own duration
// is the billing authority when it reports one (docs, "Pricing").
function billedSeconds(clientSeconds: number, audioDurationMs: unknown): number {
  const serverMs =
    typeof audioDurationMs === "number" && Number.isFinite(audioDurationMs) && audioDurationMs > 0
      ? audioDurationMs
      : null;
  const raw = serverMs != null ? serverMs / 1000 : clientSeconds;
  return Math.max(0, Math.floor(raw));
}

function retryAfterMsOf(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (raw == null) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

// First line of the response body, capped: error text stays short and can
// never contain the API key (which travels only in the request header).
async function errorMessage(response: Response): Promise<string> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    return `HTTP ${response.status}`;
  }
  return firstLine(body) || `HTTP ${response.status}`;
}

function describeNetworkError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return firstLine(msg).slice(0, MAX_ERROR_CHARS) || "could not reach the transcription service";
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

// Lazily wires env and the DB logger: importing this module must never read
// env or touch the DB, so the real deps resolve inside the first call.
export function createRealTranscriber(): Transcriber {
  let impl: Promise<Transcriber> | undefined;
  return {
    transcribe: async (args: TranscribeArgs) => {
      impl ??= buildRealTranscriber();
      return (await impl).transcribe(args);
    },
  };
}

async function buildRealTranscriber(): Promise<Transcriber> {
  const [{ env }, { logAiCall, todaysAiSpend }] = await Promise.all([
    import("@/lib/env"),
    import("@/lib/db/queries"),
  ]);
  return createTranscriber({
    apiKey: env.MODEL_API_KEY,
    baseUrl: env.META_API_BASE_URL,
    model: env.META_TRANSCRIBE_MODEL,
    dailyBudgetUsd: env.META_DAILY_BUDGET_USD,
    logAiCall,
    getTodaySpend: () => todaysAiSpend(),
  });
}
