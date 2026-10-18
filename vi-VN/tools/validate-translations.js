#!/usr/bin/env node
'use strict';
// Validate the translated packets without building anything.
//
//   node tools/validate-translations.js
//
// Reports per-packet coverage, missing/extra keys, placeholder mismatches,
// Chinese characters left in a translation, whitespace drift, and non-symbol
// entries whose Vietnamese is identical to the English source (those are the
// ones worth a second look). Exit code 1 on hard failures.

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const translationsDir = path.join(root, 'translations');
const placeholderRe = /\{(\w+)\}/g;
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const symbolOnly = /^[^\p{L}\p{N}]+$/u;

function placeholders(text) {
  const names = [];
  let match;
  while ((match = placeholderRe.exec(text)) !== null) names.push(match[1]);
  return names.sort();
}

let failed = false;
const packets = fs.readdirSync(translationsDir).filter((name) => /^chunk-\d+\.json$/.test(name)).sort();
for (const packetName of packets) {
  const id = packetName.match(/\d+/)[0];
  const packet = JSON.parse(fs.readFileSync(path.join(translationsDir, packetName), 'utf8'));
  const outputName = 'vi-' + id + '.json';
  const outputPath = path.join(translationsDir, outputName);
  if (!fs.existsSync(outputPath)) {
    console.log(outputName + ': MISSING');
    failed = true;
    continue;
  }
  let output;
  try {
    output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  } catch (error) {
    console.log(outputName + ': invalid JSON — ' + error.message);
    failed = true;
    continue;
  }
  const input = new Map(packet.entries.map((entry) => [entry.en, entry]));
  const missing = [];
  const extra = [];
  const badPlaceholders = [];
  const badWhitespace = [];
  const chinese = [];
  const identities = [];
  for (const en of input.keys()) {
    if (!(en in output)) missing.push(en);
  }
  for (const [en, vi] of Object.entries(output)) {
    if (!input.has(en)) { extra.push(en); continue; }
    if (typeof vi !== 'string') { badPlaceholders.push(en + ' → non-string'); continue; }
    if (placeholders(en).join(',') !== placeholders(vi).join(',')) badPlaceholders.push(JSON.stringify({ en, vi }));
    if (CJK.test(vi)) chinese.push(JSON.stringify({ en, vi }));
    if (en !== en.trim() && vi !== vi.trim()) { /* fine, both padded */ }
    if ((en.startsWith(' ') !== vi.startsWith(' ')) || (en.endsWith(' ') !== vi.endsWith(' '))) badWhitespace.push(JSON.stringify({ en, vi }));
    if (vi === en && !symbolOnly.test(en)) identities.push(en);
  }
  const translated = Object.keys(output).length;
  const coverage = ((translated / packet.entries.length) * 100).toFixed(1);
  console.log(outputName + ': ' + translated + '/' + packet.entries.length + ' (' + coverage + '%)'
    + ' missing=' + missing.length + ' extra=' + extra.length
    + ' placeholder=' + badPlaceholders.length + ' cjk=' + chinese.length
    + ' whitespace=' + badWhitespace.length + ' identical=' + identities.length);
  for (const item of missing.slice(0, 5)) console.log('   missing: ' + JSON.stringify(item));
  for (const item of extra.slice(0, 5)) console.log('   extra  : ' + JSON.stringify(item));
  for (const item of badPlaceholders.slice(0, 5)) console.log('   placeholder: ' + item);
  for (const item of badWhitespace.slice(0, 5)) console.log('   whitespace : ' + item);
  for (const item of chinese.slice(0, 5)) console.log('   chinese    : ' + item);
  for (const item of identities.slice(0, 8)) console.log('   identical  : ' + JSON.stringify(item));
  if (missing.length || extra.length || badPlaceholders.length || chinese.length || badWhitespace.length) failed = true;
}

process.exitCode = failed ? 1 : 0;
