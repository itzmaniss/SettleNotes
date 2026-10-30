import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { getSupabase } from "@/lib/db/client";
import { UnsupportedMimeError } from "@/lib/media/normalize";

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export function originalPath(userId: string, uploadId: string, ext: string): string {
  return `${userId}/${uploadId}/original.${ext}`;
}

export function annotatedPath(userId: string, uploadId: string): string {
  return `${userId}/${uploadId}/annotated.jpg`;
}

export function extensionForMime(mime: string): string {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  const ext = EXTENSIONS[base];
  if (ext === undefined) throw new UnsupportedMimeError(base);
  return ext;
}

// Client and bucket resolve at call time so tests can inject fakes.
function bucketName(override?: string): string {
  return override ?? env.SUPABASE_STORAGE_BUCKET;
}

export async function uploadBuffer(
  path: string,
  buffer: Buffer,
  contentType: string,
  client?: SupabaseClient,
  bucket?: string
): Promise<void> {
  const supabase = client ?? getSupabase();
  const { error } = await supabase.storage.from(bucketName(bucket)).upload(path, buffer, {
    contentType,
    upsert: false,
  });
  if (error) throw new Error(`Storage upload failed for ${path}: ${error.message}`);
}

export async function uploadOriginal(
  args: { userId: string; uploadId: string; buffer: Buffer; mimeType: string; bucket?: string },
  client?: SupabaseClient
): Promise<string> {
  const ext = extensionForMime(args.mimeType);
  const path = originalPath(args.userId, args.uploadId, ext);
  await uploadBuffer(path, args.buffer, args.mimeType, client, args.bucket);
  return path;
}

export async function downloadBuffer(
  path: string,
  client?: SupabaseClient,
  bucket?: string
): Promise<Buffer> {
  const supabase = client ?? getSupabase();
  const { data, error } = await supabase.storage.from(bucketName(bucket)).download(path);
  if (error) throw new Error(`Storage download failed for ${path}: ${error.message}`);
  if (!data) throw new Error(`Storage download returned no data for ${path}`);
  return Buffer.from(await data.arrayBuffer());
}

export async function signedUrl(
  path: string,
  expiresInSeconds = 3600,
  client?: SupabaseClient,
  bucket?: string
): Promise<string> {
  const supabase = client ?? getSupabase();
  const { data, error } = await supabase.storage
    .from(bucketName(bucket))
    .createSignedUrl(path, expiresInSeconds);
  if (error) throw new Error(`Storage signed URL failed for ${path}: ${error.message}`);
  const url = data?.signedUrl;
  if (!url) throw new Error(`Storage returned no signed URL for ${path}`);
  return url;
}
