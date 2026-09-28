'use strict';

// Renders the preview page in both themes with a headless browser, then checks
// each shot for the things that are objective about it.
//
//   node test/shoot.js
//
// This exists because the agent cannot view images. Rendering its own preview
// file and analysing the pixels is not the same as looking at the GUI — it is
// a check on the preview artefact only — but it does catch the failure modes
// that code review cannot: a blank page, an invisible glyph, a colour that
// does not resolve in one of the two themes.
//
// The screenshots are written next to this file and are safe to delete.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HERE = __dirname;
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

const WIDTH = 1100;
const HEIGHT = 2400;
const SCALE = 2;

function findBrowser() {
  for (const p of BROWSERS) if (fs.existsSync(p)) return p;
  return null;
}

function shoot(browser, url, out) {
  fs.rmSync(out, { force: true });
  const res = spawnSync(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--force-device-scale-factor=' + SCALE,
    '--virtual-time-budget=3000',
    '--window-size=' + WIDTH + ',' + HEIGHT,
    '--screenshot=' + out,
    url,
  ], { encoding: 'utf8' });
  if (!fs.existsSync(out)) {
    return { ok: false, why: (res.stderr || '').split('\n')[0] || 'no file produced' };
  }
  return { ok: true, bytes: fs.statSync(out).size };
}

function analyse(png) {
  const res = spawnSync(process.execPath, [path.join(HERE, 'shot-check.js'), png, '--expect-green'], {
    encoding: 'utf8',
  });
  return { ok: res.status === 0, out: (res.stdout || '') + (res.stderr || '') };
}

function summarise(text) {
  const green = text.match(/green pixels: (\d+)\s+\(([\d.]+)%\)/);
  const dense = text.match(/dense cluster @(\d+),(\d+) \((\d+) px, (rgb\([^)]+\))\)/);
  const dom = text.match(/^\s+(rgb\([^)]+\))\s+([\d.]+)%/m);
  const verdict = text.match(/VERDICT: (.*)/g) || [];
  return {
    greenPixels: green ? Number(green[1]) : null,
    dominant: dom ? dom[1] + ' ' + dom[2] + '%' : null,
    cluster: dense ? dense[4] + ' (' + dense[3] + ' px @' + dense[1] + ',' + dense[2] + ')' : null,
    verdicts: verdict.map((v) => v.replace('VERDICT: ', '')),
  };
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.error('SKIP: no Chrome or Edge found');
    process.exit(2);
  }
  console.log('browser : ' + browser);
  console.log('');

  const themes = [
    { name: 'light', html: 'preview.html', png: path.join(HERE, '_shot-light.png') },
    { name: 'dark', html: 'preview-dark.html', png: path.join(HERE, '_shot-dark.png') },
  ];

  let failed = 0;
  for (const t of themes) {
    // Regenerate so the shot always reflects the current source.
    const gen = spawnSync(process.execPath, [path.join(HERE, 'preview.js')]
      .concat(t.name === 'dark' ? ['--theme=dark'] : []), { encoding: 'utf8' });
    if (gen.status !== 0) {
      console.log(t.name.padEnd(6) + ' preview generation FAILED');
      console.log((gen.stdout || '') + (gen.stderr || ''));
      failed += 1;
      continue;
    }

    const file = path.join(HERE, t.html);
    const url = 'file:///' + file.replace(/\\/g, '/');
    const shot = shoot(browser, url, t.png);
    if (!shot.ok) {
      console.log(t.name.padEnd(6) + ' screenshot FAILED: ' + shot.why);
      failed += 1;
      continue;
    }

    const check = analyse(t.png);
    const s = summarise(check.out);
    console.log(t.name.padEnd(6) + (check.ok ? 'PASS' : 'FAIL')
      + '  ' + shot.bytes + ' bytes');
    console.log('       dominant  : ' + s.dominant);
    console.log('       green px  : ' + s.greenPixels + (s.cluster ? '   glyph ' + s.cluster : ''));
    if (!check.ok) {
      console.log(s.verdicts.map((v) => '       ' + v).join('\n'));
      failed += 1;
    }
  }

  console.log('');
  console.log(failed === 0
    ? 'BOTH THEMES RENDER — green glyph present in each.'
    : failed + ' theme(s) failed.');
  console.log('');
  console.log('Note: this checks the PREVIEW artefact, not the running GUI. The preview');
  console.log('token values are approximations; the structure and token usage are exact.');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => { console.error(err); process.exitCode = 2; });
