#!/usr/bin/env node

/**
 * Syntax-check every module this bundle ships, plus the canonical shared modules
 * in the sibling `memory-plugin-shared/lib`.
 *
 * The bundle ships two copies of the same shared code on purpose: `shared/` is
 * generated from `../memory-plugin-shared/lib` (see scripts/sync-shared.mjs) so
 * that a packed tarball and a `path:` install carry it. This check parses both —
 * the copies because they are what runs, the originals because a syntax error
 * there is what the next sync would vendor in.
 *
 * Node's own `--check` parses without executing, so this needs no dependencies
 * and stays cross-platform — the shell `for` loop it replaces only ran on POSIX.
 */

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED_SOURCE_DIR = join(PLUGIN_DIR, "..", "memory-plugin-shared", "lib");

function collect(dir) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // A directory install that never carried the sibling is still diagnosable:
    // the drift check in sync-shared.mjs reports what is missing.
    return files;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collect(path));
    else if (entry.name.endsWith(".mjs")) files.push(path);
  }
  return files;
}

let checked = 0;
for (const file of [...collect(PLUGIN_DIR), ...collect(SHARED_SOURCE_DIR)]) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
  checked += 1;
}
process.stdout.write(`checked ${checked} modules\n`);
