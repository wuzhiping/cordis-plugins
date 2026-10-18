#!/usr/bin/env node
'use strict';
// Harvest the English + Simplified Chinese locale dictionaries that the DSH web
// client ships, straight out of the browser bundles the running GUI serves.
//
//   node tools/harvest.js                 # summary + corpus.json / corpus.txt
//   node tools/harvest.js --gui URL       # another GUI origin (default http://127.0.0.1:3080)
//   node tools/harvest.js --out DIR       # write corpus.json + strings.json there
//
// Source of truth: the module group list in the served index.html. Every entry
// ending in /client.js is resolved to its package directory through the profile
// (profile-installed bundles win over the dsh installation), then the
// `locale.register(<ns>, { zh: <zhVar>, en: <enVar> })` calls are parsed.
//
// The bundles are unminified and their dictionaries are plain JSON-compatible
// object literals, so the parser is a small brace matcher, not a JS AST. It
// reports per-bundle failures instead of guessing.

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const GUI = process.env.DSH_DEV_BASE || 'http://127.0.0.1:3080';
const here = __dirname;
const bundleRoot = path.resolve(here, '..');
const dshHome = process.env.DSH_HOME || path.resolve(bundleRoot, '..', '..', '..', 'dsh');
const profileDir = process.env.DSH_PROFILE_DIR || path.resolve(dshHome, 'profiles', 'web');

// Node module roots a served client module can live in. The portable install
// keeps bundled dsh packages under <global>/@deepseek-ai/dsh/node_modules/
// @deepseek-ai; profile-installed bundles sit in the profile's node_modules.
function nodeModuleRoots() {
  const roots = [path.join(profileDir, 'node_modules')];
  const exec = path.dirname(process.execPath);
  const candidates = [
    path.join(exec, '..', 'global', 'node_modules'),
    path.join(exec, '..', '..', 'global', 'node_modules'),
    path.join(dshHome, 'node_modules'),
    path.join(dshHome, '..', 'node', 'global', 'node_modules'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      roots.push(candidate);
      const nested = path.join(candidate, '@deepseek-ai', 'dsh', 'node_modules');
      if (fs.existsSync(nested)) roots.push(nested);
    }
  }
  return [...new Set(roots)];
}

const MODULE_ROOTS = nodeModuleRoots();

const argv = process.argv.slice(2);
const gui = argv.indexOf('--gui') !== -1 ? argv[argv.indexOf('--gui') + 1] : GUI;
const outDir = argv.indexOf('--out') !== -1 ? path.resolve(argv[argv.indexOf('--out') + 1]) : bundleRoot;

// ---------- module discovery ----------
async function moduleSpecifiers() {
  const response = await fetch(gui + '/');
  if (!response.ok) throw new Error('GET ' + gui + '/ -> HTTP ' + response.status);
  const html = await response.text();
  const specs = [];
  const re = /plugins\/\?\?([^"]+)/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    for (let spec of match[1].split(',')) {
      spec = spec.trim().split('&')[0].replace(/\/client\.js$/, '');
      if (spec !== '') specs.push(spec);
    }
  }
  return [...new Set(specs)];
}

function packageDir(specifier) {
  // 1. Ask Node, anchored at the profile (works for profile-installed bundles
  //    that expose ./package.json).
  const requireFromProfile = createRequire(path.join(profileDir, 'package.json'));
  try {
    return path.dirname(requireFromProfile.resolve(specifier + '/package.json'));
  } catch (error) { /* fall through */ }
  // 2. Probe the module roots directly — bundled dsh packages resolve under the
  //    nested @deepseek-ai/dsh/node_modules root, where Node's require from the
  //    profile cannot see them.
  for (const root of MODULE_ROOTS) {
    const direct = path.join(root, ...specifier.split('/'));
    if (fs.existsSync(path.join(direct, 'package.json'))) return direct;
    const nested = path.join(root, '@deepseek-ai', 'dsh', 'node_modules', ...specifier.split('/'));
    if (fs.existsSync(path.join(nested, 'package.json'))) return nested;
  }
  return null;
}

