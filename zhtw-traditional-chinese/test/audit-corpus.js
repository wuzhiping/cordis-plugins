#!/usr/bin/env node
'use strict';
// Audit the S→T tables in lib/client.js against the *real* Chinese strings DSH
// ships in its web client bundles.
//
// Why this exists: the bundle converts the zh dictionary values through
// S2T_PHRASES + S2T_CHARS, so any Simplified character missing from those
// tables survives into the UI. This tool finds exactly which characters those
// are, with the strings that use them, instead of guessing.
//
//   node test/audit-corpus.js                 # summary + chars missing from the table
//   node test/audit-corpus.js --strings 40    # also list the 40 worst affected strings
//   node test/audit-corpus.js --dsh <dir>     # override where the DSH packages live
//
// It reads files only; nothing is written and no host is contacted.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readOpenCC, defaultOpenCCDir } = require('./opencc');

const HERE = __dirname;
const PLUGIN = path.join(HERE, '..');

function parseArgs(argv) {
  const out = { strings: 25, dsh: null, chars: true, min: 3, dump: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--strings') out.strings = Number(argv[i + 1]) || 25;
    else if (arg === '--dsh') out.dsh = argv[i + 1];
    else if (arg === '--no-chars') out.chars = false;
    else if (arg === '--min') out.min = Number(argv[i + 1]) || 1;
    else if (arg === '--dump') out.dump = argv[i + 1];
  }
  return out;
}

/** The tables, read straight out of the shipped bundle (single source of truth). */
function readTables() {
  const src = fs.readFileSync(path.join(PLUGIN, 'lib', 'client.js'), 'utf8');
  const phrasesSrc = src.match(/var S2T_PHRASES = (\[[\s\S]*?\n {4}\]);/);
  const charsSrc = src.match(/var S2T_CHARS = (\{[\s\S]*?\n {4}\});/);
  if (!phrasesSrc) throw new Error('S2T_PHRASES not found in lib/client.js');
  if (!charsSrc) throw new Error('S2T_CHARS not found in lib/client.js');
  const phrases = JSON.parse(phrasesSrc[1]);
  const chars = JSON.parse(charsSrc[1]);
  return { phrases, chars };
}

/** Same algorithm as the bundle: phrases first, then per-character. */
function makeConverter(tables) {
  const phraseKeys = tables.phrases.map((pair) => pair[0]);
  return function convert(text) {
    let out = text;
    for (const [from, to] of tables.phrases) {
      if (out.indexOf(from) !== -1) out = out.split(from).join(to);
    }
    let result = '';
    for (const ch of out) result += tables.chars[ch] !== undefined ? tables.chars[ch] : ch;
    return result;
  };
}

/** Every candidate DSH package root that could hold web client bundles. */
function defaultDshRoots() {
  const roots = [
    'D:\\Refine\\Books\\ntop\\AI\\node\\global\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai',
    'D:\\Refine\\Books\\ntop\\AI\\dsh\\node_modules\\@deepseek-ai',
  ];
  return roots.filter((root) => fs.existsSync(root));
}

/** Walk a directory and collect files matching a predicate. */
function walkFiles(dir, visit, depth) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if ((depth || 0) > 6) continue;
      if (entry.name === 'node_modules' || entry.name === 'libreoffice-kit-win32-x64' || entry.name === '.git') continue;
      walkFiles(full, visit, (depth || 0) + 1);
    } else if (visit(full, entry.name) === false) {
      return;
    }
  }
}

/**
 * Chinese string literals from the web-facing client bundles. Only `lib/client*`
 * is scanned: host-side bundles never reach the browser, so their Chinese log
 * messages must not influence the tables.
 *
 * One filter matters a lot: a few bundles embed huge data blobs (code-language
 * tables, preview assets) whose string literals are kilometres long and span the
 * whole CJK block. They are not UI copy, and letting them in makes every count
 * meaningless — so literals are capped at MAX_LEN characters and must look like
 * prose (no long runs of punctuation or base64-ish noise).
 */
const MAX_LEN = 80;

function looksLikeProse(text) {
  if (text.length > MAX_LEN) return false;
  if (/[A-Za-z0-9+/]{40,}/.test(text)) return false;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return cjk > 0 && cjk / text.length >= 0.25;
}

