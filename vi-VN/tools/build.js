#!/usr/bin/env node
'use strict';
// Build lib/client.js: inline the harvested corpus + translations into the
// plugin source and verify the result before writing it.
//
//   node tools/build.js            # validate + write lib/client.js
//   node tools/build.js --dry      # validate + report, write nothing
//
// Inputs
//   corpus.json                     harvested namespaces (en + zh), from tools/harvest.js
//   translations/vi-NN.json         { "<exact English string>": "<Vietnamese>" }
//   src/client.js                   plugin source with __VI_DICTS__ / __VI_BY_EN__ markers
//
// Output
//   lib/client.js                   self-contained browser bundle
//
// Hard failures (exit 1): missing bundle input, a key with an unmatched
// placeholder, Chinese characters inside a translation. Missing translations are
// only reported: those keys fall back to English at runtime.

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dry = process.argv.includes('--dry');

function fail(message) {
  console.error('BUILD FAILED: ' + message);
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(file + ': ' + error.message);
  }
}

// ---------- inputs ----------
const corpus = readJson(path.join(root, 'corpus.json'));
const translationsDir = path.join(root, 'translations');
const translationFiles = fs.readdirSync(translationsDir)
  .filter((name) => /^vi-\d+\.json$/.test(name))
  .sort();
if (translationFiles.length === 0) fail('no translations/vi-*.json files; run the translation tasks first');

const translations = new Map();
for (const name of translationFiles) {
  const data = readJson(path.join(translationsDir, name));
  if (data === null || typeof data !== 'object' || Array.isArray(data)) fail(name + ': expected a flat JSON object');
  for (const [en, vi] of Object.entries(data)) {
    if (typeof vi !== 'string') fail(name + ': value for ' + JSON.stringify(en) + ' is not a string');
    if (translations.has(en) && translations.get(en) !== vi) {
      fail('conflicting translations for ' + JSON.stringify(en) + ' (' + name + ')');
    }
    translations.set(en, vi);
  }
}

// ---------- checks ----------
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const placeholderRe = /\{(\w+)\}/g;
function placeholders(text) {
  const names = [];
  let match;
  while ((match = placeholderRe.exec(text)) !== null) names.push(match[1]);
  return names.sort();
}

const symbolOnly = /^[^\p{L}\p{N}]+$/u;
const problems = [];
const identities = [];
const chinese = [];
let translatedKeys = 0;
let fallbackKeys = 0;
const namespaces = {};

for (const [namespace, entry] of Object.entries(corpus.namespaces)) {
  const dict = {};
  for (const [key, en] of Object.entries(entry.en)) {
    if (typeof en !== 'string' || en.trim() === '') continue;
    const vi = translations.get(en);
    if (vi === undefined) { fallbackKeys += 1; continue; }
    const enPlaceholders = placeholders(en);
    const viPlaceholders = placeholders(vi);
    if (enPlaceholders.join(',') !== viPlaceholders.join(',')) {
      problems.push(namespace + ':' + key + ' — placeholders ' + JSON.stringify(enPlaceholders) + ' → ' + JSON.stringify(viPlaceholders) + ' in ' + JSON.stringify({ en, vi }));
      continue;
    }
    if (CJK.test(vi)) { chinese.push(namespace + ':' + key + ' — ' + JSON.stringify(vi)); continue; }
    if (vi === en && !symbolOnly.test(en)) identities.push(namespace + ':' + key + ' — ' + JSON.stringify(en));
    dict[key] = vi;
    translatedKeys += 1;
  }
  namespaces[namespace] = dict;
}

for (const key of Object.keys(corpus.namespaces)) {
  if (namespaces[key] === undefined) namespaces[key] = {};
}

// Flat English → Vietnamese map for resolveText (package titles/descriptions).
const byEnglish = {};
for (const [namespace, dict] of Object.entries(namespaces)) {
  for (const [key, vi] of Object.entries(dict)) {
    const en = corpus.namespaces[namespace].en[key];
    if (en !== undefined && en !== vi) byEnglish[en] = vi;
  }
}

// ---------- custom-plugin surface dictionaries ----------
// Plugins installed in this deployment that hardcode Chinese instead of
// registering locale dictionaries. Their copy is translated at render time by
// the DOM layer in src/client.js (scoped to the plugin's own containers).
const SURFACE_PLUGINS = ['cute-clock', 'ntfy-teams', 'fdep-api-request-bundle', 'kaneo-web', 'dsh-minio-s3', 'dsh-file-share'];
const customHarvest = readJson(path.join(root, 'tools', 'custom-zh.json'));

