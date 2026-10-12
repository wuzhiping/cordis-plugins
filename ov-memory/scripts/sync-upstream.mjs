#!/usr/bin/env node

/**
 * Re-vendor this bundle from an OpenViking checkout.
 *
 * `ov-memory` is upstream's `examples/dsh-memory-plugin` (plus the shared runtime
 * modules from `examples/memory-plugin-shared/lib`) with a small, fixed set of
 * local changes. Doing that by hand once is what this directory is; doing it
 * again on every upstream release by hand is how a vendored copy rots. So the
 * local changes live here as an explicit, asserted transformation table, and
 * everything else is mirrored verbatim.
 *
 * The source checkout is read-only and never written to.
 *
 *   node scripts/sync-upstream.mjs                 # upgrade from ../../OpenViking
 *   node scripts/sync-upstream.mjs --from <path>   # upgrade from another checkout
 *   node scripts/sync-upstream.mjs --check         # report drift, write nothing
 *
 * What is *not* automated: `README.md`. Its local edits are prose spread across
 * five regions, so a mechanical replacement table for it would be brittle and
 * would fail on exactly the upstream release that rewrote the surrounding text.
 * The script leaves it alone and reports when upstream has changed it.
 *
 * Every replacement must match exactly once; a miss is an error, not a skip, so
 * an upstream reformatting stops the run instead of silently vendoring stale
 * localisations.
 */

import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = join(PLUGIN_DIR, "..");
const SHARED_DIR = join(REPO_DIR, "memory-plugin-shared", "lib");

const UPSTREAM_PLUGIN = join("examples", "dsh-memory-plugin");
const UPSTREAM_SHARED = join("examples", "memory-plugin-shared", "lib");

/** Files this bundle owns outright; upstream has no counterpart to mirror. */
const LOCAL_ONLY = new Set([
  ".gitignore",
  "HANDOFF.md",
  "scripts/check.mjs",
  "scripts/sync-shared.mjs",
  "scripts/sync-upstream.mjs",
  "stored-credentials.mjs",
  "stored-credentials.test.mjs",
  "sync-shared.test.mjs",
  "test-support.mjs",
]);

/**
 * Files that legitimately differ from upstream and are reconciled by hand.
 * Reported on every `--check`, and their upstream diff is printed on upgrade.
 *
 * `index.mjs` and the four apply-level test files joined this set when the
 * connection moved behind the BDD storage lookup: that is a structural fork, not
 * a rename or a line-ending tweak, so re-applying it as a text replacement would
 * be unreadable and would break on the first upstream reformat. Their upstream
 * versions still arrive in an upgrade — as "review by hand", which is the point.
 */
const LOCALIZED = new Set([
  "README.md",
  "index.mjs",
  "index.test.mjs",
  "mcp.test.mjs",
  "session-workspace.test.mjs",
  "skills.test.mjs",
]);

/** Directories that are generated or not ours to mirror. */
const SKIPPED_DIRS = new Set(["node_modules", "shared", ".git"]);

/**
 * The localisation, as exact LF-normalised replacements.
 *
 * Keyed by the plugin-relative path the replacement applies to. Each `from` must
 * occur exactly once in the freshly copied upstream file.
 */
