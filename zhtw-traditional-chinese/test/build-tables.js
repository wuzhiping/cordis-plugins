#!/usr/bin/env node
'use strict';
// Regenerate the S→T tables in lib/client.js.
//
//   node test/build-tables.js                 # write lib/client.js
//   node test/build-tables.js --dry           # show what would change
//   node test/build-tables.js --opencc <dir>  # where the OpenCC .txt files are
//
// Why a generator instead of hand-editing: the previous tables were hand-written
// and covered 317 characters, so every Simplified character outside that set
// reached the UI unchanged ("收合侧边欄", "檢視選项", "搜尋工作階段名称"). The
// mapping itself is not something to invent — OpenCC's dictionaries are the
// reference (Apache-2.0). What ships here is *not* OpenCC wholesale: it is OpenCC
// filtered down to the corpus DSH actually renders (its web client bundles), so
// the bundle stays small and every entry is justified by a string in the product.
//
// The pipeline mirrors OpenCC's `s2twp` config:
//   characters : STCharacters (preferred reading) composed with TWVariants
//   phrases    : curated (kept verbatim) > TWPhrases > STPhrases
//
// A phrase is only kept when it teaches something the character map cannot —
// i.e. when it disagrees with what the characters alone would produce. That
// prunes the ~100k-entry mechanical phrase table down to the Taiwan-idiom and
// ambiguity cases that DSH's corpus actually needs.
//
// Inputs are never written: only lib/client.js is.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readTables, CLIENT } = require('./s2t');
const { collectCorpus, corpusChars } = require('./corpus');
const { readOpenCC, defaultOpenCCDir } = require('./opencc');

const args = process.argv.slice(2);
const DRY = args.indexOf('--dry') !== -1;
const openccArg = args.indexOf('--opencc') !== -1 ? args[args.indexOf('--opencc') + 1] : null;
const OPENCC = openccArg || defaultOpenCCDir();

const CJK = /[\u4e00-\u9fff]/;

/**
 * Idiom corrections applied first, before the curated table and before OpenCC.
 *
 * These are places where the mechanical/Taiwan dictionary reads wrong in DSH's
 * context (OpenCC turns 全局 into 全域性, which is not how a panel title reads) or
 * where zh-TW says something the mechanical table misses entirely.
 * @type {Array<[string, string]>}
 */
const OVERRIDES = [
  ['全局', '全域'],          // OpenCC: 全域性 — wrong register for a panel name
  ['连接', '連線'],          // network connection, not "link together"
  ['快捷键', '快速鍵'],      // zh-TW: 快速鍵 (not 快捷鍵)
  ['快捷方式', '捷徑'],      // zh-TW: 捷徑
  ['剪贴板', '剪貼簿'],      // zh-TW: 剪貼簿
  ['正则', '正規'],          // zh-TW: 正規表示式, not 正則表達式
  ['表达式', '表示式'],      // zh-TW idiom in math/CS writing
  ['正则表达式', '正規表示式'],
];