const surfaceTranslations = new Map();
for (const name of fs.readdirSync(translationsDir).filter((entry) => /^custom-vi-\d+\.json$/.test(entry)).sort()) {
  const data = readJson(path.join(translationsDir, name));
  for (const [zh, vi] of Object.entries(data)) {
    if (typeof vi !== 'string') fail(name + ': value for ' + JSON.stringify(zh) + ' is not a string');
    if (surfaceTranslations.has(zh) && surfaceTranslations.get(zh) !== vi) fail('conflicting surface translations for ' + JSON.stringify(zh));
    surfaceTranslations.set(zh, vi);
  }
}
// Hand-curated follow-ups collected from the live surfaces (tools/surface-extra.json
// + translations/custom-vi-extra.json).
const surfaceExtraPath = path.join(root, 'tools', 'surface-extra.json');
if (fs.existsSync(surfaceExtraPath)) {
  const extraTranslations = readJson(path.join(translationsDir, 'custom-vi-extra.json'));
  for (const [zh, vi] of Object.entries(extraTranslations)) surfaceTranslations.set(zh, vi);
}

const surfaceEntries = new Map();
for (const plugin of SURFACE_PLUGINS) {
  const data = customHarvest[plugin];
  if (!data) continue;
  for (const [kind, list] of [['exact', data.strings], ['dynamic', data.dynamic]]) {
    for (const zh of list) {
      if (!surfaceEntries.has(zh)) surfaceEntries.set(zh, { kind, zh, plugins: [] });
      const entry = surfaceEntries.get(zh);
      if (!entry.plugins.includes(plugin)) entry.plugins.push(plugin);
    }
  }
}
for (const entry of surfaceEntries.values()) {
  if (entry.kind === 'dynamic') continue;
  const zh = entry.zh;
  if (/^\s/.test(zh) || /\s$/.test(zh) || /^[,，、。；;：:·—–-]/.test(zh) || /[,，、。；;：:·—–]$/.test(zh) || zh.length < 4) entry.kind = 'fragment';
}
if (fs.existsSync(surfaceExtraPath)) {
  for (const entry of readJson(surfaceExtraPath)) {
    if (typeof entry.zh !== 'string' || typeof entry.kind !== 'string') fail('tools/surface-extra.json: bad entry ' + JSON.stringify(entry));
    surfaceEntries.set(entry.zh, { kind: entry.kind, zh: entry.zh, plugins: ['manual'] });
  }
}

const SURFACE_EXACT = {};
const SURFACE_FRAGMENTS = [];
const SURFACE_PATTERNS = [];
const surfaceProblems = [];
let surfaceMissing = 0;
for (const entry of [...surfaceEntries.values()].sort((a, b) => b.zh.length - a.zh.length)) {
  const vi = surfaceTranslations.get(entry.zh);
  if (vi === undefined) { surfaceMissing += 1; continue; }
  if (CJK.test(vi)) { surfaceProblems.push('CJK left: ' + JSON.stringify({ zh: entry.zh, vi })); continue; }
  const zhSlots = placeholders(entry.zh).length;
  const viSlots = placeholders(vi).length;
  if (zhSlots !== viSlots) { surfaceProblems.push('placeholder count: ' + JSON.stringify({ zh: entry.zh, vi })); continue; }
  if (entry.kind === 'fragment') {
    if (/^\s/.test(entry.zh) !== /^\s/.test(vi) || /\s$/.test(entry.zh) !== /\s$/.test(vi)) {
      surfaceProblems.push('fragment whitespace: ' + JSON.stringify({ zh: entry.zh, vi }));
      continue;
    }
    SURFACE_FRAGMENTS.push([entry.zh, vi]);
  } else if (entry.kind === 'dynamic') {
    // Build an anchored pattern; {x} captures one interpolated value. Mark the
    // token before escaping so the escaped braces cannot hide it.
    const TOKEN = '\u0000';
    const marked = entry.zh.split('{x}').join(TOKEN);
    const escaped = marked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    SURFACE_PATTERNS.push(['^' + escaped.split(TOKEN).join('([\\s\\S]*?)') + '$', vi]);
  } else {
    SURFACE_EXACT[entry.zh] = vi;
    // Whole-node entries are also used as substring fallbacks (a label such as
    // "↻ 重新整理" embeds the entry "重新整理"); skip very short ones to avoid
    // replacing a character pair inside an unrelated sentence.
    if (entry.zh.replace(/[^\u3400-\u9fff]/g, "").length >= 3) SURFACE_FRAGMENTS.push([entry.zh, vi]);
  }
}

