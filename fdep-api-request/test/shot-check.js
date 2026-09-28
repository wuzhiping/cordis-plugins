'use strict';

// Objective checks on a rendered screenshot, for when the agent cannot view
// images directly. Reports geometry, whether the page actually rendered, and
// the colour clusters it can find — enough to answer "is that glyph green?"
// without eyes.
//
//   node test/shot-check.js <png> [--expect-green]
//
// The green test is deliberately integer-only: a full HSL conversion per pixel
// over ~10M pixels takes tens of seconds, which is too slow for a dev check.

const path = require('node:path');
const fs = require('node:fs');

const SHARP_PATHS = [
  'D:/Refine/Books/ntop/AI/node/global/node_modules/@deepseek-ai/dsh/node_modules/sharp',
  'D:/Refine/Books/ntop/AI/dsh/profiles/node_modules/sharp',
];

let sharp = null;
for (const p of SHARP_PATHS) {
  if (!fs.existsSync(p)) continue;
  try { sharp = require(p); break; } catch (_) { /* try next */ }
}
if (!sharp) {
  console.error('sharp not found; tried:');
  SHARP_PATHS.forEach((p) => console.error('  ' + p));
  process.exit(2);
}

// The green band we care about (hue ~80-175 degrees, saturated, mid lightness)
// is equivalent to a couple of integer comparisons. `g` must lead both other
// channels by a margin, and sit above the noise floor and below white.
function isGreenish(r, g, b) {
  return g > r + 18 && g > b + 12 && g > 55 && g < 250;
}

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error('usage: node test/shot-check.js <png> [--expect-green]');
    process.exit(2);
  }

  const img = sharp(file);
  const meta = await img.metadata();
  console.log('image    : ' + path.basename(file));
  console.log('size     : ' + meta.width + ' x ' + meta.height + '  (' + meta.channels + ' channels)');

  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const ch = info.channels;

  const colours = new Map();
  const cells = new Map();
  const CELL = 32;
  let greenPixels = 0;

  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * ch;
      const r = data[i]; const g = data[i + 1]; const b = data[i + 2];

      const key = (r >> 4) + ',' + (g >> 4) + ',' + (b >> 4);
      colours.set(key, (colours.get(key) || 0) + 1);

      if (!isGreenish(r, g, b)) continue;
      greenPixels += 1;
      const ck = Math.floor(x / CELL) + ',' + Math.floor(y / CELL);
      const c = cells.get(ck) || { n: 0, rs: 0, gs: 0, bs: 0 };
      c.n += 1; c.rs += r; c.gs += g; c.bs += b;
      cells.set(ck, c);
    }
  }

  const total = W * H;
  console.log('pixels   : ' + total);
  console.log('distinct colour buckets (4-bit): ' + colours.size);
  console.log('');

  const top = Array.from(colours.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log('dominant colours:');
  for (const [key, n] of top) {
    const parts = key.split(',').map((v) => (Number(v) << 4) + 8);
    console.log('  rgb(' + parts.join(',') + ')  ' + (100 * n / total).toFixed(1) + '%');
  }
  console.log('');

  console.log('green pixels: ' + greenPixels + '  (' + (100 * greenPixels / total).toFixed(3) + '%)');

  // A single global bbox is misleading: the panel legitimately uses the same
  // success green for its status dots and titles, so "green" spans the page.
  // Grid the hits instead — a compact dense cell count is a glyph; a wide row
  // of cells beside body text is a status title.
  const ranked = Array.from(cells.entries())
    .map(([k, c]) => {
      const [cx, cy] = k.split(',').map(Number);
      return {
        x: cx * CELL, y: cy * CELL, n: c.n,
        rgb: [Math.round(c.rs / c.n), Math.round(c.gs / c.n), Math.round(c.bs / c.n)],
      };
    })
    .sort((a, b) => b.n - a.n)
    .slice(0, 14);

  console.log('green cells (' + CELL + 'px grid): ' + cells.size);
  for (const c of ranked) {
    console.log('  @' + String(c.x).padStart(5) + ',' + String(c.y).padStart(5)
      + '  ' + String(c.n).padStart(5) + ' px   rgb(' + c.rgb.join(',') + ')');
  }
  console.log('');

  console.log(colours.size <= 2 ? 'VERDICT: page looks BLANK' : 'VERDICT: page rendered content');

  if (process.argv.includes('--expect-green')) {
    const dense = ranked.find((c) => c.n >= 60);
    if (greenPixels < 40) {
      console.log('VERDICT: expected a green glyph but found almost no green pixels');
      process.exitCode = 1;
    } else if (!dense) {
      console.log('VERDICT: green present but no dense cluster — no solid glyph found');
      process.exitCode = 1;
    } else {
      console.log('VERDICT: green glyph present — dense cluster @' + dense.x + ',' + dense.y
        + ' (' + dense.n + ' px, rgb(' + dense.rgb.join(',') + '))');
      process.exitCode = 0;
    }
  }
}

main().catch((err) => { console.error(err); process.exitCode = 2; });
