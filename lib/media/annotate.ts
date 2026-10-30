// Draws the diagnosis onto the photo: a red ring around the first wrong step
// plus a numbered badge. Badge digits are hand-drawn SVG stroke paths, not
// <text>, because serverless runtimes often have no fonts installed and the
// badge must render identically everywhere. The input buffer is already
// upright (normalizeImage baked the EXIF orientation in), so no .rotate().

import sharp from 'sharp';
import type { Bbox } from '@/lib/starters/types';

export const GRID_SIZE = 1000;
export const MIN_SIDE_PX = 8;

const PAD_PX = 6; // ring padding outside the step box
const RING_COLOR = '#e5484d';
const BADGE_TEXT_COLOR = '#ffffff';
const BADGE_UNIT = 2; // px per glyph grid unit (glyphs live on a 5x7 grid)
const BADGE_GAP_PX = 4;

export type PixelRect = { left: number; top: number; width: number; height: number };

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

// Maps the 0-1000 grounding grid to the pixel size of the exact image sent,
// per docs/meta-api/image-understanding.md: round(x * width / 1000), then
// clamped inside the image with a minimum side so tiny boxes stay visible.
export function mapBboxToPixels(bbox: Bbox, width: number, height: number): PixelRect {
  const x1 = Math.min(bbox.x1, bbox.x2);
  const x2 = Math.max(bbox.x1, bbox.x2);
  const y1 = Math.min(bbox.y1, bbox.y2);
  const y2 = Math.max(bbox.y1, bbox.y2);
  let left = clamp(Math.round((x1 * width) / GRID_SIZE), 0, width);
  let top = clamp(Math.round((y1 * height) / GRID_SIZE), 0, height);
  const right = clamp(Math.round((x2 * width) / GRID_SIZE), 0, width);
  const bottom = clamp(Math.round((y2 * height) / GRID_SIZE), 0, height);
  let w = Math.max(right - left, MIN_SIDE_PX);
  let h = Math.max(bottom - top, MIN_SIDE_PX);
  if (left + w > width) left = width - w;
  if (top + h > height) top = height - h;
  if (w > width) w = width;
  if (h > height) h = height;
  if (left < 0) left = 0;
  if (top < 0) top = 0;
  return { left, top, width: w, height: h };
}

// Stroke digits on a 5x7 grid (x 0..4, y 0..6), one polyline list per digit.
// Blocky but unambiguous at badge size, and pure geometry: no font needed.
const DIGIT_STROKES: Record<string, number[][][]> = {
  '0': [[[0, 0], [4, 0], [4, 6], [0, 6], [0, 0]]],
  '1': [[[1, 1], [2, 0], [2, 6]], [[1, 6], [3, 6]]],
  '2': [[[0, 0], [4, 0], [4, 3], [0, 3], [0, 6], [4, 6]]],
  '3': [[[0, 0], [4, 0], [4, 6], [0, 6]], [[1, 3], [4, 3]]],
  '4': [[[3, 0], [3, 6]], [[0, 0], [0, 3], [4, 3]]],
  '5': [[[4, 0], [0, 0], [0, 3], [4, 3], [4, 6], [0, 6]]],
  '6': [[[4, 0], [0, 0], [0, 6], [4, 6], [4, 3], [0, 3]]],
  '7': [[[0, 0], [4, 0], [1, 6]]],
  '8': [[[0, 0], [4, 0], [4, 6], [0, 6], [0, 0]], [[0, 3], [4, 3]]],
  '9': [[[4, 3], [0, 3], [0, 0], [4, 0], [4, 6], [0, 6]]],
};

function badgeSize(stepNumber: number): { width: number; height: number } {
  const digits = Math.max(0, Math.trunc(stepNumber)).toString().slice(0, 2).length;
  const u = BADGE_UNIT;
  // Per digit: 5 unit glyph plus a 1 unit gap; then a 2 unit pad on each side.
  return { width: digits * 6 * u - u + 4 * u, height: 7 * u + 4 * u };
}

// Renders the filled badge with stroke-path digits, positioned at (left, top).
function badgeSvg(stepNumber: number, left: number, top: number): string {
  const text = Math.max(0, Math.trunc(stepNumber)).toString().slice(0, 2);
  const u = BADGE_UNIT;
  const size = badgeSize(stepNumber);
  const shapes: string[] = [];
  // Glyph origin inside the badge, one digit cell (6 units) at a time.
  let ox = 2 * u;
  for (const ch of text) {
    const strokes = DIGIT_STROKES[ch] ?? DIGIT_STROKES['0'];
    for (const points of strokes) {
      const pts = points.map(([x, y]) => `${ox + x * u},${y * u}`).join(' ');
      shapes.push(
        `<polyline points="${pts}" fill="none" stroke="${BADGE_TEXT_COLOR}" stroke-width="${u}" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    }
    ox += 6 * u;
  }
  return (
    `<g transform="translate(${left},${top})">` +
    `<rect x="0" y="0" width="${size.width}" height="${size.height}" rx="${3 * u}" fill="${RING_COLOR}"/>` +
    shapes.join('') +
    '</g>'
  );
}

export type AnnotateMathPhotoArgs = {
  buffer: Buffer;
  width: number;
  height: number;
  bbox: Bbox;
  stepNumber: number;
};

// Returns a JPEG of EXACTLY the same width and height as the input: the
// overlay is a full-frame SVG composited on top, nothing is resized.
export async function annotateMathPhoto(args: AnnotateMathPhotoArgs): Promise<Buffer> {
  const { buffer, width, height, bbox, stepNumber } = args;
  const box = mapBboxToPixels(bbox, width, height);
  const stroke = Math.max(3, Math.round(Math.max(width, height) * 0.004));
  const half = stroke / 2;

  // Ring: the step box padded out, clamped so the stroke stays in the image.
  const ringLeft = clamp(box.left - PAD_PX, half, width - half);
  const ringTop = clamp(box.top - PAD_PX, half, height - half);
  const ringRight = clamp(box.left + box.width + PAD_PX, half, width - half);
  const ringBottom = clamp(box.top + box.height + PAD_PX, half, height - half);
  const ringWidth = Math.max(ringRight - ringLeft, MIN_SIDE_PX);
  const ringHeight = Math.max(ringBottom - ringTop, MIN_SIDE_PX);
  const radius = Math.min(12, Math.floor(Math.min(ringWidth, ringHeight) / 4));

  // Badge above the ring when it fits, otherwise below it.
  const badge = badgeSize(stepNumber);
  const aboveTop = ringTop - BADGE_GAP_PX - badge.height;
  const badgeTop =
    aboveTop >= 0
      ? aboveTop
      : Math.min(ringBottom + BADGE_GAP_PX, Math.max(0, height - badge.height));
  const badgeLeft = clamp(ringLeft, 0, Math.max(0, width - badge.width));

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect x="${ringLeft}" y="${ringTop}" width="${ringWidth}" height="${ringHeight}" rx="${radius}" fill="none" stroke="${RING_COLOR}" stroke-width="${stroke}"/>`,
    badgeSvg(stepNumber, badgeLeft, badgeTop),
    '</svg>',
  ].join('');

  return sharp(buffer)
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }])
    .jpeg({ quality: 88 })
    .toBuffer();
}
