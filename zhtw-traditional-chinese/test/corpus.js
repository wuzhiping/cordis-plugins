'use strict';
// The corpus this bundle has to convert: every Chinese string DSH ships in its
// web client bundles, i.e. everything the GUI can render.
//
// Only `lib/client*.js` is scanned. Host-side bundles never reach the browser, so
// their Chinese log messages must not influence the tables.
//
// One filter matters a lot: a few bundles embed huge data blobs (code-language
// tables, preview assets) whose string literals are kilometres long and span the
// whole CJK block. They are not UI copy, and letting them in makes every count
// meaningless — so literals are capped at MAX_LEN characters and must look like
// prose (no base64-ish noise, at least a quarter CJK).

const fs = require('node:fs');
const path = require('node:path');

const MAX_LEN = 80;
const CJK = /[\u4e00-\u9fff]/;

/** Where the DSH packages live on this machine (first existing root wins). */
function defaultDshRoots() {
  const candidates = [
    'D:\\Refine\\Books\\ntop\\AI\\node\\global\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai',
    'D:\\Refine\\Books\\ntop\\AI\\dsh\\node_modules\\@deepseek-ai',
  ];
  return candidates.filter((root) => fs.existsSync(root));
}

function looksLikeProse(text) {
  if (text.length > MAX_LEN) return false;
  if (/[A-Za-z0-9+/]{40,}/.test(text)) return false;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  return cjk > 0 && cjk / text.length >= 0.25;
}

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
    } else {
      visit(full, entry.name);
    }
  }
}

/**
 * Collect the corpus.
 * @param roots - package roots to scan (defaults to the local DSH install).
 * @returns {{strings: string[], perFile: Map<string, number>}}
 */
function collectCorpus(roots) {
  const rootsToUse = roots && roots.length ? roots : defaultDshRoots();
  const strings = new Set();
  const perFile = new Map();
  const isClientBundle = (name) => /^client.*\.js$/.test(name);
  for (const root of rootsToUse) {
    walkFiles(root, (full, name) => {
      if (!isClientBundle(name)) return;
      if (full.indexOf(`${path.sep}lib${path.sep}`) === -1) return;
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch (_) {
        return;
      }
      if (!CJK.test(text)) return;
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

/** The set of Chinese characters the corpus uses, with usage counts. */
function corpusChars(strings) {
  const chars = new Map();
  for (const text of strings) {
    for (const ch of text) {
      if (!CJK.test(ch)) continue;
      chars.set(ch, (chars.get(ch) || 0) + 1);
    }
  }
  return chars;
}

module.exports = { MAX_LEN, CJK, defaultDshRoots, looksLikeProse, walkFiles, collectCorpus, corpusChars };
