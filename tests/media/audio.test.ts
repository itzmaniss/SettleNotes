import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import {
  AudioConversionError,
  AudioTooLongError,
  MAX_VOICE_SECONDS,
  convertToWav16kMono,
  isVoiceTooLong,
  spawnFfmpegRunner,
  wavDurationSeconds,
  type Runner,
} from "@/lib/media/audio";

const FFMPEG_BIN = ffmpegPath;

// Canonical 44-byte-header PCM WAV with silent data of the given byte size.
function makeWav(sampleRate: number, channels: number, bitsPerSample: number, dataBytes: number): Buffer {
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28); // byte rate
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

function leftoverAudioDirs(): Promise<string[]> {
  return readdir(tmpdir()).then((names) => names.filter((n) => n.startsWith("settle-audio-")));
}

describe("isVoiceTooLong", () => {
  test("the limit is 3 minutes and only longer counts", () => {
    expect(MAX_VOICE_SECONDS).toBe(180);
    expect(isVoiceTooLong(0)).toBe(false);
    expect(isVoiceTooLong(180)).toBe(false);
    expect(isVoiceTooLong(180.5)).toBe(true);
    expect(isVoiceTooLong(600)).toBe(true);
  });
});

describe("wavDurationSeconds", () => {
  test("mono 16 kHz 16 bit WAV parses from the data chunk and byte rate", () => {
    // 16000 data bytes at byte rate 32000 = 0.5s
    expect(wavDurationSeconds(makeWav(16000, 1, 16, 16000))).toBe(0.5);
    expect(wavDurationSeconds(makeWav(16000, 1, 16, 32000))).toBe(1);
  });

  test("a chunk before fmt (LIST metadata) is skipped without breaking the parse", () => {
    const wav = makeWav(16000, 1, 16, 32000);
    const list = Buffer.alloc(8 + 26);
    list.write("LIST", 0, "latin1");
    list.writeUInt32LE(26, 4);
    const withList = Buffer.concat([wav.subarray(0, 12), list, wav.subarray(12)]);
    expect(wavDurationSeconds(withList)).toBe(1);
  });

  test("returns 0 for malformed input", () => {
    expect(wavDurationSeconds(Buffer.alloc(0))).toBe(0);
    expect(wavDurationSeconds(Buffer.from("RIFF"))).toBe(0);
    expect(wavDurationSeconds(Buffer.from("RIFX....WAVE"))).toBe(0);
    expect(wavDurationSeconds(makeWav(16000, 1, 16, 0))).toBe(0); // empty data chunk
    // data chunk present but fmt missing, so the byte rate is unknown
    const noFmt = Buffer.concat([makeWav(16000, 1, 16, 32000).subarray(0, 12), (() => {
      const data = Buffer.alloc(8);
      data.write("data", 0, "latin1");
      data.writeUInt32LE(32000, 4);
      return Buffer.concat([data, Buffer.alloc(32000)]);
    })()]);
    expect(wavDurationSeconds(noFmt)).toBe(0);
    // truncated fmt chunk
    expect(wavDurationSeconds(makeWav(16000, 1, 16, 32000).subarray(0, 30))).toBe(0);
    // garbage bytes
    expect(wavDurationSeconds(Buffer.from("not audio at all"))).toBe(0);
  });
});