// A bundle may ship its browser entry as lib/client.js (the dsh convention) or
// client.js next to package.json (community bundles).
function clientEntry(dir) {
  for (const candidate of [path.join(dir, 'lib', 'client.js'), path.join(dir, 'client.js')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// ---------- literal helpers ----------
// Return the index just past the JSON-ish object literal starting at `open`.
function matchBrace(text, open) {
  const stack = [];
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = true; quote = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') stack.push(ch);
    else if (ch === '}' || ch === ']' || ch === ')') {
      const expected = ch === '}' ? '{' : ch === ']' ? '[' : '(';
      if (stack.pop() !== expected) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

// Parse a single-quoted or double-quoted JS string literal into its value.
function parseStringLiteral(literal) {
  const trimmed = literal.trim();
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed[trimmed.length - 1] !== quote) return undefined;
  const body = trimmed.slice(1, -1);
  if (quote === '"') {
    try { return JSON.parse('"' + body + '"'); } catch (error) { return undefined; }
  }
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = body[i + 1];
    i += 1;
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === 'r') out += '\r';
    else if (next === 'u') { out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16)); i += 4; }
    else out += next;
  }
  return out;
}

// Split a top-level object body into `key: value` string entries. The bundles
// differ: dsh packages quote every key; community bundles use bare keys. Object
// shorthand (`{ zh, en }`) resolves to the constant of that name.
function parseFlatStringObject(text, body) {
  const dict = {};
  for (const field of splitArgs(body)) {
    if (field.trim() === '') continue;
    let depth = 0;
    let inString = false;
    let quote = '';
    let escaped = false;
    let colon = -1;
    for (let i = 0; i < field.length; i += 1) {
      const ch = field[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) inString = false;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inString = true; quote = ch; continue; }
      if (ch === '{' || ch === '[' || ch === '(') depth += 1;
      else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
      else if (ch === ':' && depth === 0) { colon = i; break; }
    }
    if (colon === -1) {
      const name = field.trim();
      if (name.startsWith('...')) {
        const spread = resolveObjectConst(text, name.slice(3).trim());
        if (spread.value !== undefined) Object.assign(dict, spread.value);
        continue;
      }
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      const resolved = resolveObjectConst(text, name);
      if (resolved.value !== undefined) dict[name] = resolved.value;
      continue;
    }
    let key = field.slice(0, colon).trim();
    const keyQuoted = /^(["'])([\s\S]*)\1$/.exec(key);
    if (keyQuoted) key = keyQuoted[2];
    const valueText = field.slice(colon + 1);
    const literalValue = parseStringLiteral(valueText);
    if (literalValue !== undefined) { dict[key] = literalValue; continue; }
    const identifier = valueText.trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(identifier)) continue;
    const resolvedValue = resolveArg(text, identifier);
    if (resolvedValue !== null && resolvedValue !== undefined) dict[key] = resolvedValue;
  }
  return dict;
}

// Brace-match an object literal that is a flat map of string values.
function parseObjectLiteral(text, start) {
  while (start < text.length && /\s/.test(text[start])) start += 1;
  if (text[start] !== '{') return { error: 'not an object literal at ' + start };
  const end = matchBrace(text, start);
  if (end === -1) return { error: 'unbalanced object literal at ' + start };
  return { value: parseFlatStringObject(text, text.slice(start + 1, end - 1)) };
}

// Resolve `const <name> = { ... }` (last definition wins; bundles use unique
// scope-suffixed names such as zh$6).
function resolveObjectConst(text, name) {
  const re = new RegExp('(?:const|let|var)\\s+' + name.replace(/\$/g, '\\$') + '\\s*=\\s*\\{', 'g');
  let last = null;
  let match;
  while ((match = re.exec(text)) !== null) last = match;
  if (last === null) return { error: 'const ' + name + ' = { not found' };
  return parseObjectLiteral(text, last.index + last[0].length - 1);
}

