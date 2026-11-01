// Regenerates the raster brand assets from the two source SVGs with sharp.
//
//   bun run scripts/build-brand.ts
//
// Writes: app/favicon.ico (16/32/48 PNG-in-ICO), app/apple-icon.png (180),
// public/brand/settle-icon-512.png, public/brand/settle-icon-1024.png.
// All raster assets put the mark on opaque paper #F5F8EF with ~14 percent
// padding, so Telegram and Stripe never see transparent edges.
//
//   bun run scripts/build-brand.ts --preview
//
// additionally writes the manager contact sheet plus a 1024 mark render to
// BRAND_PREVIEW_DIR (default /Users/itzmaniss/.hermes/cache/scratch/brand-preview).
// package.json stays untouched on purpose; run this file directly.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const ROOT = join(import.meta.dir, "..");
const MARK_SVG = readFileSync(join(ROOT, "public/brand/settle-mark.svg"));
const FAVICON_SVG = readFileSync(join(ROOT, "app/icon.svg"));
const PAPER = "#F5F8EF";

const VIEWBOX = 512;

// Render the SVG at its natural 512 raster (2x density for sizes above it),
// then resize to the target so small sizes keep clean antialiased edges.
async function renderSvg(svg: Buffer, size: number): Promise<Buffer> {
  const density = size > VIEWBOX ? 72 * (size / VIEWBOX) : 72;
  return sharp(svg, { density }).resize(size, size).png().toBuffer();
}

// Square opaque PNG: the mark centred on paper with ~14 percent padding.
async function paperIcon(svg: Buffer, size: number): Promise<Buffer> {
  const content = Math.round(size * 0.72);
  const mark = await renderSvg(svg, content);
  const offset = Math.round((size - content) / 2);
  return sharp({
    create: { width: size, height: size, channels: 4, background: PAPER },
  })
    .composite([{ input: mark, top: offset, left: offset }])
    .png()
    .toBuffer();
}

// ICONDIR (6 bytes) + one 16 byte ICONDIRENTRY per image + PNG payloads.
function buildIco(images: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((image, i) => {
    const entry = i * 16;
    header.writeUInt8(image.size, 6 + entry);
    header.writeUInt8(image.size, 7 + entry);
    header.writeUInt8(0, 8 + entry); // palette colours
    header.writeUInt8(0, 9 + entry); // reserved
    header.writeUInt16LE(1, 10 + entry); // planes
    header.writeUInt16LE(32, 12 + entry); // bits per pixel
    header.writeUInt32LE(image.data.length, 14 + entry);
    header.writeUInt32LE(offset, 18 + entry);
    offset += image.data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

async function buildAssets() {
  const ico = buildIco(
    await Promise.all(
      [16, 32, 48].map(async (size) => ({
        size,
        data: await renderSvg(FAVICON_SVG, size),
      }))
    )
  );
  writeFileSync(join(ROOT, "app/favicon.ico"), ico);

  writeFileSync(join(ROOT, "app/apple-icon.png"), await paperIcon(MARK_SVG, 180));
  writeFileSync(
    join(ROOT, "public/brand/settle-icon-512.png"),
    await paperIcon(MARK_SVG, 512)
  );
  writeFileSync(
    join(ROOT, "public/brand/settle-icon-1024.png"),
    await paperIcon(MARK_SVG, 1024)
  );
  console.log("brand assets written");
}

// Contact sheet for the manager review: full mark and favicon variant at
// 16 to 180 px on paper, white and ink, small sizes upscaled nearest so the
// real pixels stay visible. Nothing labelled, pure grid.
async function buildPreview() {
  const previewDir =
    process.env.BRAND_PREVIEW_DIR ?? "/Users/itzmaniss/.hermes/cache/scratch/brand-preview";
  mkdirSync(previewDir, { recursive: true });

  const sizes = [16, 24, 32, 48, 64, 128, 180];
  const backgrounds = [PAPER, "#FFFFFF", "#12161F"];
  const variants = [
    { name: "mark", svg: MARK_SVG },
    { name: "favicon", svg: FAVICON_SVG },
  ];

  const tile = 232;
  const gap = 4;
  const cols = backgrounds.length;
  const rows = variants.length * sizes.length;
  const canvasW = cols * tile + (cols + 1) * gap;
  const canvasH = rows * tile + (rows + 1) * gap;
  const composites: { input: Buffer; top: number; left: number }[] = [];

  for (const [v, variant] of variants.entries()) {
    for (const [s, size] of sizes.entries()) {
      const factor = Math.max(1, Math.floor(200 / size));
      const display = size * factor;
      const rendered = await renderSvg(variant.svg, size);
      const icon =
        factor > 1
          ? await sharp(rendered)
              .resize(display, display, { kernel: "nearest" })
              .png()
              .toBuffer()
          : rendered;
      for (const [b, bg] of backgrounds.entries()) {
        const tileImage = await sharp({
          create: { width: tile, height: tile, channels: 4, background: bg },
        })
          .composite([
            {
              input: icon,
              top: Math.round((tile - display) / 2),
              left: Math.round((tile - display) / 2),
            },
          ])
          .png()
          .toBuffer();
        const row = v * sizes.length + s;
        composites.push({
          input: tileImage,
          top: gap + row * (tile + gap),
          left: gap + b * (tile + gap),
        });
      }
    }
  }

  await sharp({
    create: { width: canvasW, height: canvasH, channels: 4, background: "#DDDDDD" },
  })
    .composite(composites)
    .png()
    .toFile(join(previewDir, "contact-sheet.png"));

  await sharp(await paperIcon(MARK_SVG, 1024))
    .png()
    .toFile(join(previewDir, "mark-1024.png"));
  console.log(`preview written to ${previewDir}`);
}

const withPreview = process.argv.includes("--preview");
await buildAssets();
if (withPreview) await buildPreview();