describe("convertToWav16kMono with a fake runner", () => {
  function fakeRunner(result: { code: number | null; stderr?: string; timedOut?: boolean }, writeWav?: Buffer): {
    runner: Runner;
    calls: Array<{ bin: string; args: string[]; timeoutMs: number }>;
  } {
    const calls: Array<{ bin: string; args: string[]; timeoutMs: number }> = [];
    const runner: Runner = async (bin, args, timeoutMs) => {
      calls.push({ bin, args, timeoutMs });
      const outPath = args[args.length - 1];
      if (writeWav != null) {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(outPath, writeWav);
      }
      return { code: result.code, stderr: result.stderr ?? "", timedOut: result.timedOut ?? false };
    };
    return { runner, calls };
  }

  test("success: exact ffmpeg args, injected binary and timeout, duration from the output", async () => {
    const { runner, calls } = fakeRunner({ code: 0 }, makeWav(16000, 1, 16, 32000));
    const out = await convertToWav16kMono(Buffer.from("ogg-bytes"), {
      ffmpegPath: "fake-ffmpeg",
      timeoutMs: 1234,
      runner,
    });

    expect(out.seconds).toBe(1);
    expect(out.wav.equals(makeWav(16000, 1, 16, 32000))).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].bin).toBe("fake-ffmpeg");
    expect(calls[0].timeoutMs).toBe(1234);
    const args = calls[0].args;
    expect(args.slice(0, 4)).toEqual(["-nostdin", "-hide_banner", "-loglevel", "error"]);
    expect(args[4]).toBe("-i");
    expect(args[5].endsWith("input.bin")).toBe(true);
    expect(args.slice(6)).toEqual([
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-sample_fmt",
      "s16",
      "-f",
      "wav",
      expect.stringContaining("out.wav"),
    ]);
    // No shell string anywhere: every arg is its own array element.
    expect(args.every((arg) => !arg.includes(" "))).toBe(true);
  });

  test("a timed out fake runner maps to AudioConversionError", async () => {
    const { runner, calls } = fakeRunner({ code: null, timedOut: true });
    const err = await convertToWav16kMono(Buffer.from("x"), { ffmpegPath: "fake-ffmpeg", runner }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(AudioConversionError);
    expect(calls[0].timeoutMs).toBe(30_000); // default timeout passed to the runner
  });

  test("nonzero exit produces a short sanitized message without paths", async () => {
    // The fake embeds the real temp input path in its stderr, like ffmpeg
    // would, so the scrubbing of real paths is what gets tested.
    let realInPath = "";
    const runner: Runner = async (bin, args, timeoutMs) => {
      realInPath = args[5];
      void bin;
      void timeoutMs;
      return { code: 1, stderr: `${args[5]}: totally broken audio\nsecond line`, timedOut: false };
    };
    const err = await convertToWav16kMono(Buffer.from("x"), { ffmpegPath: "fake-ffmpeg", runner }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(AudioConversionError);
    const message = (err as Error).message;
    expect(message).toContain("totally broken audio");
    expect(message).not.toContain("second line");
    expect(realInPath).not.toBe("");
    expect(message).not.toContain(realInPath);
    expect(message).not.toContain("input.bin");
    expect(message).not.toContain(tmpdir());
  });

  test("empty output file counts as a failure", async () => {
    const { runner } = fakeRunner({ code: 0 });
    const err = await convertToWav16kMono(Buffer.from("x"), { ffmpegPath: "fake-ffmpeg", runner }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(AudioConversionError);
  });

  test("a WAV over the length limit raises AudioTooLongError", async () => {
    // byte rate 1000 with 200000 data bytes claims 200 seconds
    const { runner } = fakeRunner({ code: 0 }, makeWav(500, 1, 16, 200_000));
    const err = await convertToWav16kMono(Buffer.from("x"), { ffmpegPath: "fake-ffmpeg", runner }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(AudioTooLongError);
    expect((err as AudioTooLongError).seconds).toBe(200);
  });

  test("a null binary path raises FfmpegUnavailableError", async () => {
    const { FfmpegUnavailableError } = await import("@/lib/media/audio");
    const err = await convertToWav16kMono(Buffer.from("x"), { ffmpegPath: "", runner: fakeRunner({ code: 0 }).runner }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(FfmpegUnavailableError);
  });
});

// Real binary tests: skipped, with a clear name, only when ffmpeg-static is
// missing or cannot execute on this machine.
const ffmpegWorks = FFMPEG_BIN != null
  ? await spawnFfmpegRunner(FFMPEG_BIN, ["-nostdin", "-hide_banner", "-loglevel", "error", "-version"], 10_000).then(
      (r) => r.code === 0,
      () => false,
    )
  : false;
const worksWithFfmpeg = test.skipIf(!ffmpegWorks);

// A ~1.5s 440 Hz tone as OGG. libopus first, libvorbis as the fallback for
// builds without opus.
async function generateTone(seconds: number): Promise<{ buffer: Buffer; codec: string }> {
  if (FFMPEG_BIN == null) throw new Error("ffmpeg binary missing");
  const dir = await mkdtemp(join(tmpdir(), "settle-test-tone-"));
  const tonePath = join(dir, "tone.ogg");
  try {
    for (const codec of ["libopus", "libvorbis"]) {
      const r = await spawnFfmpegRunner(
        FFMPEG_BIN,
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          `sine=frequency=440:duration=${seconds}`,
          "-c:a",
          codec,
          "-f",
          "ogg",
          tonePath,
        ],
        30_000,
      );
      if (r.code === 0) {
        return { buffer: await readFile(tonePath), codec };
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  // No ogg encoder in this build: feed WAV input instead and say so.
  return { buffer: makeWav(48000, 1, 16, Math.round(48000 * seconds)), codec: "wav-input-fallback" };
}

worksWithFfmpeg(`converts a generated 440 Hz tone to 16 kHz mono 16-bit WAV (ffmpeg available: ${ffmpegWorks})`, async () => {
  const tone = await generateTone(1.5);
  const out = await convertToWav16kMono(tone.buffer);

  expect(out.wav.toString("latin1", 0, 4)).toBe("RIFF");
  expect(out.wav.toString("latin1", 8, 12)).toBe("WAVE");
  expect(out.wav.readUInt16LE(20)).toBe(1); // PCM
  expect(out.wav.readUInt16LE(22)).toBe(1); // mono
  expect(out.wav.readUInt32LE(24)).toBe(16000); // sample rate
  expect(out.wav.readUInt16LE(34)).toBe(16); // bits per sample
  expect(Math.abs(out.seconds - 1.5)).toBeLessThanOrEqual(0.2);
  // Both temp files are gone once the promise settles.
  expect(await leftoverAudioDirs()).toEqual([]);
});

worksWithFfmpeg("garbage input fails with AudioConversionError, no paths leaked, temp cleaned", async () => {
  const err = await convertToWav16kMono(Buffer.from("this is definitely not audio")).then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(AudioConversionError);
  const message = (err as Error).message;
  expect(message).not.toContain(tmpdir());
  expect(message).not.toContain("input.bin");
  expect(message.length).toBeLessThan(300);
  expect(await leftoverAudioDirs()).toEqual([]);
});

worksWithFfmpeg("the default runner kills ffmpeg on timeout", async () => {
  if (FFMPEG_BIN == null) throw new Error("ffmpeg binary missing");
  // -re paces the 10s tone at real time, so ffmpeg is guaranteed to still be
  // running when the 400ms timeout fires.
  const start = Date.now();
  const r = await spawnFfmpegRunner(
    FFMPEG_BIN,
    ["-nostdin", "-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "sine=frequency=440:duration=10", "-f", "null", "-"],
    400,
  );
  expect(r.timedOut).toBe(true);
  expect(Date.now() - start).toBeLessThan(8000);
});
