#!/usr/bin/env node

/**
 * Vendor the shared runtime modules into `./shared`, from the canonical copy in
 * `../memory-plugin-shared/lib`, and report the copies when they have drifted.
 *
 * Why copies exist at all: this bundle has to install two ways. A checkout
 * (`link:` or `file:`) can reach the sibling directory, but a packed tarball and
 * a `github:<owner>/<repo>#path:/ov-memory` install materialize only this package
 * directory — Node never sees `../memory-plugin-shared` from there. So the
 * modules the bundle imports are copied in and committed, which is what upstream's
 * `examples/memory-plugin-shared/sync.mjs` does for the harnesses that install
 * from a directory.
 *
 * `memory-plugin-shared/lib` stays the only source of truth: edit it, never the
 * copies. The copied set is the transitive closure of what this bundle imports,
 * so a new shared import pulls its own modules in rather than silently missing
 * from the tarball.
 *
 *   node scripts/sync-shared.mjs           regenerate ./shared
 *   node scripts/sync-shared.mjs --check   exit 1 when ./shared has drifted
 */

import { realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = join(PLUGIN_DIR, "..", "memory-plugin-shared", "lib");
const TARGET_DIR = join(PLUGIN_DIR, "shared");
const SOURCE_LABEL = "memory-plugin-shared/lib";
const SKIPPED_DIRS = new Set(["node_modules", ".git", "shared"]);

const STATIC_IMPORT_RE = /(?:^|[\s;(=])(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const SIDE_EFFECT_IMPORT_RE = /(?:^|[\s;])import\s*["']([^"']+)["']/g;

/** Every module specifier a source file names, in any of the three forms. */
export function importSpecifiers(source) {
  const found = [];
  for (const re of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE, SIDE_EFFECT_IMPORT_RE]) {
    for (const match of source.matchAll(re)) found.push(match[1]);
  }
  return found;
}

/** The bundle's own modules: everything it ships except the vendored copies. */
async function pluginSources(dir = PLUGIN_DIR, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      await pluginSources(path, out);
      continue;
    }
    if (entry.name.endsWith(".mjs")) out.push(path);
  }
  return out;
}

async function readSource(name) {
  try {
    return await readFile(join(SOURCE_DIR, name), "utf8");
  } catch {
    return null;
  }
}

/** The shared modules this bundle imports, then the closure of those. */
export async function sharedClosure() {
  const seeds = new Set();
  const missing = [];
  for (const file of await pluginSources()) {
    for (const spec of importSpecifiers(await readFile(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      // Resolve rather than match a literal prefix: `servers/mcp-proxy.mjs`
      // reaches the same directory as `../shared/...`, and a prefix test that
      // only knows `./shared/` silently drops the modules that file imports.
      const resolved = resolvePath(dirname(file), spec);
      if (!resolved.startsWith(TARGET_DIR + sep)) continue;
      const name = resolved.slice(TARGET_DIR.length + 1);
      seeds.add(name);
      if (await readSource(name) === null) {
        missing.push(`${name} (imported by ${relative(PLUGIN_DIR, file)})`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `${SOURCE_LABEL} does not hold every module this bundle imports: ${missing.join(", ")}`,
    );
  }

  const closure = new Set();
  const pending = [...seeds];
  while (pending.length > 0) {
    const name = pending.pop();
    if (closure.has(name)) continue;
    const source = await readSource(name);
    if (source === null) continue;
    closure.add(name);
    for (const spec of importSpecifiers(source)) {
      if (spec.startsWith("./")) pending.push(spec.slice(2));
    }
  }
  return [...closure].sort();
}

/**
 * A generated copy, byte for byte. The header follows the body's line endings so
 * the file does not mix two conventions on its first line.
 */
export function render(name, body) {
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  return `// GENERATED FROM ${SOURCE_LABEL}. DO NOT EDIT.${eol}${body}`;
}

async function targetNames() {
  try {
    return (await readdir(TARGET_DIR)).filter(name => name.endsWith(".mjs")).sort();
  } catch {
    return [];
  }
}

/**
 * Every way the committed copies disagree with the closure: changed, missing, or
 * left over from an import that no longer exists. Returns an empty array when
 * `shared/` is exactly what the generator would write.
 */
export async function checkSharedCopies() {
  const files = await sharedClosure();
  const problems = [];
  for (const name of files) {
    const body = await readSource(name);
    const actual = await readFile(join(TARGET_DIR, name), "utf8").catch(() => null);
    if (actual === null) problems.push(`missing: shared/${name}`);
    else if (actual !== render(name, body)) problems.push(`out of date: shared/${name}`);
  }
  for (const name of await targetNames()) {
    if (!files.includes(name)) problems.push(`stale: shared/${name} is not imported by anything`);
  }
  return problems;
}

async function writeCopies(files) {
  await mkdir(TARGET_DIR, { recursive: true });
  for (const name of files) {
    const target = join(TARGET_DIR, name);
    // Through a rename so a reader never sees half a module.
    const staging = `${target}.${process.pid}.tmp`;
    await writeFile(staging, render(name, await readSource(name)), "utf8");
    await rename(staging, target);
    process.stdout.write(`synced ${name} -> shared/\n`);
  }
  for (const name of await targetNames()) {
    if (files.includes(name)) continue;
    await rm(join(TARGET_DIR, name));
    process.stdout.write(`removed stale shared/${name}\n`);
  }
}

async function main() {
  if (process.argv.includes("--check")) {
    const problems = await checkSharedCopies();
    if (problems.length > 0) {
      process.stderr.write(
        `shared/ is out of sync with ${SOURCE_LABEL}:\n  ${problems.join("\n  ")}\n`
        + "run: node scripts/sync-shared.mjs\n",
      );
      process.exit(1);
    }
    process.stdout.write(`shared/ matches ${SOURCE_LABEL}\n`);
    return;
  }
  await writeCopies(await sharedClosure());
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isDirectRun()) {
  main().catch(error => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exit(1);
  });
}
