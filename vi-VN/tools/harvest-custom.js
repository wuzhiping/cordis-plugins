#!/usr/bin/env node
'use strict';
// Harvest Chinese UI string literals from the deployment's own plugin bundles so
// the vi-VN surface layer can translate the plugin surfaces that hardcode
// Chinese instead of registering locale dictionaries.
//
//   node tools/harvest-custom.js                 # summary + tools/custom-zh.json
//   node tools/harvest-custom.js --json out.json
//
// Only string literals that contain a CJK character are kept. Template literals
// with `${...}` are reported separately (`dynamic`) because they need a pattern,
// not an exact dictionary entry.

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const profileDir = process.env.DSH_PROFILE_DIR || 'D:/Refine/Books/ntop/AI/dsh/profiles/web';
const plugins = [
  'cute-clock',
  'fdep-api-request-bundle',
  'kaneo-web',
  'ntfy-teams',
  'dsh-minio-s3',
  'today-material-panel',
  'scene-template',
  'ov-memory',
  'sidebar-plugins-toggle',
  'dsh-file-share',
  'jeeflow-panel',
];
const CJK = /[\u3400-\u9fff]/;
const candidates = (plugin) => [
  path.join(profileDir, 'node_modules', plugin, 'lib', 'client.js'),
  path.join(profileDir, 'node_modules', plugin, 'client', 'bundle.js'),
  path.join(profileDir, 'node_modules', plugin, 'client', 'index.js'),
  path.join(profileDir, 'node_modules', plugin, 'client.js'),
];

// Collect single/double quoted literals that contain CJK. The bundles are
// hand-written and unminified, and they carry long Chinese JSDoc blocks, so the
// scanner skips comments before looking at literals and drops anything that
// still looks like code rather than UI copy.
function literals(text) {
  const found = new Set();
  const dynamic = new Set();
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    // Skip block and line comments outside strings.
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i + 2);
      i = end === -1 ? text.length : end;
      continue;
    }
    const quote = text[i];
    if (quote !== '"' && quote !== "'" && quote !== '`') continue;
    let out = '';
    let hasInterpolation = false;
    for (i += 1; i < text.length; i += 1) {
      const inner = text[i];
      if (inner === '\\') { i += 1; out += text[i] === 'n' ? '\n' : text[i] === 't' ? '\t' : text[i]; continue; }
      if (inner === quote) break;
      if (quote === '`' && inner === '$' && text[i + 1] === '{') {
        hasInterpolation = true;
        let depth = 0;
        for (; i < text.length; i += 1) {
          if (text[i] === '{') depth += 1;
          else if (text[i] === '}') { depth -= 1; if (depth === 0) break; }
        }
        out += '{x}';
        continue;
      }
      out += inner;
    }
    if (!CJK.test(out)) continue;
    if (out.length < 2 || out.length > 120) continue;
    // Drop code-shaped leftovers (JSDoc fragments, expressions, paths).
    if (/[\n\r]/.test(out)) continue;
    if (/(?:=>|\bconst\b|\bfunction\b|\breturn\b|^\s*\*|\/\/|https?:\/\/)/.test(out)) continue;
    if (/^(?:[a-zA-Z0-9_.-]+|[\s\W])+$/.test(out) && !/[\u3400-\u9fff]/.test(out.replace(/[^\u3400-\u9fff]/g, ''))) continue;
    if (hasInterpolation) dynamic.add(out);
    else found.add(out);
  }
  return { found: [...found], dynamic: [...dynamic], length: text.length };
}

const outDir = path.resolve(root, 'tools');
const argv = process.argv.slice(2);
const target = argv.indexOf('--json') !== -1 ? argv[argv.indexOf('--json') + 1] : path.join(outDir, 'custom-zh.json');

const result = {};
let total = 0;
for (const plugin of plugins) {
  let file = null;
  for (const candidate of candidates(plugin)) if (fs.existsSync(candidate)) { file = candidate; break; }
  if (!file) { console.log(plugin + ': not installed, skipped'); continue; }
  const harvested = literals(fs.readFileSync(file, 'utf8'));
  result[plugin] = { file: path.basename(file), strings: harvested.found.sort(), dynamic: harvested.dynamic.sort() };
  total += harvested.found.length;
  console.log(plugin + ': ' + harvested.found.length + ' static, ' + harvested.dynamic.length + ' dynamic  (' + path.basename(file) + ')');
}
fs.writeFileSync(target, JSON.stringify(result, null, 1) + '\n', 'utf8');
console.log('total static strings: ' + total);
console.log('wrote: ' + target);
