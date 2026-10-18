#!/usr/bin/env node
'use strict';
// Split the harvested unique English strings into translation work packets.
//
//   node tools/make-translation-tasks.js            # 5 balanced chunks
//   node tools/make-translation-tasks.js --chunks 6
//
// Namespaces stay whole so a translator sees coherent context. Each packet is
// translations/chunk-NN.json:
//
//   { "chunk": "01", "count": 430, "namespaces": [...],
//     "entries": [ { "en": "...", "zh": "...", "keys": ["..:.."] } ] }
//
// The translator writes translations/vi-NN.json mapping the exact English
// string to Vietnamese.

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const chunks = argv.indexOf('--chunks') !== -1 ? Number(argv[argv.indexOf('--chunks') + 1]) : 5;

const corpus = JSON.parse(fs.readFileSync(path.join(root, 'corpus.json'), 'utf8'));
const strings = JSON.parse(fs.readFileSync(path.join(root, 'strings.json'), 'utf8'));

const byNamespace = new Map();
for (const entry of strings) {
  const namespace = entry.usages[0].split(':')[0];
  if (!byNamespace.has(namespace)) byNamespace.set(namespace, []);
  byNamespace.get(namespace).push(entry);
}

// Namespaces sorted by size descending, then greedily placed into the currently
// smallest chunk so packets stay balanced without splitting a namespace.
const namespaces = [...byNamespace.entries()].sort((a, b) => b[1].length - a[1].length);
const buckets = Array.from({ length: chunks }, () => ({ namespaces: [], entries: [] }));
for (const [namespace, entries] of namespaces) {
  const target = buckets.reduce((smallest, bucket) => (bucket.entries.length < smallest.entries.length ? bucket : smallest), buckets[0]);
  target.namespaces.push(namespace);
  for (const entry of entries) {
    // Only the first usage is needed for context; the full set is in corpus.json.
    target.entries.push({ en: entry.en, zh: entry.zh, keys: entry.usages.slice(0, 2) });
  }
}

const outDir = path.join(root, 'translations');
fs.mkdirSync(outDir, { recursive: true });
let total = 0;
buckets.forEach((bucket, index) => {
  const id = String(index + 1).padStart(2, '0');
  const packet = {
    chunk: id,
    count: bucket.entries.length,
    namespaces: bucket.namespaces.sort(),
    entries: bucket.entries.sort((a, b) => a.en.localeCompare(b.en)),
  };
  fs.writeFileSync(path.join(outDir, 'chunk-' + id + '.json'), JSON.stringify(packet, null, 1) + '\n', 'utf8');
  total += bucket.entries.length;
  console.log('chunk-' + id + ': ' + packet.count + ' strings  namespaces: ' + packet.namespaces.join(', '));
});
console.log('total            : ' + total + ' strings in ' + chunks + ' chunks');
console.log('write output to  : translations/vi-<chunk>.json  ({ "en string": "vi string" })');