// ---------- report ----------
const totalKeys = Object.values(corpus.namespaces).reduce((sum, entry) => sum + Object.keys(entry.en).length, 0);
const coverage = ((translatedKeys / totalKeys) * 100).toFixed(1);
console.log('namespaces      : ' + Object.keys(namespaces).length);
console.log('corpus keys     : ' + totalKeys);
console.log('translated keys : ' + translatedKeys + ' (' + coverage + '%)');
console.log('fallback to en  : ' + fallbackKeys);
console.log('translation map : ' + translations.size + ' unique English strings');
console.log('identity keys   : ' + identities.length + ' (technical/symbol only — review if large)');
console.log('chinese left    : ' + chinese.length);
console.log('placeholder bad : ' + problems.length);
console.log('surface strings : ' + (surfaceEntries.size - surfaceMissing) + '/' + surfaceEntries.size
  + ' translated (' + SURFACE_FRAGMENTS.length + ' fragments, ' + SURFACE_PATTERNS.length + ' patterns)');

if (problems.length > 0) {
  for (const problem of problems.slice(0, 25)) console.error('  ! ' + problem);
  if (problems.length > 25) console.error('  … ' + (problems.length - 25) + ' more');
  fail(problems.length + ' placeholder mismatches');
}
if (chinese.length > 0) {
  for (const item of chinese.slice(0, 25)) console.error('  ! ' + item);
  fail(chinese.length + ' translations still contain Chinese characters');
}
if (surfaceProblems.length > 0) {
  for (const problem of surfaceProblems.slice(0, 25)) console.error('  ! surface ' + problem);
  fail(surfaceProblems.length + ' surface translation problems');
}
if (surfaceMissing > 0) console.log('  surface untranslated: ' + surfaceMissing + ' (English fallback does not apply to hardcoded Chinese; they stay Chinese)');
if (identities.length > 0) {
  console.log('  identity examples:');
  for (const item of identities.slice(0, 15)) console.log('    ' + item);
}
if (fallbackKeys > 0) {
  console.log('  untranslated examples:');
  const missing = [];
  for (const [namespace, entry] of Object.entries(corpus.namespaces)) {
    for (const [key, en] of Object.entries(entry.en)) {
      if (typeof en === 'string' && en.trim() !== '' && !translations.has(en)) missing.push(namespace + ':' + key + ' — ' + JSON.stringify(en));
    }
  }
  for (const item of missing.slice(0, 15)) console.log('    ' + item);
  if (missing.length > 15) console.log('    … ' + (missing.length - 15) + ' more');
}

// ---------- emit ----------
const template = fs.readFileSync(path.join(root, 'src', 'client.js'), 'utf8');
for (const marker of ['__VI_DICTS__', '__VI_BY_EN__', '__SURFACE_EXACT__', '__SURFACE_FRAGMENTS__', '__SURFACE_PATTERNS__']) {
  if (!template.includes(marker)) fail('src/client.js is missing the ' + marker + ' marker');
}
const bundle = template
  .replace('__VI_DICTS__', JSON.stringify(namespaces))
  .replace('__VI_BY_EN__', JSON.stringify(byEnglish))
  .replace('__SURFACE_EXACT__', JSON.stringify(SURFACE_EXACT))
  .replace('__SURFACE_FRAGMENTS__', JSON.stringify(SURFACE_FRAGMENTS))
  .replace('__SURFACE_PATTERNS__', JSON.stringify(SURFACE_PATTERNS));
const banner = '// GENERATED by tools/build.js — do not edit by hand.\n'
  + '// vi-VN locale bundle: ' + translatedKeys + '/' + totalKeys + ' keys translated ('
  + coverage + '%), fallback language: en; ' + (surfaceEntries.size - surfaceMissing) + '/' + surfaceEntries.size
  + ' hardcoded Chinese plugin strings translated (' + SURFACE_FRAGMENTS.length + ' fragments, ' + SURFACE_PATTERNS.length + ' patterns).\n';
const output = banner + bundle;

const target = path.join(root, 'lib', 'client.js');
if (dry) {
  console.log('dry run         : would write ' + target + ' (' + Buffer.byteLength(output) + ' bytes)');
  process.exit(0);
}
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, output, 'utf8');
console.log('wrote           : ' + target + ' (' + Buffer.byteLength(output) + ' bytes)');
