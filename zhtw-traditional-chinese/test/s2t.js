'use strict';
// Shared reader for the S→T tables that live inside lib/client.js.
//
// The tables are the bundle's single source of truth (no build step, no JSON
// import), so the audit tools parse them back out of the shipped file instead of
// keeping a second copy that could drift.

const fs = require('node:fs');
const path = require('node:path');

const CLIENT = path.join(__dirname, '..', 'lib', 'client.js');

/** The two tables as they ship. */
function readTables(file) {
  const src = fs.readFileSync(file || CLIENT, 'utf8');
  const phrasesSrc = src.match(/var S2T_PHRASES = (\[[\s\S]*?\n {4}\]);/);
  const charsSrc = src.match(/var S2T_CHARS = (\{[\s\S]*?\n {4}\});/);
  if (!phrasesSrc) throw new Error('S2T_PHRASES not found in ' + (file || CLIENT));
  if (!charsSrc) throw new Error('S2T_CHARS not found in ' + (file || CLIENT));
  return {
    phrases: JSON.parse(phrasesSrc[1]),
    chars: JSON.parse(charsSrc[1]),
  };
}

/**
 * The bundle's algorithm, mirrored exactly so the tools never disagree with the
 * shipped code: one left-to-right pass; at each position the longest matching
 * phrase wins (the table is generated longest-source-first, and the bundle
 * buckets phrases by their first character), otherwise the single-character map.
 * @returns {(text: string) => string}
 */
function makeConverter(tables) {
  const byFirst = new Map();
  for (const pair of tables.phrases) {
    const first = pair[0].charAt(0);
    if (!byFirst.has(first)) byFirst.set(first, []);
    byFirst.get(first).push(pair);
  }
  return function convert(text) {
    if (typeof text !== 'string' || text === '') return text;
    let out = '';
    let i = 0;
    while (i < text.length) {
      const bucket = byFirst.get(text.charAt(i));
      let hit = null;
      if (bucket !== undefined) {
        for (const pair of bucket) {
          if (text.substr(i, pair[0].length) === pair[0]) { hit = pair; break; }
        }
      }
      if (hit !== null) {
        out += hit[1];
        i += hit[0].length;
        continue;
      }
      const ch = text.charAt(i);
      out += tables.chars[ch] !== undefined ? tables.chars[ch] : ch;
      i += 1;
    }
    return out;
  };
}

const CJK = /[\u4e00-\u9fff]/;

module.exports = { CLIENT, readTables, makeConverter, CJK };
