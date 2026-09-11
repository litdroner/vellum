// Renders Vellum's app icon (web/js/brand.js) with the running app's renderer, so it matches the in-app
// icon exactly. Start the app with tools/run.ps1 -Debug first.
// usage: node tools/make-icon.mjs [variant]          writes src/Vellum/Assets/Vellum.ico (+ 256 px PNG)
//        node tools/make-icon.mjs --preview <dir>    writes PNG previews of every variant, nothing else
// Variants follow the colour themes: mist (default), sage, ocean, blush, sand, lavender, graphite, dark.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './cdp-client.mjs';

const VARIANTS = {
  mist: ['#2e8c87', false],
  sage: ['#4a8757', false],
  ocean: ['#2f76b8', false],
  blush: ['#bf5577', false],
  sand: ['#a4692c', false],
  lavender: ['#6f57b6', false],
  graphite: ['#48525f', false],
  dark: ['#3aa39b', true],
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'src', 'Vellum', 'Assets');
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const previewAt = process.argv.indexOf('--preview');
const previewDir = previewAt > 0 ? process.argv[previewAt + 1] : null;
const chosen = previewDir ? Object.keys(VARIANTS) : [process.argv[2] ?? 'mist'];
if (chosen.some((v) => !VARIANTS[v])) throw new Error(`Unknown variant; use ${Object.keys(VARIANTS).join(', ')}`);

const c = await connect();
const render = (variant, list) => c.evaluate(`(async () => {
  const { appIconSvg, iconColors } = await import('/js/brand.js?' + Date.now());
  const [accent, dark] = ${JSON.stringify(VARIANTS[variant])};
  const out = {};
  for (const size of ${JSON.stringify(list)}) {
    // The artwork has its own margin (the tile starts 2 units in), so it fills the canvas.
    const svg = appIconSvg(size, iconColors(accent, { dark })).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    canvas.getContext('2d').drawImage(img, 0, 0, size, size);
    out[size] = canvas.toDataURL('image/png');
  }
  return out;
})()`);

if (previewDir) {
  fs.mkdirSync(previewDir, { recursive: true });
  for (const variant of chosen) {
    const images = await render(variant, [256, 48, 24]);
    for (const [size, url] of Object.entries(images)) {
      fs.writeFileSync(path.join(previewDir, `icon-${variant}-${size}.png`), Buffer.from(url.split(',')[1], 'base64'));
    }
  }
  c.close();
  console.log(`wrote previews of ${chosen.join(', ')} to ${previewDir}`);
} else {
  const images = await render(chosen[0], sizes);
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
  console.log(`wrote ${path.join(assets, 'Vellum.ico')} (${chosen[0]}; ${sizes.join(', ')} px)`);
}