const TRANSFORMS = {
  "package.json": [
    {
      from: `  "name": "@openviking/dsh-memory-plugin",`,
      to: `  "name": "ov-memory",`,
    },
    {
      from: `    "prepack": "node ../memory-plugin-shared/sync.mjs",
    "check": "for f in *.mjs shared/*.mjs; do node --check \\"$f\\" || exit 1; done && npm run check:version",`,
      to: `    "sync": "node scripts/sync-shared.mjs",
    "prepack": "node scripts/sync-shared.mjs",
    "check": "node scripts/check.mjs && node scripts/sync-shared.mjs --check && npm run check:version",`,
    },
    {
      from: `    "skills.mjs",
    "uri-guard.mjs",`,
      to: `    "skills.mjs",
    "stored-credentials.mjs",
    "uri-guard.mjs",`,
    },
    {
      from: `    "url": "git+https://github.com/volcengine/OpenViking.git",
    "directory": "examples/dsh-memory-plugin"`,
      to: `    "url": "git+https://github.com/wuzhiping/cordis-plugins",
    "directory": "ov-memory"`,
    },
  ],
  "cordis.patch.yml": [
    {
      from: `      name: '@openviking/dsh-memory-plugin'`,
      to: `      name: 'ov-memory'`,
    },
  ],
  // The lockfile names the package twice: once at the root and once for the
  // root package entry. Both move together.
  "package-lock.json": [
    { from: `"name": "@openviking/dsh-memory-plugin"`, to: `"name": "ov-memory"`, count: 2 },
  ],
  "bundle.test.mjs": [
    {
      from: `  assert.equal(manifest.name, "@openviking/dsh-memory-plugin");`,
      to: `  assert.equal(manifest.name, "ov-memory");`,
    },
    {
      from: `  assert.match(
    patch,
    /- id: openviking-memory-runtime\\n\\s+name: '@openviking\\/dsh-memory-plugin'/,
  );`,
      to: `  // \`\\r?\\n\`: this repo checks out with core.autocrlf=true, so the same committed
  // patch is CRLF in a Windows working tree and LF in the index and on CI.
  assert.match(
    patch,
    /- id: openviking-memory-runtime\\r?\\n\\s+name: 'ov-memory'/,
  );`,
    },
  ],
  "skills.test.mjs": [
    {
      from: `  assert.match(skill, /^---\\nname: openviking-memory\\n/);`,
      to: `  // \`\\r?\\n\`: the committed file is LF, but core.autocrlf=true hands a Windows
  // working tree CRLF, and this reads the working tree.
  assert.match(skill, /^---\\r?\\nname: openviking-memory\\r?\\n/);`,
    },
  ],
};

