import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const ROOT = join(import.meta.dir, "..", "..");
const FILE = join(ROOT, "public", "opengraph-image.png");

type Pixels = {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
};

async function pixels(): Promise<Pixels> {
  const out = await sharp(readFileSync(FILE))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: out.data, width: out.info.width, height: out.info.height, channels: out.info.channels };
}

describe("the Open Graph share image", () => {
  test("lives in public, a 1200x630 PNG under 300 KB", async () => {
    expect(statSync(FILE).size).toBeLessThan(300 * 1024);
    const meta = await sharp(readFileSync(FILE)).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(630);
  });

  test("the wordmark and tagline really rasterised, checked by pixel bounds", async () => {
    const px = await pixels();
    const stride = px.width * px.channels;
    const isInk = (x: number, y: number) => {
      const at = y * stride + x * px.channels;
      return px.data[at] < 80 && px.data[at + 1] < 80 && px.data[at + 2] < 80;
    };
    // The mark and its outline sit left of 470; dark pixels to the right of
    // that are the wordmark and the tagline. If the SVG text ever rendered
    // blank, these bounds would collapse and this test would fail.
    let minX = px.width;
    let minY = px.height;
    let maxX = -1;
    let maxY = -1;
    let dark = 0;
    for (let y = 0; y < px.height; y++) {
      for (let x = 470; x < px.width; x++) {
        if (!isInk(x, y)) continue;
        dark++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    expect(dark).toBeGreaterThan(5000);
    expect(maxX - minX).toBeGreaterThan(300);
    expect(maxY - minY).toBeGreaterThan(150);
    // Nothing clipped at the right or bottom edge.
    expect(maxX).toBeLessThanOrEqual(1195);
    expect(maxY).toBeLessThanOrEqual(625);
  });

  test("the lilac accent shadow and the lime mark are present", async () => {
    const px = await pixels();
    const stride = px.width * px.channels;
    let lilac = 0;
    let lime = 0;
    for (let y = 0; y < px.height; y++) {
      for (let x = 0; x < px.width; x++) {
        const at = y * stride + x * px.channels;
        const r = px.data[at]!;
        const g = px.data[at + 1]!;
        const b = px.data[at + 2]!;
        if (b > 190 && r > 140 && r < 215 && g > 110 && g < 175) lilac++;
        if (r > 150 && g > 200 && b < 140) lime++;
      }
    }
    expect(lilac).toBeGreaterThan(2000);
    expect(lime).toBeGreaterThan(10000);
  });

  test("the corners are paper", async () => {
    const px = await pixels();
    const stride = px.width * px.channels;
    const paper = { r: 0xf5, g: 0xf8, b: 0xef };
    for (const [x, y] of [
      [0, 0],
      [px.width - 1, 0],
      [0, px.height - 1],
      [px.width - 1, px.height - 1],
    ] as const) {
      const at = y * stride + x * px.channels;
      expect(Math.abs(px.data[at]! - paper.r)).toBeLessThanOrEqual(2);
      expect(Math.abs(px.data[at + 1]! - paper.g)).toBeLessThanOrEqual(2);
      expect(Math.abs(px.data[at + 2]! - paper.b)).toBeLessThanOrEqual(2);
    }
  });
});
