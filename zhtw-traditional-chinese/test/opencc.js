'use strict';
// Reader for the OpenCC reference dictionaries (Apache-2.0).
//
// They are *inputs* to the table generator and the completeness check, never
// shipped: the bundle carries only the corpus-filtered result. Fetch them with
//
//   curl -o %TEMP%/zhtw-opencc/STCharacters.txt https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/STCharacters.txt
//
// (and STPhrases.txt, TWPhrases.txt, TWVariants.txt).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Where the .txt files are looked for unless --opencc says otherwise. */
function defaultOpenCCDir() {
  return process.env.ZHTW_OPENCC || path.join(os.tmpdir(), 'zhtw-opencc');
}

/**
 * Parse an OpenCC dictionary file: `源\t標 標2` -> Map(源 -> 標), i.e. the first
 * listed value, which OpenCC documents as the preferred reading.
 * @param file - absolute path to the .txt file.
 * @returns the mapping (empty when the file is missing).
 */
function readOpenCC(file) {
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (line === '' || line.charCodeAt(0) === 35) continue;   // '#'
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const key = line.slice(0, tab).trim();
    const rest = line.slice(tab + 1).trim();
    if (key === '' || rest === '') continue;
    const first = rest.split(' ')[0].trim();
    if (first !== '') map.set(key, first);
  }
  return map;
}

module.exports = { defaultOpenCCDir, readOpenCC };
