import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const ROOT = join(import.meta.dir, "..", "..");
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PAPER = { r: 0xf5, g: 0xf8, b: 0xef };

async function rawPixels(input: Buffer | string) {
  return sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

describe("favicon.ico container", () => {
  const ico = readFileSync(join(ROOT, "app/favicon.ico"));

  test("ICONDIR: reserved 0, type 1, 3 images", () => {
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(3);
  });

  test("entries describe 16/32/48 at 1 plane, 32 bpp with PNG payloads", async () => {
    for (const [i, size] of [16, 32, 48].entries()) {
      const entry = 6 + i * 16;
      expect(ico.readUInt8(entry), `width ${size}`).toBe(size);
      expect(ico.readUInt8(entry + 1), `height ${size}`).toBe(size);
      expect(ico.readUInt16LE(entry + 4)).toBe(1);
      expect(ico.readUInt16LE(entry + 6)).toBe(32);
      const bytes = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      // Payloads sit contiguously after the header, first image at offset 54.
      const expectedOffset =
        6 +
        3 * 16 +
        [0, 1, 2]
          .slice(0, i)
          .reduce((sum, prev) => sum + ico.readUInt32LE(6 + prev * 16 + 8), 0);
      expect(offset).toBe(expectedOffset);
      const payload = ico.subarray(offset, offset + bytes);
      for (const [j, expected] of PNG_SIGNATURE.entries()) {
        expect(payload[j], `png signature byte ${j} at ${size}`).toBe(expected);
      }
      const meta = await sharp(payload).metadata();
      expect(meta.width, `png width ${size}`).toBe(size);
      expect(meta.height, `png height ${size}`).toBe(size);
    }
  });
});

describe("raster brand assets", () => {
  test("apple icon is 180x180 and fully opaque", async () => {
    const apple = readFileSync(join(ROOT, "app/apple-icon.png"));
    const meta = await sharp(apple).metadata();
    expect(meta.width).toBe(180);
    expect(meta.height).toBe(180);
    const { data, info } = await rawPixels(apple);
    expect(info.channels).toBe(4);
    let minAlpha = 255;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < minAlpha) minAlpha = data[i];
    }
    expect(minAlpha).toBe(255);
  });

  for (const [name, size] of [
    ["settle-icon-512.png", 512],
    ["settle-icon-1024.png", 1024],
  ] as const) {
    test(`${name} is square, opaque, paper corners, lime centre`, async () => {
      const png = readFileSync(join(ROOT, "public/brand", name));
      const meta = await sharp(png).metadata();
      expect(meta.width).toBe(size);
      expect(meta.height).toBe(size);
      const { data, info } = await rawPixels(png);
      expect(info.channels).toBe(4);
      const stride = info.width * info.channels;
      const pixel = (x: number, y: number) => {
        const at = y * stride + x * info.channels;
        return { r: data[at], g: data[at + 1], b: data[at + 2], a: data[at + 3] };
      };
      let minAlpha = 255;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < minAlpha) minAlpha = data[i];
      }
      expect(minAlpha).toBe(255);
      for (const [x, y] of [
        [0, 0],
        [size - 1, 0],
        [0, size - 1],
        [size - 1, size - 1],
      ] as const) {
        const corner = pixel(x, y);
        expect(Math.abs(corner.r - PAPER.r), `r at ${x},${y}`).toBeLessThanOrEqual(2);
        expect(Math.abs(corner.g - PAPER.g), `g at ${x},${y}`).toBeLessThanOrEqual(2);
        expect(Math.abs(corner.b - PAPER.b), `b at ${x},${y}`).toBeLessThanOrEqual(2);
      }
      let limePixels = 0;
      for (let y = 0; y < info.height; y += 2) {
        for (let x = 0; x < info.width; x += 2) {
          const p = pixel(x, y);
          if (p.r > 150 && p.g > 200 && p.b < 140) limePixels++;
        }
      }
      expect(limePixels).toBeGreaterThan(500);
    });
  }

  test("mark svg renders at 512 with clear space and transparent corners", async () => {
    const svg = readFileSync(join(ROOT, "public/brand/settle-mark.svg"));
    const { data, info } = await rawPixels(
      await sharp(svg, { density: 72 }).resize(512, 512).png().toBuffer()
    );
    expect(info.width).toBe(512);
    expect(info.height).toBe(512);
    expect(info.channels).toBe(4);
    const stride = info.width * info.channels;
    const alphaAt = (x: number, y: number) => data[y * stride + x * 4 + 3];
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(511, 511)).toBe(0);
    let minX = 512;
    let minY = 512;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        if (alphaAt(x, y) > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    expect(minX).toBeGreaterThanOrEqual(24);
    expect(minY).toBeGreaterThanOrEqual(24);
    expect(511 - maxX).toBeGreaterThanOrEqual(24);
    expect(511 - maxY).toBeGreaterThanOrEqual(24);
  });
});
