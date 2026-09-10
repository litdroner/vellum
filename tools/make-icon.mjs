// Renders Vellum's mark (web/js/brand.js) into src/Vellum/Assets/Vellum.ico using the running app's
// renderer, so the icon matches the in-app mark exactly. Start the app with tools/run.ps1 -Debug first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './cdp-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'src', 'Vellum', 'Assets');
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];

const c = await connect();
const images = await c.evaluate(`(async () => {
  const { markSvg } = await import('/js/brand.js');
  const out = {};
  for (const size of ${JSON.stringify(sizes)}) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const inset = size >= 32 ? size * 0.06 : 0;
    const tile = size - inset * 2;
    const radius = tile * 0.24;
    // Raised satin tile, lit from above.
    const fill = ctx.createLinearGradient(0, inset, 0, inset + tile);
    fill.addColorStop(0, '#3d3731');
    fill.addColorStop(1, '#1f1b18');
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(inset, inset, tile, tile, radius);
    ctx.fill();
    if (size >= 24) {
      ctx.strokeStyle = 'rgba(255, 244, 228, .16)';
      ctx.lineWidth = Math.max(1, size / 64);
      ctx.beginPath();
      ctx.roundRect(inset + ctx.lineWidth / 2, inset + ctx.lineWidth / 2, tile - ctx.lineWidth, tile - ctx.lineWidth, radius);
      ctx.stroke();
    }
    // Thicker strokes at small sizes so the mark stays legible.
    const stroke = size <= 20 ? 2.6 : size <= 32 ? 2.2 : size <= 64 ? 1.9 : 1.6;
    const svg = markSvg(24)
      .replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')
      .replaceAll('var(--aqua)', '#86dbd3')
      .replaceAll('var(--peach)', '#f3bb9d')
      .replaceAll('currentColor', '#efe7da')
      .replaceAll('stroke-width="1.6"', 'stroke-width="' + stroke + '"');
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const mark = tile * (size <= 20 ? 0.9 : 0.74);
    ctx.drawImage(img, (size - mark) / 2, (size - mark) / 2, mark, mark);
    out[size] = canvas.toDataURL('image/png');
  }
  return out;
})()`);
c.close();

// ICO = header + directory + PNG images (PNG-compressed entries are supported since Windows Vista).
const pngs = sizes.map((s) => Buffer.from(images[s].split(',')[1], 'base64'));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
const directory = Buffer.alloc(16 * pngs.length);
let offset = header.length + directory.length;
pngs.forEach((png, i) => {
  const size = sizes[i];
  const at = i * 16;
  directory.writeUInt8(size >= 256 ? 0 : size, at);
  directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
  directory.writeUInt16LE(1, at + 4);
  directory.writeUInt16LE(32, at + 6);
  directory.writeUInt32LE(png.length, at + 8);
  directory.writeUInt32LE(offset, at + 12);
  offset += png.length;
});
fs.mkdirSync(assets, { recursive: true });
fs.writeFileSync(path.join(assets, 'Vellum.ico'), Buffer.concat([header, directory, ...pngs]));
fs.writeFileSync(path.join(assets, 'Vellum-256.png'), pngs.at(-1));
console.log(`wrote ${path.join(assets, 'Vellum.ico')} (${sizes.join(', ')} px)`);
