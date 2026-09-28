/**
 * Offline checks for aife-provider: no Host, no Loader, no profile.
 *
 * The ownership mechanism lives in `cordis.patch.yml`, so these checks read that
 * file and assert the composition the Models page needs, plus the shape of the
 * marker the Host half logs from. Run with `node check.mjs` from this directory.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EXPECTED_PROFILE, MANAGED_PROVIDER, inject, name } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * js-yaml ships with the harness rather than this bundle, so resolve it from
 * the DSH home that runs the bundle. `DSH_HOME` wins; otherwise walk up from
 * this file looking for a `profiles/<name>/node_modules`, which is where a
 * profile-installed bundle lives.
 */
function loadYaml() {
  const anchors = [];
  if (process.env.DSH_HOME) {
    anchors.push(join(process.env.DSH_HOME, 'profiles', 'web', 'package.json'));
  }
  for (let dir = here; ; dir = dirname(dir)) {
    anchors.push(join(dir, 'package.json'));
    if (dirname(dir) === dir) break;
  }
  for (const anchor of anchors) {
    if (!existsSync(anchor)) continue;
    try {
      return createRequire(anchor)('js-yaml');
    } catch {
      /* try the next anchor */
    }
  }
  throw new Error('check.mjs: cannot resolve js-yaml; set DSH_HOME to the running DSH home');
}

const yaml = loadYaml();
const patch = yaml.load(readFileSync(join(here, 'cordis.patch.yml'), 'utf8'));

let passed = 0;
const ok = (label, run) => {
  run();
  passed += 1;
  console.log(`ok   ${label}`);
};

const rows = Array.isArray(patch) ? patch : [];
const inserted = rows.flatMap((row) => (Array.isArray(row?.insert) ? row.insert : []));
const section = rows.find((row) => row?.id === 'llm-pi-ai' && row.insert === undefined);

ok('exports the plugin identity', () => {
  assert.equal(name, 'aife-provider');
  assert.deepEqual(inject, ['settings']);
});

ok('the patch inserts exactly the plugin row', () => {
  assert.deepEqual(inserted, [{ id: 'aife-provider', name: '@local/aife-provider' }]);
});

ok('the patch targets the pi-ai section as a bundle layer', () => {
  assert.notEqual(section, undefined, 'cordis.patch.yml must configure llm-pi-ai');
  assert.equal(section.name, undefined, 'a bundle config layer asserts no name');
});

ok('the patch supplies the owned route with every asserted field', () => {
  const profile = section.config?.providers?.[MANAGED_PROVIDER];
  assert.notEqual(profile, undefined, `llm-pi-ai.providers.${MANAGED_PROVIDER} must be present`);
  for (const [field, expected] of Object.entries(EXPECTED_PROFILE)) {
    assert.equal(profile[field], expected, `providers.${MANAGED_PROVIDER}.${field}`);
  }
});

ok('the patch supplies exactly the MiniMax-M3 model', () => {
  const models = section.config.providers[MANAGED_PROVIDER].models;
  assert.ok(Array.isArray(models) && models.length > 0, 'models must be a non-empty array');
  for (const model of models) assert.equal(typeof model?.id, 'string');
  assert.deepEqual(models.map((model) => model.id), ['MiniMax-M3']);
});

ok('the API key stays a reference, never a value', () => {
  const profile = section.config.providers[MANAGED_PROVIDER];
  assert.equal(profile.apiKeyEnv, 'AIFE_API_KEY');
  for (const value of Object.values(profile)) {
    assert.ok(
      typeof value !== 'string' || !/^sk-/.test(value),
      'no field may carry secret material',
    );
  }
});

ok('the owned route is the only one this layer writes', () => {
  assert.deepEqual(Object.keys(section.config.providers), [MANAGED_PROVIDER]);
});

console.log(`\n${passed} checks passed`);
