import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { UnsupportedMimeError } from "@/lib/media/normalize";
import {
  annotatedPath,
  downloadBuffer,
  extensionForMime,
  originalPath,
  signedUrl,
  uploadBuffer,
  uploadOriginal,
} from "@/lib/media/storage";

// env.SUPABASE_STORAGE_BUCKET is read lazily at call time; pin the vars here so
// the default-bucket branch parses without touching the real environment.
const envVars: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_BOT_USERNAME: "settle_test_bot",
  TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
  ALLOWED_TELEGRAM_IDS: "101",
  MODEL_API_KEY: "test-model-key",
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_SECRET_KEY: "test-supabase-key",
  SUPABASE_DB_URL: "postgresql://test:***@localhost:5432/test",
  SESSION_SECRET: "test-session-secret-0123456789",
  SUPABASE_STORAGE_BUCKET: "test-bucket",
};
for (const [key, value] of Object.entries(envVars)) process.env[key] = value;

type UploadCall = { bucket: string; path: string; data: Buffer; contentType?: string };
type FromCall = { bucket: string; path: string; expires?: number };

type FakeOverrides = {
  uploadError?: { message: string };
  downloadError?: { message: string };
  downloadBody?: Blob;
  signedError?: { message: string };
  signedUrlResult?: string | null;
};

function fakeClient(overrides: FakeOverrides = {}): {
  client: SupabaseClient;
  uploads: UploadCall[];
  downloads: FromCall[];
  signs: FromCall[];
} {
  const uploads: UploadCall[] = [];
  const downloads: FromCall[] = [];
  const signs: FromCall[] = [];
  const client = {
    storage: {
      from(bucket: string) {
        return {
          upload: async (path: string, data: Buffer, options?: { contentType?: string }) => {
            uploads.push({ bucket, path, data, contentType: options?.contentType });
            if (overrides.uploadError) return { data: null, error: overrides.uploadError };
            return { data: { path }, error: null };
          },
          download: async (path: string) => {
            downloads.push({ bucket, path });
            if (overrides.downloadError) return { data: null, error: overrides.downloadError };
            const blob =
              overrides.downloadBody ?? new Blob([new Uint8Array([1, 2, 3, 4])]);
            return { data: blob, error: null };
          },
          createSignedUrl: async (path: string, expires: number) => {
            signs.push({ bucket, path, expires });
            if (overrides.signedError) return { data: null, error: overrides.signedError };
            if (overrides.signedUrlResult === null) return { data: null, error: null };
            return {
              data: {
                signedUrl:
                  overrides.signedUrlResult ?? `https://signed.example/${bucket}/${path}`,
              },
              error: null,
            };
          },
        };
      },
    },
  } as unknown as SupabaseClient;
  return { client, uploads, downloads, signs };
}

async function captureError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected fn to throw");
}

describe("path builders", () => {
  test("originalPath and annotatedPath follow the storage layout", () => {
    expect(originalPath("user-1", "upload-1", "jpg")).toBe("user-1/upload-1/original.jpg");
    expect(originalPath("user-1", "upload-1", "pdf")).toBe("user-1/upload-1/original.pdf");
    expect(annotatedPath("user-1", "upload-1")).toBe("user-1/upload-1/annotated.jpg");
  });
});