/** Read a file as LF-normalised text, remembering the line ending to restore. */
async function readNormalized(path) {
  const raw = await readFile(path, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  return { text: raw.replaceAll("\r\n", "\n"), eol };
}

function restoreEol(text, eol) {
  return eol === "\r\n" ? text.replaceAll("\n", "\r\n") : text;
}

/** Every file under `dir`, relative to it with `/` separators, skipping generated directories. */
async function filesUnder(dir, base = dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await filesUnder(path, base, out);
    // POSIX separators so the LOCAL_ONLY / LOCALIZED sets match on Windows too.
    else out.push(relative(base, path).split("\\").join("/"));
  }
  return out.sort();
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The upstream checkout to read, and a check that it looks like one. */
async function resolveUpstream(argv) {
  const at = argv.indexOf("--from");
  const root = at === -1 ? join(REPO_DIR, "..", "OpenViking") : argv[at + 1];
  if (!root) throw new Error("--from needs a path");
  for (const path of [
    join(root, UPSTREAM_PLUGIN, "package.json"),
    join(root, UPSTREAM_SHARED, "MANIFEST"),
  ]) {
    if (!(await exists(path))) throw new Error(`not an OpenViking checkout: missing ${path}`);
  }
  return root;
}

/** The plugin files the mirror owns: upstream's, minus the hand-held ones. */
async function pluginMirror(root) {
  const source = join(root, UPSTREAM_PLUGIN);
  const all = await filesUnder(source);
  return {
    copy: all.filter(name => !LOCALIZED.has(name)),
    localized: all.filter(name => LOCALIZED.has(name)),
  };
}

/** Apply this bundle's localisation to a freshly copied upstream file. */
export async function applyTransforms(target, name) {
  const rules = TRANSFORMS[name];
  if (!rules) return;
  const path = join(target, name);
  const { text, eol } = await readNormalized(path);
  let next = text;
  for (const { from, to, count = 1 } of rules) {
    const seen = next.split(from).length - 1;
    if (seen !== count) {
      throw new Error(
        `${name}: expected ${count} occurrence(s) of the localisation anchor, found ${seen}\n`
        + `  anchor: ${JSON.stringify(from.slice(0, 120))}\n`
        + "  upstream reformatted this file; update TRANSFORMS in scripts/sync-upstream.mjs",
      );
    }
    next = next.replaceAll(from, to);
  }
  await writeFile(path, restoreEol(next, eol), "utf8");
  process.stdout.write(`localised ${name}\n`);
}

/** Copy upstream plugin files over this bundle, then re-apply the localisation. */
async function syncPlugin(root) {
  const source = join(root, UPSTREAM_PLUGIN);
  const { copy, localized } = await pluginMirror(root);
  for (const name of copy) {
    const to = join(PLUGIN_DIR, name);
    await mkdir(dirname(to), { recursive: true });
    await cp(join(source, name), to);
    await applyTransforms(PLUGIN_DIR, name);
    if (!TRANSFORMS[name]) process.stdout.write(`synced ${name}\n`);
  }
  return localized;
}

/** Mirror the shared runtime modules; `sync-shared.mjs` vendors them after. */
async function syncShared(root) {
  const source = join(root, UPSTREAM_SHARED);
  for (const name of await filesUnder(source)) {
    const to = join(SHARED_DIR, name);
    await mkdir(dirname(to), { recursive: true });
    await cp(join(source, name), to);
    process.stdout.write(`synced memory-plugin-shared/lib/${name}\n`);
  }
}

/**
 * Drift between this bundle and "upstream plus the transformation table".
 *
 * Only the mirrored files can be compared: the localized ones differ by design,
 * and the local-only ones have nothing to compare against.
 */
export async function checkDrift(root) {
  const problems = [];
  const { copy, localized } = await pluginMirror(root);
  const expected = new Set(copy);

  for (const name of copy) {
    const upstream = await readNormalized(join(root, UPSTREAM_PLUGIN, name)).catch(() => null);
    if (upstream === null) continue;
    const { text: ours } = await readNormalized(join(PLUGIN_DIR, name)).catch(() => ({ text: null }));
    let want = upstream.text;
    for (const { from, to } of TRANSFORMS[name] ?? []) want = want.replaceAll(from, to);
    if (ours === null) problems.push(`missing here: ${name}`);
    else if (ours !== want) problems.push(`differs from upstream+localisation: ${name}`);
  }

  for (const name of await filesUnder(PLUGIN_DIR)) {
    if (expected.has(name) || LOCALIZED.has(name) || LOCAL_ONLY.has(name)) continue;
    problems.push(`only here, upstream has no ${name}: review whether upstream renamed or dropped it`);
  }

  for (const name of await filesUnder(SHARED_DIR)) {
    const upstream = await readNormalized(join(root, UPSTREAM_SHARED, name)).catch(() => null);
    if (upstream === null) continue;
    const { text: ours } = await readNormalized(join(SHARED_DIR, name)).catch(() => ({ text: null }));
    if (ours !== upstream.text) problems.push(`differs from upstream: memory-plugin-shared/lib/${name}`);
  }
  return problems;
}

async function main() {
  const root = await resolveUpstream(process.argv);

  if (process.argv.includes("--check")) {
    const problems = await checkDrift(root);
    if (problems.length > 0) {
      process.stderr.write(`drift from ${root}:\n  ${problems.join("\n  ")}\n`);
      process.exit(1);
    }
    const { localized } = await pluginMirror(root);
    process.stdout.write(
      `in sync with ${root}\n`
      + localized.map(name => `  not compared, held by hand: ${name}\n`).join(""),
    );
    return;
  }

  const localized = await syncPlugin(root);
  await syncShared(root);

  const vendored = spawnSync(process.execPath, [join(PLUGIN_DIR, "scripts", "sync-shared.mjs")], {
    stdio: "inherit",
  });
  if (vendored.status !== 0) process.exit(vendored.status ?? 1);

  process.stdout.write(
    `\nRe-vendored from ${root}\n`
    + localized.map(name => `  review by hand (localized): ${name}\n`).join("")
    + "Next: npm run check && npm test\n",
  );
}

const isDirectRun = process.argv[1]
  && process.argv[1].replaceAll("\\", "/").endsWith("/scripts/sync-upstream.mjs");

if (isDirectRun) {
  main().catch(error => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exit(1);
  });
}
