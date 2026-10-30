import sharp from "sharp";

export const MAX_LONG_EDGE = 2000;
export const MAX_PDF_PAGES = 50;
export const ALLOWED_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
export const PDF_MIME = "application/pdf";

export class UnsupportedMimeError extends Error {
  readonly mime: string;

  constructor(mime: string) {
    super(`Unsupported file type${mime ? `: ${mime}` : ""}`);
    this.name = "UnsupportedMimeError";
    this.mime = mime;
  }
}

export class InvalidImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidImageError";
  }
}

export class InvalidPdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPdfError";
  }
}

export function isSupportedMime(mime: string): boolean {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  return (ALLOWED_IMAGE_MIMES as readonly string[]).includes(base) || base === PDF_MIME;
}

export async function normalizeImage(
  input: Buffer
): Promise<{ buffer: Buffer; width: number; height: number; mimeType: "image/jpeg" }> {
  let output: Buffer;
  try {
    output = await sharp(input)
      // No-arg rotate auto-applies the EXIF orientation, so width/height below
      // describe the image as displayed and the orientation tag is baked in.
      .rotate()
      .resize(MAX_LONG_EDGE, MAX_LONG_EDGE, { fit: "inside", withoutEnlargement: true })
      // Output is JPEG with all metadata (EXIF included) stripped: sharp only
      // keeps metadata when withMetadata() is called.
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    throw new InvalidImageError("This file does not look like a supported image");
  }

  const meta = await sharp(output).metadata();
  if (meta.width === undefined || meta.height === undefined) {
    throw new InvalidImageError("Could not read image dimensions after normalisation");
  }

  return { buffer: output, width: meta.width, height: meta.height, mimeType: "image/jpeg" };
}

export function inspectPdf(buffer: Buffer): { pageCount: number | null; tooManyPages: boolean } {
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new InvalidPdfError("This file does not look like a PDF");
  }

  // \b after "/Page" already skips "/Pages" objects (the "s" keeps it a word).
  const matches = buffer.toString("latin1").match(/\/Type\s*\/Page\b/g);
  const pageCount = matches && matches.length > 0 ? matches.length : null;
  return { pageCount, tooManyPages: pageCount !== null && pageCount > MAX_PDF_PAGES };
}
