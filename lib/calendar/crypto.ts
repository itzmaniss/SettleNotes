import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "v1";

function fromBase64Url(part: string): Buffer {
  const padded = part.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(pad), "base64");
}

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeKey(keyBase64: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(keyBase64, "base64");
  } catch {
    throw new Error("calendar token key must decode to 32 bytes");
  }
  if (key.length !== 32) {
    throw new Error("calendar token key must decode to 32 bytes");
  }
  return key;
}

// Encrypts an OAuth refresh token with AES-256-GCM. Output format:
// v1.<iv>.<tag>.<ciphertext>, each part base64url.
export function encryptToken(plain: string, keyBase64: string): string {
  const key = decodeKey(keyBase64);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, toBase64Url(iv), toBase64Url(tag), toBase64Url(ciphertext)].join(".");
}

export function decryptToken(blob: string, keyBase64: string): string {
  const key = decodeKey(keyBase64);
  const parts = blob.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error("calendar token blob is malformed");
  }
  const [, ivPart, tagPart, dataPart] = parts;
  let iv: Buffer;
  let tag: Buffer;
  let data: Buffer;
  try {
    iv = fromBase64Url(ivPart);
    tag = fromBase64Url(tagPart);
    data = fromBase64Url(dataPart);
  } catch {
    throw new Error("calendar token blob is malformed");
  }
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error("calendar token blob is malformed");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("calendar token blob failed authentication");
  }
}