function main() {
  // The hand-curated half lives in test/curated-tables.json, NOT in the current
  // bundle: the bundle already contains generated entries, and feeding those back
  // in would make the generator self-reinforcing (a chained phrase would look
  // hand-picked forever).
  const tables = JSON.parse(fs.readFileSync(path.join(__dirname, 'curated-tables.json'), 'utf8'));
  const shipped = readTables();
  const corpus = collectCorpus();
  const charCounts = corpusChars(corpus.strings);
  const corpusText = corpus.strings.join('\n');

  const stChars = readOpenCC(path.join(OPENCC, 'STCharacters.txt'));
  const twVariants = readOpenCC(path.join(OPENCC, 'TWVariants.txt'));
  const twPhrases = readOpenCC(path.join(OPENCC, 'TWPhrases.txt'));
  const stPhrases = readOpenCC(path.join(OPENCC, 'STPhrases.txt'));
  console.log('corpus       : ' + corpus.strings.length + ' strings from ' + corpus.perFile.size + ' bundles ('
    + charCounts.size + ' distinct characters)');
  console.log('opencc       : STCharacters ' + stChars.size + ', TWVariants ' + twVariants.size
    + ', TWPhrases ' + twPhrases.size + ', STPhrases ' + stPhrases.size);

  // ---- 1. characters -------------------------------------------------------
  // The FULL OpenCC character table, not just the corpus: a character map is
  // cheap (one hash lookup per character, a table that compresses well) and it is
  // what makes the conversion robust — a DSH upgrade that introduces a string with
  // a character this corpus never had still renders in Traditional. The phrase
  // table is the expensive one, and that one *is* corpus-filtered.
  const chars = Object.assign({}, tables.chars);
  const addedChars = [];
  const charKeys = Array.from(stChars.keys())
    .filter((ch) => chars[ch] === undefined)
    .sort((a, b) => (charCounts.get(b) || 0) - (charCounts.get(a) || 0) || a.localeCompare(b));
  for (const ch of charKeys) {
    const st = stChars.get(ch);
    if (st === undefined) continue;
    const value = twVariants.get(st) || st;
    if (value === ch) continue;                 // already Traditional here
    if (!CJK.test(ch) || !CJK.test(value)) continue;
    chars[ch] = value;
    if (charCounts.has(ch)) addedChars.push([ch, value, charCounts.get(ch)]);
  }
  const compose = (text) => {
    let out = '';
    for (const ch of text) out += chars[ch] !== undefined ? chars[ch] : ch;
    return out;
  };

  // ---- 2. phrases ----------------------------------------------------------
  const phrases = [];
  const seen = new Set();
  const kept = { override: 0, curated: 0, tw: 0, st: 0, chained: 0 };
  const push = (from, to, why) => {
    if (from.length < 2 || seen.has(from)) return;
    if (!CJK.test(from) || !CJK.test(to)) return;
    seen.add(from);
    phrases.push([from, to]);
    kept[why] += 1;
  };
  for (const [from, to] of OVERRIDES) push(from, to, 'override');
  for (const [from, to] of tables.phrases) push(from, to, 'curated');   // hand-picked, kept as-is
  const consider = (map, why) => {
    for (const [from, to] of map) {
      if (seen.has(from)) continue;
      if (from.length < 2) continue;
      if (corpusText.indexOf(from) === -1) continue;   // DSH never renders it
      if (to === compose(from)) continue;              // the character map already says this
      push(from, to, why);
    }
  };
  consider(twPhrases, 'tw');
  consider(stPhrases, 'st');
  // Longest source first: the converter applies every matching phrase in order,
  // so a long phrase must not be pre-empted by a short one inside it.
  phrases.sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]));

  console.log('characters   : ' + Object.keys(tables.chars).length + ' curated -> ' + Object.keys(chars).length
    + '  (+' + addedChars.length + ' used by the corpus)');
  console.log('phrases      : ' + tables.phrases.length + ' curated + generated -> ' + phrases.length
    + '  (override ' + kept.override + ', curated ' + kept.curated + ', tw ' + kept.tw + ', st ' + kept.st
    + '; skipped ' + kept.chained + ' already-Traditional sources)');
  console.log('new chars    : ' + addedChars.slice(0, 40).map(([s, t]) => s + '→' + t).join(' '));
  console.log('new phrases  : ' + phrases.filter((p) => tables.phrases.every((q) => q[0] !== p[0]))
    .slice(0, 25).map((p) => p[0] + '→' + p[1]).join(' '));

  if (DRY) {
    console.log('');
    console.log('dry run: lib/client.js untouched.');
    return;
  }

  // ---- 3. emit -------------------------------------------------------------
  const eol = fs.readFileSync(CLIENT, 'utf8').indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  const phraseLines = [];
  for (let i = 0; i < phrases.length; i += 4) {
    const chunk = phrases.slice(i, i + 4).map(([from, to]) => '["' + from + '","' + to + '"]');
    phraseLines.push('      ' + chunk.join(', ') + (i + 4 < phrases.length ? ',' : ''));
  }
  const charEntries = Object.keys(chars).map((from) => '"' + from + '":"' + chars[from] + '"');
  const charLines = [];
  for (let i = 0; i < charEntries.length; i += 8) {
    const chunk = charEntries.slice(i, i + 8);
    charLines.push('      ' + chunk.join(',') + (i + 8 < charEntries.length ? ',' : ''));
  }

  const src = fs.readFileSync(CLIENT, 'utf8');
  // Replace by index rather than by two sequential `replace()` calls: both
  // literals are found once, and the pieces between them are copied verbatim.
  const phrasesMatch = /var S2T_PHRASES = \[[\s\S]*?\n {4}\];/.exec(src);
  const charsMatch = /var S2T_CHARS = \{[\s\S]*?\n {4}\};/.exec(src);
  if (!phrasesMatch) throw new Error('S2T_PHRASES literal not found in ' + CLIENT);
  if (!charsMatch) throw new Error('S2T_CHARS literal not found in ' + CLIENT);
  if (charsMatch.index < phrasesMatch.index) throw new Error('unexpected table order in ' + CLIENT);
  const newPhrases = 'var S2T_PHRASES = [' + eol + phraseLines.join(eol) + eol + '    ];';
  const newChars = 'var S2T_CHARS = {' + eol + charLines.join(eol) + eol + '    };';
  const withChars = src.slice(0, phrasesMatch.index)
    + newPhrases
    + src.slice(phrasesMatch.index + phrasesMatch[0].length, charsMatch.index)
    + newChars
    + src.slice(charsMatch.index + charsMatch[0].length);
  fs.writeFileSync(CLIENT, withChars, 'utf8');
  console.log('');
  console.log('wrote ' + CLIENT + '  (' + Buffer.byteLength(withChars, 'utf8') + ' bytes, '
    + (withChars.length - src.length) + ' chars larger)');
}

main();
