import assert from "node:assert/strict";
import test from "node:test";

import { checkSharedCopies, sharedClosure } from "./scripts/sync-shared.mjs";

// `shared/` is a generated copy of ../memory-plugin-shared/lib, committed
// because a packed tarball and a `github:...#path:/ov-memory` install carry only
// this directory. Nothing at runtime notices a stale copy — the bundle just runs
// last week's shared code — so these two tests are the only thing keeping the
// two trees honest.

test("the committed shared/ copies match the canonical module closure", async () => {
  const problems = await checkSharedCopies();

  assert.deepEqual(
    problems,
    [],
    `shared/ is out of sync with memory-plugin-shared/lib; run: node scripts/sync-shared.mjs`,
  );
});

test("the closure resolves shared imports from any depth, not just ./shared/", async () => {
  const files = await sharedClosure();

  assert.deepEqual(files, [...files].sort());
  // servers/mcp-proxy.mjs reaches the same directory as `../shared/...`. A seed
  // scan that only understood `./shared/` would drop these two modules and still
  // report the copies as consistent.
  for (const name of ["debug-log.mjs", "mcp-proxy-core.mjs"]) {
    assert.ok(files.includes(name), name);
  }
});
