import { describe, expect, test } from "bun:test";
import {
  FileTooLargeError,
  TELEGRAM_MAX_DOWNLOAD_BYTES,
  TelegramDownloadError,
  downloadTelegramFile,
  type FileFetchDeps,
} from "@/lib/telegram/files";

const TOKEN = "123456:FAKE-TOKEN";
const BODY = new Uint8Array([1, 2, 3, 4]);

// Bun's `typeof fetch` carries a `preconnect` property, so fake fetches go
// through this cast instead of bare arrows at every call site.
function fakeFetch(handler: (input: RequestInfo | URL) => Promise<Response>): typeof fetch {
  return (async (input) => handler(input)) as typeof fetch;
}

function depsWith(
  file: { file_path?: string; file_size?: number },
  fetchImpl?: typeof fetch
): { deps: FileFetchDeps; fetchCalls: string[] } {
  const fetchCalls: string[] = [];
  const deps: FileFetchDeps = {
    getFile: async () => file,
    fetch:
      fetchImpl ??
      fakeFetch(async (input) => {
        fetchCalls.push(String(input));
        return new Response(BODY);
      }),
    botToken: TOKEN,
  };
  return { deps, fetchCalls };
}

async function captureError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected fn to throw");
}

describe("downloadTelegramFile", () => {
  test("downloads by file_id and returns buffer, path and size", async () => {
    const { deps, fetchCalls } = depsWith(
      { file_path: "documents/file_10.jpg", file_size: BODY.byteLength }
    );
    const result = await downloadTelegramFile("photo-1", deps);
    expect([...result.buffer]).toEqual([1, 2, 3, 4]);
    expect(result.filePath).toBe("documents/file_10.jpg");
    expect(result.sizeBytes).toBe(4);
    expect(fetchCalls).toEqual([
      `https://api.telegram.org/file/bot${TOKEN}/documents/file_10.jpg`,
    ]);
  });

  test("rejects by file_size before downloading", async () => {
    const { deps, fetchCalls } = depsWith({
      file_path: "documents/big.pdf",
      file_size: TELEGRAM_MAX_DOWNLOAD_BYTES + 1,
    });
    const error = await captureError(() => downloadTelegramFile("doc-1", deps));
    expect(error).toBeInstanceOf(FileTooLargeError);
    expect((error as FileTooLargeError).sizeBytes).toBe(TELEGRAM_MAX_DOWNLOAD_BYTES + 1);
    expect((error as FileTooLargeError).maxBytes).toBe(TELEGRAM_MAX_DOWNLOAD_BYTES);
    expect(fetchCalls).toHaveLength(0);
  });

  test("allows a file exactly at the cap", async () => {
    const exact = new Uint8Array(TELEGRAM_MAX_DOWNLOAD_BYTES);
    const { deps } = depsWith(
      { file_path: "documents/exact.bin", file_size: exact.byteLength },
      fakeFetch(async () => new Response(exact))
    );
    const result = await downloadTelegramFile("doc-2", deps);
    expect(result.sizeBytes).toBe(TELEGRAM_MAX_DOWNLOAD_BYTES);
  });

  test("rejects when the actual byte count exceeds the cap", async () => {
    const tooBig = new Uint8Array(TELEGRAM_MAX_DOWNLOAD_BYTES + 1);
    const { deps } = depsWith(
      { file_path: "documents/liar.bin", file_size: 10 },
      fakeFetch(async () => new Response(tooBig))
    );
    const error = await captureError(() => downloadTelegramFile("doc-3", deps));
    expect(error).toBeInstanceOf(FileTooLargeError);
    expect((error as FileTooLargeError).sizeBytes).toBe(TELEGRAM_MAX_DOWNLOAD_BYTES + 1);
  });

  test("throws when file_path is missing and never fetches", async () => {
    const { deps, fetchCalls } = depsWith({});
    const error = await captureError(() => downloadTelegramFile("doc-4", deps));
    expect(error).toBeInstanceOf(TelegramDownloadError);
    expect(fetchCalls).toHaveLength(0);
  });

  test("throws on non-ok HTTP status", async () => {
    const { deps } = depsWith(
      { file_path: "documents/gone.jpg" },
      fakeFetch(async () => new Response("nope", { status: 404 }))
    );
    const error = await captureError(() => downloadTelegramFile("doc-5", deps));
    expect(error).toBeInstanceOf(TelegramDownloadError);
    expect((error as TelegramDownloadError).status).toBe(404);
    expect(error.message).toContain("404");
  });

  test("throws without the bot token when the network call fails", async () => {
    const { deps } = depsWith(
      { file_path: "documents/x.jpg" },
      fakeFetch(async (input) => {
        throw new Error(`request to ${String(input)} exploded`);
      })
    );
    const error = await captureError(() => downloadTelegramFile("doc-6", deps));
    expect(error).toBeInstanceOf(TelegramDownloadError);
    expect(error.message).not.toContain(TOKEN);
  });

  test("no error message ever contains the bot token", async () => {
    const scenarios: Array<() => Promise<unknown>> = [
      () =>
        downloadTelegramFile(
          "a",
          depsWith({ file_path: "x", file_size: TELEGRAM_MAX_DOWNLOAD_BYTES + 5 }).deps
        ),
      () => downloadTelegramFile("b", depsWith({}).deps),
      () =>
        downloadTelegramFile(
          "c",
          depsWith({ file_path: "x" }, fakeFetch(async () => new Response("nope", { status: 500 })))
            .deps
        ),
      () =>
        downloadTelegramFile(
          "d",
          depsWith(
            { file_path: "x" },
            fakeFetch(async () => {
              throw new Error(`fetch failed for bot${TOKEN}`);
            })
          ).deps
        ),
    ];
    for (const scenario of scenarios) {
      const error = await captureError(scenario);
      expect(error.message).not.toContain(TOKEN);
    }
  });
});
