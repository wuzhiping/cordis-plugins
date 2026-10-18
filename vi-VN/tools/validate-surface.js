#!/usr/bin/env node
'use strict';
// Validate the custom-plugin surface packets without building.
//
//   node tools/validate-surface.js
//
// Checks per packet: key set, CJK leftovers, {x} placeholder counts, fragment
// whitespace preservation, emoji count drift. Exit code 1 on hard failures.

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const translationsDir = path.join(root, 'translations');
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const placeholder = /\{x\}/g;
const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2700}-\u{27BF}]/gu;

function count(text, re) {
  const matches = text.match(re);
  return matches === null ? 0 : matches.length;
}

let failed = false;
const packets = fs.readdirSync(translationsDir).filter((name) => /^custom-chunk-\d+\.json$/.test(name)).sort();
for (const packetName of packets) {
  const id = packetName.match(/\d+/)[0];
  const packet = JSON.parse(fs.readFileSync(path.join(translationsDir, packetName), 'utf8'));
  const outputName = 'custom-vi-' + id + '.json';
  const outputPath = path.join(translationsDir, outputName);
  if (!fs.existsSync(outputPath)) { console.log(outputName + ': MISSING'); failed = true; continue; }
  let output;
  try { output = JSON.parse(fs.readFileSync(outputPath, 'utf8')); } catch (error) { console.log(outputName + ': invalid JSON — ' + error.message); failed = true; continue; }
  const input = new Map(packet.entries.map((entry) => [entry.zh, entry]));
  const missing = [];
  const extra = [];
  const badSlots = [];
  const chinese = [];
  const badSpaces = [];
  const badEmoji = [];
  for (const zh of input.keys()) if (!(zh in output)) missing.push(zh);
  for (const [zh, vi] of Object.entries(output)) {
    if (!input.has(zh)) { extra.push(zh); continue; }
    if (typeof vi !== 'string') { badSlots.push(zh + ' → non-string'); continue; }
    if (CJK.test(vi)) chinese.push(JSON.stringify({ zh, vi }));
    if (count(zh, placeholder) !== count(vi, placeholder)) badSlots.push(JSON.stringify({ zh, vi }));
    const entry = input.get(zh);
    if (entry.kind === 'fragment') {
      if (/^\s/.test(zh) !== /^\s/.test(vi) || /\s$/.test(zh) !== /\s$/.test(vi)) badSpaces.push(JSON.stringify({ zh, vi }));
    }
    if (count(zh, emoji) !== count(vi, emoji)) badEmoji.push(JSON.stringify({ zh, vi }));
  }
  const translated = Object.keys(output).length;
  const coverage = ((translated / packet.entries.length) * 100).toFixed(1);
  console.log(outputName + ': ' + translated + '/' + packet.entries.length + ' (' + coverage + '%)'
    + ' missing=' + missing.length + ' extra=' + extra.length
    + ' slots=' + badSlots.length + ' cjk=' + chinese.length
    + ' spaces=' + badSpaces.length + ' emoji=' + badEmoji.length);
  for (const item of missing.slice(0, 5)) console.log('   missing: ' + JSON.stringify(item));
  for (const item of extra.slice(0, 5)) console.log('   extra  : ' + JSON.stringify(item));
  for (const item of badSlots.slice(0, 5)) console.log('   slots  : ' + item);
  for (const item of badSpaces.slice(0, 5)) console.log('   spaces : ' + item);
  for (const item of badEmoji.slice(0, 5)) console.log('   emoji  : ' + item);
  for (const item of chinese.slice(0, 5)) console.log('   cjk    : ' + item);
  if (missing.length || extra.length || badSlots.length || chinese.length || badSpaces.length) failed = true;
}
process.exitCode = failed ? 1 : 0;
