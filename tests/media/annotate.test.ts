import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import {
  GRID_SIZE,
  MIN_SIDE_PX,
  annotateMathPhoto,
  badgeSize,
  mapBboxToPixels,
  placeBadge,
} from '../../lib/media/annotate';
import type { Bbox } from '../../lib/starters/types';

async function solidImage(width: number, height: number, rgb: [number, number, number]): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })
    .jpeg()
    .toBuffer();
}

async function rawPixels(buffer: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function pixelAt(img: { data: Buffer; width: number }, x: number, y: number): [number, number, number] {
  const i = (y * img.width + x) * 3;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

// JPEG chroma subsampling smears edges, so accept any pixel near the expected
// point that is clearly red-dominant.
function hasRedNear(img: { data: Buffer; width: number; height: number }, x: number, y: number, radius = 2): boolean {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const px = Math.min(Math.max(x + dx, 0), img.width - 1);
      const py = Math.min(Math.max(y + dy, 0), img.height - 1);
      const [r, g, b] = pixelAt(img, px, py);
      if (r > 170 && g < 140 && b < 140) return true;
    }
  }
  return false;
}

describe('mapBboxToPixels', () => {
  test('full-image box maps to the full image', () => {
    const rect = mapBboxToPixels({ x1: 0, y1: 0, x2: GRID_SIZE, y2: GRID_SIZE }, 400, 300);
    expect(rect).toEqual({ left: 0, top: 0, width: 400, height: 300 });
  });

  test('tiny box grows to the minimum side', () => {
    const rect = mapBboxToPixels({ x1: 500, y1: 500, x2: 502, y2: 503 }, 200, 100);
    expect(rect.width).toBe(MIN_SIDE_PX);
    expect(rect.height).toBe(MIN_SIDE_PX);
    expect(rect.left).toBe(100);
    expect(rect.top).toBe(50);
  });

  test('clamps out-of-range coordinates inside the image', () => {
    const rect = mapBboxToPixels({ x1: -100, y1: -50, x2: 1500, y2: 1200 }, 200, 100);
    expect(rect).toEqual({ left: 0, top: 0, width: 200, height: 100 });
  });

  test('keeps an edge box fully inside after the minimum-side growth', () => {
    const rect = mapBboxToPixels({ x1: 990, y1: 990, x2: 1000, y2: 1000 }, 200, 100);
    expect(rect).toEqual({ left: 192, top: 92, width: MIN_SIDE_PX, height: MIN_SIDE_PX });
  });

  test('scales correctly on a non-square image (800x400)', () => {
    const rect = mapBboxToPixels({ x1: 0, y1: 0, x2: 500, y2: 500 }, 800, 400);
    expect(rect).toEqual({ left: 0, top: 0, width: 400, height: 200 });
  });

  test('swaps inverted corners before mapping', () => {
    const rect = mapBboxToPixels({ x1: 800, y1: 600, x2: 200, y2: 300 }, 200, 100);
    expect(rect).toEqual({ left: 40, top: 30, width: 120, height: 30 });
  });
});

