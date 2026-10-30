import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import {
  ALLOWED_IMAGE_MIMES,
  InvalidImageError,
  InvalidPdfError,
  MAX_LONG_EDGE,
  MAX_PDF_PAGES,
  PDF_MIME,
  inspectPdf,
  isSupportedMime,
  normalizeImage,
} from "@/lib/media/normalize";

async function solidImage(width: number, height: number, format: "png" | "jpeg"): Promise<Buffer> {
  const pipeline = sharp({
    create: { width, height, channels: 3, background: { r: 180, g: 40, b: 40 } },
  });
  return Buffer.from(await (format === "png" ? pipeline.png() : pipeline.jpeg()).toBuffer());
}

function makePdf(pageCount: number): Buffer {
  const pages: string[] = [];
  for (let i = 1; i <= pageCount; i++) {
    pages.push(`${i} 0 obj << /Type /Page /Parent 100 0 R >> endobj\n`);
  }
  const body =
    `%PDF-1.4\n${pages.join("")}` +
    `100 0 obj << /Type /Pages /Kids [] /Count ${pageCount} >> endobj\n` +
    `trailer << /Root 100 0 R >>\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

// sharp's withExif does not persist Orientation (libvips reads it back as 1),
// so splice a hand-built APP1 EXIF segment (little-endian TIFF, one IFD0 entry)
// into the JPEG right after SOI.
function jpegWithOrientation6(jpeg: Buffer): Buffer {
  const tiff = Buffer.alloc(28);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2); // TIFF magic
  tiff.writeUInt32LE(8, 4); // IFD0 offset
  tiff.writeUInt16LE(1, 8); // one IFD entry
  tiff.writeUInt16LE(0x0112, 10); // Orientation tag
  tiff.writeUInt16LE(3, 12); // SHORT
  tiff.writeUInt32LE(1, 14); // count
  tiff.writeUInt16LE(6, 18); // value 6 = rotate 90 CW
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const app1 = Buffer.alloc(4 + payload.byteLength);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.byteLength + 2, 2);
  payload.copy(app1, 4);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

describe("isSupportedMime", () => {
  test("accepts whitelisted image and pdf mimes", () => {
    expect(isSupportedMime("image/jpeg")).toBe(true);
    expect(isSupportedMime("image/png")).toBe(true);
    expect(isSupportedMime("image/webp")).toBe(true);
    expect(isSupportedMime("application/pdf")).toBe(true);
  });

  test("is case-insensitive and ignores charset parameters", () => {
    expect(isSupportedMime("IMAGE/JPEG")).toBe(true);
    expect(isSupportedMime("Application/PDF")).toBe(true);
    expect(isSupportedMime("image/png; charset=utf-8")).toBe(true);
    expect(isSupportedMime("  image/webp ")).toBe(true);
  });

  test("rejects everything else", () => {
    expect(isSupportedMime("image/gif")).toBe(false);
    expect(isSupportedMime("video/mp4")).toBe(false);
    expect(isSupportedMime("text/plain")).toBe(false);
    expect(isSupportedMime("")).toBe(false);
    expect(isSupportedMime("application/zip")).toBe(false);
  });
});

describe("normalizeImage", () => {
  test("downsizes a wide image to fit 2000px and reports output dims", async () => {
    const input = await solidImage(3000, 1500, "png");
    const result = await normalizeImage(input);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.width).toBe(2000);
    expect(result.height).toBe(1000);

    // Dimensions must come from the output buffer, not the input.
    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(2000);
    expect(meta.height).toBe(1000);
    expect(result.buffer.byteLength).toBeLessThan(input.byteLength);
  });

  test("does not enlarge a small image", async () => {
    const input = await solidImage(40, 30, "png");
    const result = await normalizeImage(input);
    expect(result.width).toBe(40);
    expect(result.height).toBe(30);
  });

  test("applies EXIF orientation 6 and strips EXIF from the output", async () => {
    const base = await solidImage(400, 300, "jpeg");
    const rotated = jpegWithOrientation6(base);
    // Sanity: the fixture really carries Orientation = 6.
    expect((await sharp(rotated).metadata()).orientation).toBe(6);

    const result = await normalizeImage(rotated);
    expect(result.width).toBe(300);
    expect(result.height).toBe(400);

    const meta = await sharp(result.buffer).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  test("throws InvalidImageError for bytes sharp cannot decode", async () => {
    const garbage = Buffer.from("this is definitely not an image");
    try {
      await normalizeImage(garbage);
      throw new Error("expected normalizeImage to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidImageError);
      expect((error as InvalidImageError).message.length).toBeGreaterThan(0);
    }
  });
});

describe("inspectPdf", () => {
  test("counts /Type /Page objects but not /Type /Pages", () => {
    const result = inspectPdf(makePdf(3));
    expect(result.pageCount).toBe(3);
    expect(result.tooManyPages).toBe(false);
  });

  test("flags PDFs over the page cap", () => {
    const result = inspectPdf(makePdf(MAX_PDF_PAGES + 1));
    expect(result.pageCount).toBe(MAX_PDF_PAGES + 1);
    expect(result.tooManyPages).toBe(true);
  });

  test("returns null pageCount when nothing looks like a page", () => {
    const result = inspectPdf(makePdf(0));
    expect(result.pageCount).toBeNull();
    expect(result.tooManyPages).toBe(false);
  });

  test("throws InvalidPdfError for non-PDF bytes", () => {
    expect(() => inspectPdf(Buffer.from("not a pdf at all"))).toThrow(InvalidPdfError);
    expect(() => inspectPdf(Buffer.from("%PNG whatever"))).toThrow(InvalidPdfError);
  });
});

describe("constants", () => {
  test("expose the documented limits and whitelist", () => {
    expect(MAX_LONG_EDGE).toBe(2000);
    expect(MAX_PDF_PAGES).toBe(50);
    expect(PDF_MIME).toBe("application/pdf");
    expect([...ALLOWED_IMAGE_MIMES]).toEqual(["image/jpeg", "image/png", "image/webp"]);
  });
});
