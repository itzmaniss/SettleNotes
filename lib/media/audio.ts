// Voice note conversion: any Telegram audio in, 16 kHz mono 16-bit PCM WAV
// out, via the ffmpeg-static binary. Pure header parsing lives here too so
// durations never depend on ffmpeg's stderr output.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";

export const MAX_VOICE_SECONDS = 180;

const DEFAULT_CONVERSION_TIMEOUT_MS = 30_000;
const MAX_STDERR_CHARS = 4_000;
const MAX_ERROR_DETAIL_CHARS = 160;

export class FfmpegUnavailableError extends Error {
  constructor() {
    super("No ffmpeg binary is available for audio conversion");
    this.name = "FfmpegUnavailableError";
  }
}

export class AudioConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioConversionError";
  }
}

export class AudioTooLongError extends Error {
  readonly seconds: number;
  constructor(seconds: number) {
    super(`Voice note is about ${Math.round(seconds)}s, over the ${MAX_VOICE_SECONDS}s limit`);
    this.name = "AudioTooLongError";
    this.seconds = seconds;
  }
}

export function isVoiceTooLong(seconds: number): boolean {
  return seconds > MAX_VOICE_SECONDS;
}

export type RunnerResult = { code: number | null; stderr: string; timedOut: boolean };

// Runs the ffmpeg binary with a fixed arg list and a hard timeout. Injectable
// so tests never spawn a real process; the default implementation never uses a
// shell, so arg values (temp paths) cannot be injected as commands.
export type Runner = (
  ffmpegPath: string,
  args: string[],
  timeoutMs: number,
) => Promise<RunnerResult>;

export const spawnFfmpegRunner: Runner = (bin, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, timedOut });
    });
  });

// Duration from the RIFF/fmt/data chunks alone. Returns 0 for anything
// malformed: callers treat 0 as unreadable output rather than silence.
export function wavDurationSeconds(wav: Buffer): number {
  if (wav.length < 12) return 0;
  if (wav.toString("latin1", 0, 4) !== "RIFF" || wav.toString("latin1", 8, 12) !== "WAVE") {
    return 0;
  }
  let byteRate: number | null = null;
  // Chunk payloads are word aligned: an odd size carries one padding byte.
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("latin1", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      if (body + 16 > wav.length) return 0;
      byteRate = wav.readUInt32LE(body + 8);
    } else if (id === "data" && byteRate != null && byteRate > 0) {
      const usable = Math.min(size, wav.length - body);
      if (usable <= 0) return 0;
      return Math.round((usable / byteRate) * 1000) / 1000;
    }
    offset = body + size + (size % 2);
  }
  return 0;
}

export type ConvertOptions = {
  ffmpegPath?: string;
  timeoutMs?: number;
  runner?: Runner;
};

const FFMPEG_ARGS_BEFORE_INPUT = ["-nostdin", "-hide_banner", "-loglevel", "error"] as const;

export async function convertToWav16kMono(
  input: Buffer,
  opts: ConvertOptions = {},
): Promise<{ wav: Buffer; seconds: number }> {
  const bin = opts.ffmpegPath ?? ffmpegPath;
  if (bin == null || bin.length === 0) throw new FfmpegUnavailableError();
  const run = opts.runner ?? spawnFfmpegRunner;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONVERSION_TIMEOUT_MS;

  // A unique temp dir per call keeps concurrent conversions from colliding;
  // the finally block removes it on every path, including timeouts.
  const dir = await mkdtemp(join(tmpdir(), "settle-audio-"));
  try {
    const inPath = join(dir, "input.bin");
    const outPath = join(dir, "out.wav");
    await writeFile(inPath, input);
    let result: RunnerResult;
    try {
      result = await run(
        bin,
        [
          ...FFMPEG_ARGS_BEFORE_INPUT,
          "-i",
          inPath,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-sample_fmt",
          "s16",
          "-f",
          "wav",
          outPath,
        ],
        timeoutMs,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new AudioConversionError(sanitize(msg, [bin]) || "audio converter could not be started");
    }
    const wav = await readFile(outPath).catch(() => Buffer.alloc(0));
    if (result.timedOut || result.code !== 0 || wav.length === 0) {
      throw new AudioConversionError(conversionDetail(result.stderr, [inPath, outPath]));
    }
    const seconds = wavDurationSeconds(wav);
    if (seconds <= 0) throw new AudioConversionError("audio converter produced unreadable output");
    if (isVoiceTooLong(seconds)) throw new AudioTooLongError(seconds);
    return { wav, seconds };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// First non-empty stderr line only, with temp paths scrubbed: error messages
// must stay short and must never leak server file paths.
function conversionDetail(stderr: string, privatePaths: string[]): string {
  const firstLine = sanitize(stderr, privatePaths);
  return firstLine.length > 0
    ? `audio conversion failed: ${firstLine}`
    : "audio conversion failed";
}

function sanitize(text: string, privatePaths: string[]): string {
  let out = text;
  for (const path of privatePaths) out = out.split(path).join("[audio]");
  const firstLine =
    out
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  return firstLine.slice(0, MAX_ERROR_DETAIL_CHARS);
}