function collectCorpus(roots) {
  const strings = new Set();
  const perFile = new Map();
  const isClientBundle = (name) => /^client.*\.js$/.test(name);
  for (const root of roots) {
    walkFiles(root, (full, name) => {
      if (!isClientBundle(name)) return;
      if (full.indexOf(`${path.sep}lib${path.sep}`) === -1) return;
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch (_) {
        return;
      }
      if (!/[\u4e00-\u9fff]/.test(text)) return;
      // Double-quoted literals are how these bundles ship their dictionaries;
      // single-quoted literals are rare but cheap to include.
      const found = [];
      const re = /"((?:[^"\\\n]|\\.)*[\u4e00-\u9fff](?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*[\u4e00-\u9fff](?:[^'\\\n]|\\.)*)'/g;
      let match;
      while ((match = re.exec(text)) !== null) {
        const raw = match[1] !== undefined ? match[1] : match[2];
        if (raw === undefined) continue;
        if (/^[a-z0-9_.:-]+$/i.test(raw)) continue;
        if (!looksLikeProse(raw)) continue;
        found.push(raw);
        strings.add(raw);
      }
      if (found.length) perFile.set(full, found.length);
    }, 0);
  }
  return { strings: Array.from(strings), perFile };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const tables = readTables();
  const convert = makeConverter(tables);
  const roots = args.dsh ? [args.dsh] : defaultDshRoots();
  if (roots.length === 0) {
    console.error('No DSH package root found; pass --dsh <dir>.');
    process.exit(2);
  }

  const corpus = collectCorpus(roots);
  const chars = new Map();      // char -> {count, example}
  const missing = new Map();    // corpus char not in either table
  let clean = 0;
  const affected = [];

  for (const text of corpus.strings) {
    const converted = convert(text);
    const stillSimplified = [];
    for (const ch of text) {
      if (!/[\u4e00-\u9fff]/.test(ch)) continue;
      const seen = chars.get(ch) || { count: 0, example: text };
      seen.count += 1;
      chars.set(ch, seen);
      if (tables.chars[ch] === undefined) {
        const entry = missing.get(ch) || { count: 0, example: text };
        entry.count += 1;
        missing.set(ch, entry);
      }
    }
    // A string is "affected" when conversion left a character that the table
    // does not know at all AND that character is not the converted output.
    for (const ch of converted) {
      if (tables.chars[ch] === undefined && text.indexOf(ch) !== -1 && missing.has(ch)) {
        stillSimplified.push(ch);
      }
    }
    if (stillSimplified.length === 0) clean += 1;
    else affected.push({ text, converted, chars: Array.from(new Set(stillSimplified)) });
  }

  console.log('DSH client bundles scanned : ' + corpus.perFile.size + ' files with Chinese strings');
  console.log('unique Chinese strings     : ' + corpus.strings.length);
  console.log('table sizes                : ' + tables.phrases.length + ' phrases, '
    + Object.keys(tables.chars).length + ' single characters');
  console.log('strings fully converted    : ' + clean + ' / ' + corpus.strings.length);
  console.log('unique Chinese characters  : ' + chars.size + ' (of which not in the table: ' + missing.size + ')');
  const phraseKeys = tables.phrases.map((p) => p[0]).sort((a, b) => b.length - a.length);
  console.log('longest phrases            : ' + phraseKeys.slice(0, 5).map((k) => k).join(' / '));

  if (args.chars) {
    const rows = Array.from(missing.entries())
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));

    // The decisive split: a character OpenCC's own table would convert is a MISS
    // (this bundle should have mapped it); everything else is already Traditional
    // or has no Simplified counterpart, so leaving it alone is correct.
    let stillSimplified = [];
    let neutral = rows;
    const openccDir = args.opencc || defaultOpenCCDir();
    if (fs.existsSync(path.join(openccDir, 'STCharacters.txt'))) {
      const stChars = readOpenCC(path.join(openccDir, 'STCharacters.txt'));
      const twVariants = readOpenCC(path.join(openccDir, 'TWVariants.txt'));
      const isMiss = ([ch]) => {
        const st = stChars.get(ch);
        if (st === undefined) return false;
        return (twVariants.get(st) || st) !== ch;
      };
      stillSimplified = rows.filter(isMiss);
      neutral = rows.filter((row) => !isMiss(row));
    } else {
      console.log('(OpenCC data not found at ' + openccDir + ' — pass --opencc for the decisive split)');
    }

    console.log('');
    console.log('=== STILL SIMPLIFIED (OpenCC would convert these: real misses) ===');
    if (stillSimplified.length === 0) console.log('  (none)');
    for (const [ch, info] of stillSimplified) {
      console.log('  ' + ch + ' (' + info.count + ')  e.g. ' + info.example.slice(0, 48));
    }

    console.log('');
    console.log('=== already Traditional / no Simplified counterpart (' + neutral.length + ') ===');
    const width = 62;
    let line = '';
    for (const [ch, info] of neutral) {
      const cell = ch + ':' + info.count + ' ';
      if ((line + cell).length > width) {
        console.log('  ' + line.trimEnd());
        line = '';
      }
      line += cell;
    }
    if (line.trim() !== '') console.log('  ' + line.trimEnd());

    if (args.dump) {
      const lines = ['# character\tcount\texample string'];
      for (const [ch, info] of rows) {
        lines.push(ch + '\t' + info.count + '\t' + info.example);
      }
      fs.writeFileSync(args.dump, lines.join('\n') + '\n', 'utf8');
      console.log('');
      console.log('dumped ' + rows.length + ' characters to ' + args.dump);
    }
  }

  if (args.strings > 0 && affected.length) {
    affected.sort((a, b) => b.chars.length - a.chars.length);
    console.log('');
    console.log('=== worst affected strings (converted form still holds unknown characters) ===');
    for (const row of affected.slice(0, args.strings)) {
      console.log('  [' + row.chars.join('') + '] ' + row.text.slice(0, 70)
        + (row.text === row.converted ? '' : '   ->   ' + row.converted.slice(0, 70)));
    }
  }
}

main();