describe("extensionForMime", () => {
  test("maps whitelisted mimes to extensions", () => {
    expect(extensionForMime("image/jpeg")).toBe("jpg");
    expect(extensionForMime("image/png")).toBe("png");
    expect(extensionForMime("image/webp")).toBe("webp");
    expect(extensionForMime("application/pdf")).toBe("pdf");
    expect(extensionForMime("IMAGE/JPEG; charset=binary")).toBe("jpg");
  });

  test("throws UnsupportedMimeError otherwise", () => {
    try {
      extensionForMime("image/gif");
      throw new Error("expected extensionForMime to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedMimeError);
    }
  });
});

describe("uploadOriginal", () => {
  test("returns the storage path and uploads with the right content type", async () => {
    const { client, uploads } = fakeClient();
    const buffer = Buffer.from([10, 20, 30]);
    const path = await uploadOriginal(
      { userId: "user-1", uploadId: "upload-1", buffer, mimeType: "image/jpeg" },
      client
    );
    expect(path).toBe("user-1/upload-1/original.jpg");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.bucket).toBe("test-bucket");
    expect(uploads[0]?.path).toBe("user-1/upload-1/original.jpg");
    expect(uploads[0]?.contentType).toBe("image/jpeg");
    expect([...(uploads[0]?.data ?? [])]).toEqual([10, 20, 30]);
  });

  test("honours a bucket override and passes pdf mime through", async () => {
    const { client, uploads } = fakeClient();
    const path = await uploadOriginal(
      {
        userId: "u",
        uploadId: "up",
        buffer: Buffer.from("%PDF-"),
        mimeType: "application/pdf",
        bucket: "other-bucket",
      },
      client
    );
    expect(path).toBe("u/up/original.pdf");
    expect(uploads[0]?.bucket).toBe("other-bucket");
  });

  test("propagates storage errors with a clear message", async () => {
    const { client } = fakeClient({ uploadError: { message: "bucket not found" } });
    const error = await captureError(() =>
      uploadOriginal(
        { userId: "u", uploadId: "up", buffer: Buffer.from("x"), mimeType: "image/png" },
        client
      )
    );
    expect(error.message).toContain("u/up/original.png");
    expect(error.message).toContain("bucket not found");
  });
});

describe("uploadBuffer", () => {
  test("uploads to the requested path and bucket", async () => {
    const { client, uploads } = fakeClient();
    await uploadBuffer("u/up/original.webp", Buffer.from([1]), "image/webp", client, "override");
    expect(uploads[0]?.bucket).toBe("override");
    expect(uploads[0]?.path).toBe("u/up/original.webp");
    expect(uploads[0]?.contentType).toBe("image/webp");
  });
});

describe("downloadBuffer", () => {
  test("returns the bytes from storage", async () => {
    const { client, downloads } = fakeClient({
      downloadBody: new Blob([new Uint8Array([5, 6, 7])]),
    });
    const buffer = await downloadBuffer("u/up/original.jpg", client);
    expect([...buffer]).toEqual([5, 6, 7]);
    expect(downloads[0]?.bucket).toBe("test-bucket");
    expect(downloads[0]?.path).toBe("u/up/original.jpg");
  });

  test("propagates storage errors", async () => {
    const { client } = fakeClient({ downloadError: { message: "Object not found" } });
    const error = await captureError(() => downloadBuffer("missing.jpg", client));
    expect(error.message).toContain("missing.jpg");
    expect(error.message).toContain("Object not found");
  });
});

describe("signedUrl", () => {
  test("defaults to 3600 seconds and returns the URL", async () => {
    const { client, signs } = fakeClient();
    // Explicit undefined expiresInSeconds exercises the real default while
    // still injecting the fake client.
    const url = await signedUrl("u/up/original.jpg", undefined, client);
    expect(url).toBe("https://signed.example/test-bucket/u/up/original.jpg");
    expect(signs[0]?.expires).toBe(3600);
    expect(signs[0]?.path).toBe("u/up/original.jpg");
  });

  test("passes a custom expiry through", async () => {
    const { client, signs } = fakeClient();
    const url = await signedUrl("u/up/original.jpg", 60, client);
    expect(url).toContain("signed.example");
    expect(signs[0]?.expires).toBe(60);
  });

  test("throws on storage errors", async () => {
    const { client } = fakeClient({ signedError: { message: "row-level security" } });
    const error = await captureError(() => signedUrl("u/up/original.jpg", 3600, client));
    expect(error.message).toContain("row-level security");
  });

  test("throws when Supabase returns no URL", async () => {
    const { client } = fakeClient({ signedUrlResult: null });
    const error = await captureError(() => signedUrl("u/up/original.jpg", 3600, client));
    expect(error.message).toContain("no signed URL");
  });
});