// Resolve a string constant: `const <name> = "ns"`.
function resolveStringConst(text, name) {
  const re = new RegExp('(?:const|let|var)\\s+' + name.replace(/\$/g, '\\$') + '\\s*=\\s*(["\'])([^"\']*)\\1', 'g');
  let last = null;
  let match;
  while ((match = re.exec(text)) !== null) last = match;
  return last === null ? null : last[2];
}

function splitArgs(args) {
  const parts = [];
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  let start = 0;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = true; quote = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) { parts.push(args.slice(start, i)); start = i + 1; }
  }
  parts.push(args.slice(start));
  return parts;
}

function resolveArg(text, arg) {
  const trimmed = arg.trim();
  const quoted = /^(["'])([\s\S]*)\1$/.exec(trimmed);
  if (quoted) return quoted[2].replace(/\\"/g, '"').replace(/\\'/g, "'");
  const ident = /^[A-Za-z_$][\w$]*$/.exec(trimmed);
  if (!ident) return null;
  const stringValue = resolveStringConst(text, trimmed);
  if (stringValue !== null) return stringValue;
  const obj = resolveObjectConst(text, trimmed);
  return obj.error === undefined ? obj.value : null;
}

// Extract every `locale.register(...)` call from one bundle.
function parseBundle(text) {
  const registrations = [];
  const failures = [];
  const needle = 'locale.register(';
  let index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) {
    const open = index + needle.length - 1;
    const close = matchBrace(text, open);
    if (close === -1) { failures.push({ at: index, error: 'unbalanced register call' }); index += needle.length; continue; }
    const args = splitArgs(text.slice(open + 1, close - 1));
    const ns = resolveArg(text, args[0] || '');
    if (typeof ns !== 'string') { failures.push({ at: index, error: 'unresolved namespace: ' + (args[0] || '').trim().slice(0, 60) }); index = close; continue; }
    // Two shapes are supported by the runtime:
    //   register(ns, { zh, en })          -- both shipped dictionaries at once
    //   register(ns, 'en', dict)         -- one external/shipped language at a time
    let registration = null;
    if (args.length >= 3) {
      const locale = resolveArg(text, args[1] || '');
      const dict = resolveObjectArg(text, args[2] || '');
      if (typeof locale === 'string' && dict !== null) {
        registration = { namespace: ns, dicts: { [locale]: dict } };
      }
    }
    if (registration === null) {
      const dicts = resolveObjectArg(text, args[1] || '');
      if (dicts !== null) registration = { namespace: ns, dicts };
    }
    if (registration === null) {
      failures.push({ at: index, error: 'unresolved dictionaries for ns ' + ns });
      index = close;
      continue;
    }
    registrations.push({ namespace: ns, ...registration.dicts });
    index = close;
  }
  return { registrations, failures };
}

// Resolve an argument that must be a dictionary object: either a literal or a
// constant defined in the bundle.
function resolveObjectArg(text, arg) {
  const trimmed = (arg || '').trim();
  if (trimmed.startsWith('{')) {
    const literal = parseObjectLiteral(text, text.indexOf(trimmed));
    return literal.value !== undefined ? literal.value : null;
  }
  const resolved = resolveArg(text, trimmed);
  return resolved && typeof resolved === 'object' ? resolved : null;
}



// ---------- corpus assembly ----------
function main() {
  return moduleSpecifiers().then((specs) => {
    const namespaces = new Map();
    const bundleRows = [];
    const failures = [];
    for (const spec of specs) {
      const dir = packageDir(spec);
      if (dir === null) { failures.push({ bundle: spec, error: 'package not resolvable from ' + profileDir }); continue; }
      const file = clientEntry(dir);
      if (file === null) { failures.push({ bundle: spec, error: 'no client.js in ' + dir }); continue; }
      const text = fs.readFileSync(file, 'utf8');
      const parsed = parseBundle(text);
      for (const failure of parsed.failures) failures.push({ bundle: spec, ...failure });
      for (const registration of parsed.registrations) {
        const entry = namespaces.get(registration.namespace) || {
          namespace: registration.namespace, bundles: [], zh: {}, en: {}, conflicts: []
        };
        if (!entry.bundles.includes(spec)) entry.bundles.push(spec);
        for (const [locale, dict] of Object.entries(registration)) {
          if (locale === 'namespace' || !dict || typeof dict !== 'object') continue;
          if (!['zh', 'en'].includes(locale)) continue;
          for (const [key, value] of Object.entries(dict)) {
            if (typeof value !== 'string') continue;
            const previous = entry[locale][key];
            if (previous !== undefined && previous !== value) {
              entry.conflicts.push({ locale, key, kept: previous, dropped: value });
              continue;
            }
            entry[locale][key] = value;
          }
        }
        namespaces.set(registration.namespace, entry);
      }
      bundleRows.push({ bundle: spec, registrations: parsed.registrations.length });
    }

    const sorted = [...namespaces.values()].sort((a, b) => a.namespace.localeCompare(b.namespace));
    const corpus = {
      source: gui,
      profileDir,
      bundles: specs.length,
      namespaces: Object.fromEntries(sorted.map((n) => [n.namespace, { bundles: n.bundles, en: n.en, zh: n.zh }])),
      conflicts: sorted.flatMap((n) => n.conflicts.map((c) => ({ namespace: n.namespace, ...c }))),
      failures,
    };

    // Flat string list for translation: unique English text with the key set
    // that produces it, plus its Chinese counterpart when available.
    const byEnglish = new Map();
    for (const n of sorted) {
      const keys = Object.keys(n.en);
      for (const key of keys) {
        const en = n.en[key];
        if (typeof en !== 'string' || en.trim() === '') continue;
        const entry = byEnglish.get(en) || { en, zh: n.zh[key] !== undefined ? [n.zh[key]] : [], usages: [] };
        if (n.zh[key] !== undefined && !entry.zh.includes(n.zh[key])) entry.zh.push(n.zh[key]);
        entry.usages.push(n.namespace + ':' + key);
        byEnglish.set(en, entry);
      }
    }
    const strings = [...byEnglish.values()]
      .sort((a, b) => a.en.localeCompare(b.en))
      .map((entry) => ({ en: entry.en, zh: entry.zh[0] !== undefined ? entry.zh[0] : null, usages: entry.usages }));

    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'corpus.json'), JSON.stringify(corpus, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(outDir, 'strings.json'), JSON.stringify(strings, null, 2) + '\n', 'utf8');

    // Coverage summary.
    let keys = 0;
    let chars = 0;
    for (const n of sorted) { const list = Object.keys(n.en); keys += list.length; for (const k of list) chars += String(n.en[k] || '').length; }
    console.log('bundles          : ' + specs.length + ' (' + bundleRows.filter((b) => b.registrations > 0).length + ' with dictionaries)');
    console.log('namespaces       : ' + sorted.length);
    console.log('en keys          : ' + keys + ' / unique English strings ' + strings.length);
    console.log('source characters: ' + chars + ' (+ ' + strings.length + ' unique)');
    console.log('conflicts        : ' + corpus.conflicts.length);
    console.log('parse failures   : ' + failures.length);
    for (const failure of failures.slice(0, 20)) console.log('  ! ' + failure.bundle + ' — ' + failure.error);
    console.log('wrote            : ' + path.join(outDir, 'corpus.json') + ', ' + path.join(outDir, 'strings.json'));
    const top = sorted.map((n) => [n.namespace, Object.keys(n.en).length]).sort((a, b) => b[1] - a[1]).slice(0, 12);
    console.log('largest          : ' + top.map(([ns, count]) => ns + '(' + count + ')').join(', '));
  });
}

module.exports = { parseBundle, parseObjectLiteral, resolveObjectConst, splitArgs, matchBrace };

if (require.main === module) {
  main().catch((error) => {
    console.error('HARVEST FAILED: ' + (error && error.message ? error.message : error));
    process.exitCode = 1;
  });
}
