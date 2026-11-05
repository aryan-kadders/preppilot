#!/usr/bin/env node
/**
 * Generates every PrepPilot icon from the one mark in src/lib/brandMark.ts:
 *
 *   brand/preppilot-mark.svg, brand/preppilot-app-icon.svg   masters
 *   assets/icon.png, assets/icon-512.png,                     app icon (navy tile)
 *   assets/icons/mac/dock-icon.png (macOS icon grid), assets/icons/png/icon_N.png
 *   assets/Natively.icon/Assets/mark.png                      Icon Composer layer
 *   assets/icons/win/icon.ico                                 Windows (PNG-in-ICO)
 *   assets/icon.icns, assets/icons/mac/icon.icns              macOS (iconutil; macOS only)
 *   assets/natively.icns                                      DMG/bundle icon, on Apple's grid
 *   src/components/icon.png, src/assets/logo.webp             white mark, transparent
 *   src/assets/about/app-icon-{mac,win}.webp                  About page header
 *   assets/iconTemplate(@2x).png, src/components/iconTemplate.png   menu-bar template
 *
 * Run: node scripts/generate-brand-icons.mjs
 * Uses sharp (already a dependency). The .ico is written by hand (PNG entries,
 * supported since Windows Vista); the .icns needs macOS's iconutil and is
 * skipped elsewhere with a message, leaving the committed one in place.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = (rel) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); return p; };

// The mark's path, read from the TypeScript source so there is one definition.
const markSource = fs.readFileSync(path.join(root, 'src/lib/brandMark.ts'), 'utf8');
const MARK_D = [...markSource.matchAll(/'(M[^']+)'/g)].map((m) => m[1]).join(' ');
if (!MARK_D) throw new Error('could not read the mark path from src/lib/brandMark.ts');

const NAVY_TOP = '#15295A';
const NAVY_BOTTOM = '#0C1C40';

const markSvg = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="106 106 812 812" width="812" height="812" role="img" aria-label="PrepPilot mark"><path fill="${fill}" d="${MARK_D}"/></svg>`;

// App icon: a rounded navy tile with the white mark at 72% of the tile, centred.
const appIconSvg = () => {
  const scale = (1024 * 0.72) / 812;
  const offset = (1024 - 812 * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024" role="img" aria-label="PrepPilot">
<defs><linearGradient id="bg" x1="512" y1="0" x2="512" y2="1024" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${NAVY_TOP}"/><stop offset="1" stop-color="${NAVY_BOTTOM}"/></linearGradient></defs>
<rect x="0" y="0" width="1024" height="1024" rx="230" fill="url(#bg)"/>
<g transform="translate(${offset} ${offset}) scale(${scale}) translate(-106 -106)"><path fill="#FFFFFF" d="${MARK_D}"/></g>
</svg>`;
};

const render = (svg, size) => sharp(Buffer.from(svg), { density: 384 }).resize(size, size).png().toBuffer();

/** A .ico whose entries are PNGs (Vista+), largest last. */
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); e.writeUInt8(0, 3); e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    entries.push(e); offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

async function main() {
  const appSvg = appIconSvg();
  fs.writeFileSync(out('brand/preppilot-app-icon.svg'), appSvg);
  fs.writeFileSync(out('brand/preppilot-mark.svg'), markSvg('#000000'));

  // App icon PNGs.
  const app512 = await render(appSvg, 512);
  for (const rel of ['assets/icon.png', 'assets/icon-512.png']) fs.writeFileSync(out(rel), app512);

  // macOS icons sit on Apple's icon grid: the tile is 824 of 1024, centred.
  // The Dock draws a setIcon() bitmap ~1% smaller than a bundle icon, so the
  // running-tile PNG carries +1% (832 of 1024) to match its neighbours
  // (electron/utils/__tests__/macDockIconGrid2026_09_25.test.mjs).
  const onGrid = async (canvas, body) => sharp({ create: { width: canvas, height: canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await render(appSvg, body), left: Math.round((canvas - body) / 2), top: Math.round((canvas - body) / 2) }]).png().toBuffer();
  fs.writeFileSync(out('assets/icons/mac/dock-icon.png'), await onGrid(512, 416));

  // Icon Composer layer (assets/Natively.icon, packaged macOS builds): the white
  // mark at 60% of the canvas; macOS adds the tile, glass and shadow itself.
  const markLayer = await render(markSvg('#FFFFFF'), 614);
  fs.writeFileSync(out('assets/Natively.icon/Assets/mark.png'), await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: markLayer, left: 205, top: 205 }]).png().toBuffer());
  for (const size of [16, 32, 64, 128, 256, 512, 1024]) fs.writeFileSync(out(`assets/icons/png/icon_${size}x${size}.png`), await render(appSvg, size));

  // Windows .ico.
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoPngs = [];
  for (const size of icoSizes) icoPngs.push({ size, data: await render(appSvg, size) });
  fs.writeFileSync(out('assets/icons/win/icon.ico'), buildIco(icoPngs));

  // In-app white mark on transparent.
  const white = markSvg('#FFFFFF');
  fs.writeFileSync(out('src/components/icon.png'), await render(white, 644));
  fs.writeFileSync(out('src/assets/logo.webp'), await sharp(await render(white, 644)).webp({ lossless: true }).toBuffer());

  // About page header (the app icon, both platforms).
  const about = await sharp(await render(appSvg, 192)).webp({ quality: 92 }).toBuffer();
  fs.writeFileSync(out('src/assets/about/app-icon-mac.webp'), about);
  fs.writeFileSync(out('src/assets/about/app-icon-win.webp'), about);

  // Menu-bar template images: black shape on transparent (macOS uses only alpha).
  const black = markSvg('#000000');
  fs.writeFileSync(out('assets/iconTemplate.png'), await render(black, 16));
  fs.writeFileSync(out('assets/iconTemplate@2x.png'), await render(black, 32));
  fs.writeFileSync(out('src/components/iconTemplate.png'), await render(black, 16));

  // macOS .icns via iconutil.
  if (process.platform === 'darwin') {
    const set = fs.mkdtempSync(path.join(os.tmpdir(), 'preppilot-')) + '/icon.iconset';
    fs.mkdirSync(set);
    for (const s of [16, 32, 128, 256, 512]) {
      fs.writeFileSync(path.join(set, `icon_${s}x${s}.png`), await render(appSvg, s));
      fs.writeFileSync(path.join(set, `icon_${s}x${s}@2x.png`), await render(appSvg, s * 2));
    }
    for (const rel of ['assets/icon.icns', 'assets/icons/mac/icon.icns']) {
      execFileSync('iconutil', ['-c', 'icns', set, '-o', out(rel)]);
    }
    // natively.icns (DMG volume icon, copied into the bundle): on the icon grid.
    const gridSet = path.join(path.dirname(set), 'grid.iconset');
    fs.mkdirSync(gridSet);
    for (const s of [16, 32, 128, 256, 512]) {
      fs.writeFileSync(path.join(gridSet, `icon_${s}x${s}.png`), await onGrid(s, Math.round(s * 824 / 1024)));
      fs.writeFileSync(path.join(gridSet, `icon_${s}x${s}@2x.png`), await onGrid(s * 2, Math.round(s * 2 * 824 / 1024)));
    }
    execFileSync('iconutil', ['-c', 'icns', gridSet, '-o', out('assets/natively.icns')]);
    fs.rmSync(path.dirname(set), { recursive: true, force: true });
  } else {
    console.log('[brand-icons] Not macOS: kept the committed .icns files (iconutil is macOS-only).');
  }
  console.log('[brand-icons] Generated PrepPilot icons.');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