describe('annotateMathPhoto', () => {
  const SRC: [number, number, number] = [204, 204, 204];
  const BBOX: Bbox = { x1: 200, y1: 200, x2: 500, y2: 500 };

  // Expected geometry for BBOX on a 400x300 image: box (80,60)-(200,150),
  // ring padded 6px out, stroke max(3, round(400*0.004)) = 3.
  const RING = { left: 74, top: 54, right: 206, bottom: 156 };

  test('returns a JPEG of exactly the same dimensions', async () => {
    const source = await solidImage(400, 300, SRC);
    const out = await annotateMathPhoto({
      buffer: source,
      width: 400,
      height: 300,
      bbox: BBOX,
      stepNumber: 3,
    });
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(300);
  });

  test('ring edges are red and a far pixel is unchanged from the source', async () => {
    const source = await solidImage(400, 300, SRC);
    const out = await annotateMathPhoto({
      buffer: source,
      width: 400,
      height: 300,
      bbox: BBOX,
      stepNumber: 3,
    });
    const img = await rawPixels(out);

    const midX = Math.round((RING.left + RING.right) / 2);
    const midY = Math.round((RING.top + RING.bottom) / 2);
    expect(hasRedNear(img, midX, RING.top)).toBe(true); // top edge
    expect(hasRedNear(img, midX, RING.bottom)).toBe(true); // bottom edge
    expect(hasRedNear(img, RING.left, midY)).toBe(true); // left edge
    expect(hasRedNear(img, RING.right, midY)).toBe(true); // right edge

    const far = pixelAt(img, 10, 10);
    expect(Math.abs(far[0] - SRC[0])).toBeLessThanOrEqual(10);
    expect(Math.abs(far[1] - SRC[1])).toBeLessThanOrEqual(10);
    expect(Math.abs(far[2] - SRC[2])).toBeLessThanOrEqual(10);
  });

  test('draws a ring, not a filled box: red pixels stay a small fraction', async () => {
    const source = await solidImage(400, 300, SRC);
    const out = await annotateMathPhoto({
      buffer: source,
      width: 400,
      height: 300,
      bbox: BBOX,
      stepNumber: 3,
    });
    const img = await rawPixels(out);
    let red = 0;
    for (let i = 0; i < img.data.length; i += 3) {
      if (img.data[i] > 170 && img.data[i + 1] < 140 && img.data[i + 2] < 140) red++;
    }
    expect(red).toBeGreaterThan(0);
    expect(red / (img.width * img.height)).toBeLessThan(0.15);
  });

  test('clamps a box that runs off the image without changing dimensions', async () => {
    const source = await solidImage(200, 100, SRC);
    const out = await annotateMathPhoto({
      buffer: source,
      width: 200,
      height: 100,
      bbox: { x1: 900, y1: 900, x2: 1100, y2: 1100 },
      stepNumber: 1,
    });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(100);
    const img = await rawPixels(out);
    // Box lands near the bottom-right corner; the ring must still be visible.
    expect(hasRedNear(img, 195, 99, 6)).toBe(true);
  });

  test('renders the badge for step 1 and step 12 without throwing', async () => {
    const source = await solidImage(300, 200, SRC);
    for (const stepNumber of [1, 12]) {
      const out = await annotateMathPhoto({
        buffer: source,
        width: 300,
        height: 200,
        bbox: { x1: 100, y1: 100, x2: 400, y2: 500 },
        stepNumber,
      });
      const meta = await sharp(out).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBe(300);
      expect(meta.height).toBe(200);
    }
  });

  test('badge drops below the box when there is no room above', async () => {
    const source = await solidImage(300, 200, SRC);
    // Box flush with the top edge: the badge cannot fit above.
    const out = await annotateMathPhoto({
      buffer: source,
      width: 300,
      height: 200,
      bbox: { x1: 100, y1: 0, x2: 500, y2: 200 },
      stepNumber: 2,
    });
    const img = await rawPixels(out);
    // Box top maps to y=0, ring top clamps to stroke half, so the badge cannot
    // fit above: it lands just below the ring bottom at (24, 52), 28.8x35.2.
    expect(hasRedNear(img, 38, 70, 3)).toBe(true);
  });

  test('badge is about 60 percent bigger than the original 2px unit', () => {
    // Old sizes at BADGE_UNIT 2: one digit 18x22, two digits 34x22.
    expect(badgeSize(3).width).toBeCloseTo(28.8, 5);
    expect(badgeSize(3).height).toBeCloseTo(35.2, 5);
    expect(badgeSize(12).width).toBeCloseTo(48, 5);
    expect(badgeSize(12).height).toBeCloseTo(35.2, 5);
    expect(badgeSize(3).width / 18).toBeCloseTo(1.6, 5);
    expect(badgeSize(3).height / 22).toBeCloseTo(1.6, 5);
  });

  test('placeBadge keeps the badge inside small images', () => {
    // Above the ring when there is headroom, below when there is not.
    const above = placeBadge(3, { left: 40, top: 80, bottom: 120 }, 300, 200);
    expect(above).toEqual({ left: 40, top: 38.8 });
    const below = placeBadge(3, { left: 40, top: 2, bottom: 46 }, 300, 200);
    expect(below).toEqual({ left: 40, top: 52 });

    // Every placement on small images stays within the pixel bounds whenever
    // the image is at least badge sized.
    const badge = badgeSize(7);
    for (const [width, height] of [[300, 200], [200, 100], [120, 90], [100, 80]]) {
      for (const ringTop of [2, 10, 40]) {
        for (const ringBottom of [ringTop + 8, height - 2]) {
          const { left, top } = placeBadge(7, { left: 5, top: ringTop, bottom: ringBottom }, width, height);
          expect(left).toBeGreaterThanOrEqual(0);
          expect(left + badge.width).toBeLessThanOrEqual(width);
          expect(top).toBeGreaterThanOrEqual(0);
          expect(top + badge.height).toBeLessThanOrEqual(height);
        }
      }
    }
  });

  test('a corner box on a small image still keeps the badge visible', async () => {
    const source = await solidImage(120, 90, SRC);
    const out = await annotateMathPhoto({
      buffer: source,
      width: 120,
      height: 90,
      bbox: { x1: 800, y1: 800, x2: 1000, y2: 1000 },
      stepNumber: 1,
    });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(120);
    expect(meta.height).toBe(90);
    const img = await rawPixels(out);
    // Box lands near the bottom-right; the ring corner must stay visible, and
    // the badge fits in the space above the ring without covering the box.
    expect(hasRedNear(img, 116, 89, 4)).toBe(true);
  });
});
