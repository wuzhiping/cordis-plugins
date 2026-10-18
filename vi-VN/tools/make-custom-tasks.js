#!/usr/bin/env node
'use strict';
// Packetize the hardcoded Chinese copy of the deployment's own plugin surfaces
// (the ones that never call ctx.locale) for translation into Vietnamese.
//
//   node tools/make-custom-tasks.js            # 2 packets
//   node tools/make-custom-tasks.js --chunks 2
//
// Reads tools/custom-zh.json (tools/harvest-custom.js) and writes
// translations/custom-chunk-NN.json:
//
//   { "chunk": "01", "count": 240,
//     "entries": [ { "zh": "取得文件", "kind": "exact", "plugins": ["fdep-api-request-bundle"] } ] }
//
// kind: "exact" — a whole text node / attribute value
//       "fragment" — a concatenation fragment (leading/trailing space or punctuation)
//       "dynamic" — a template with {x} placeholders
//
// The translator writes translations/custom-vi-NN.json ({ "zh": "vi" }).

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const chunks = argv.indexOf('--chunks') !== -1 ? Number(argv[argv.indexOf('--chunks') + 1]) : 2;
const plugins = ['cute-clock', 'ntfy-teams', 'fdep-api-request-bundle', 'kaneo-web', 'dsh-minio-s3', 'dsh-file-share'];

const harvest = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'custom-zh.json'), 'utf8'));
const entries = new Map();
for (const plugin of plugins) {
  const data = harvest[plugin];
  if (!data) continue;
  for (const [kind, list] of [['exact', data.strings], ['dynamic', data.dynamic]]) {
    for (const zh of list) {
      if (!entries.has(zh)) entries.set(zh, { zh, kind, plugins: [] });
      const entry = entries.get(zh);
      if (!entry.plugins.includes(plugin)) entry.plugins.push(plugin);
    }
  }
}

// Classify concatenation fragments: the plugin builds labels like
// `count + ' 個 api'`, so the text node never equals the dictionary key.
for (const entry of entries.values()) {
  if (entry.kind === 'dynamic') continue;
  const zh = entry.zh;
  const fragment = /^\s/.test(zh) || /\s$/.test(zh) || /^[,，、。；;：:·—–-]/.test(zh) || /[,，、。；;：:·—–]$/.test(zh) || zh.length < 4;
  if (fragment) entry.kind = 'fragment';
}

// Keep each plugin's strings together for coherent context, then balance.
const byPlugin = new Map();
for (const entry of entries.values()) {
  const key = entry.plugins[0];
  if (!byPlugin.has(key)) byPlugin.set(key, []);
  byPlugin.get(key).push(entry);
}
const groups = [...byPlugin.entries()].sort((a, b) => b[1].length - a[1].length);
const buckets = Array.from({ length: chunks }, () => []);
for (const [, list] of groups) {
  const target = buckets.reduce((smallest, bucket) => (bucket.length < smallest.length ? bucket : smallest), buckets[0]);
  target.push(...list);
}
buckets.forEach((bucket, index) => bucket.sort((a, b) => a.zh.localeCompare(b.zh)));

const outDir = path.join(root, 'translations');
fs.mkdirSync(outDir, { recursive: true });
let total = 0;
buckets.forEach((bucket, index) => {
  const id = String(index + 1).padStart(2, '0');
  fs.writeFileSync(path.join(outDir, 'custom-chunk-' + id + '.json'), JSON.stringify({
    chunk: id,
    count: bucket.length,
    entries: bucket,
  }, null, 1) + '\n', 'utf8');
  total += bucket.length;
  const counts = bucket.reduce((acc, entry) => { acc[entry.kind] = (acc[entry.kind] || 0) + 1; return acc; }, {});
  console.log('custom-chunk-' + id + ': ' + bucket.length + ' strings  ' + JSON.stringify(counts) + '  plugins: ' + [...new Set(bucket.flatMap((entry) => entry.plugins))].join(', '));
});
console.log('total            : ' + total + ' strings');
console.log('write output to  : translations/custom-vi-<chunk>.json');
