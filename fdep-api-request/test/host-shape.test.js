'use strict';

// Pins the host-plugin SHAPE contract for a DSH profile bundle.
//
// Two of these outcomes are silent: a factory-form plugin and a plugin that
// skips `inject` produce no error, they simply never register anything. That
// makes them the most expensive kind of mistake to diagnose, so the trap is
// asserted here rather than left to a future reader to rediscover.
//
// Run: node test/host-shape.test.js

const assert = require('node:assert/strict');
const path = require('node:path');

const D = 'D:/Refine/Books/ntop/AI/node/global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const fs = require('node:fs');
for (const p of ['cordis', 'dsh-tools', 'dsh-system-prompt']) {
  if (!fs.existsSync(path.join(D, p))) {
    console.error('SKIP: real DSH packages not found at ' + path.join(D, p));
    process.exit(2);
  }
}

const { Context } = require(path.join(D, 'cordis'));
const toolsMod = require(path.join(D, 'dsh-tools'));
const systemPromptMod = require(path.join(D, 'dsh-system-prompt'));

const DEF = {
  name: 'shape_probe_tool',
  description: 'shape probe',
  parameters: {
    type: 'object',
    properties: { a: { type: 'string' } },
    required: ['a'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: () => [{ type: 'text', text: 'ok' }],
  },
  async execute() { return { ok: true }; },
};

let pass = 0;
function check(label, fn) {
  try {
    fn();
    pass += 1;
    console.log('  [ok]   ' + label);
  } catch (err) {
    console.log('  [FAIL] ' + label + ' :: ' + err.message);
    throw err;
  }
}

// Mount `pluginValue` into a fresh real service graph and report what happened.
async function mount(pluginValue) {
  const ctx = new Context();
  await ctx.plugin(systemPromptMod.default, {});
  await ctx.plugin(toolsMod.default, {});
  const tools = ctx.get('tools');
  let threw = null;
  try {
    await ctx.plugin(pluginValue, {});
  } catch (err) {
    threw = err;
  }
  return { threw, count: tools.schemas().length };
}

async function main() {
  console.log('=== correct shape mounts ===');
  const good = await mount({
    name: 'my-bundle',
    inject: ['tools'],
    apply(ctx) { ctx.tools.register(DEF); },
  });
  check('module.exports = {name, inject, apply} registers its tool', () => {
    assert.equal(good.threw, null, 'mount threw: ' + (good.threw && good.threw.message));
    assert.equal(good.count, 1);
  });

  console.log('\n=== trap 1: the factory form fails SILENTLY ===');
  const factory = await mount(function plugin() {
    return {
      name: 'my-bundle',
      inject: ['tools'],
      apply(ctx) { ctx.tools.register(DEF); },
    };
  });
  check('factory form throws nothing (which is why it is dangerous)', () => {
    assert.equal(factory.threw, null, 'expected a silent failure, got: ' + (factory.threw && factory.threw.message));
  });
  check('factory form registers nothing', () => {
    assert.equal(factory.count, 0, 'factory form unexpectedly registered a tool');
  });

  console.log('\n=== trap 2: using a service without declaring inject throws ===');
  const noInject = await mount({
    name: 'my-bundle',
    apply(ctx) { ctx.tools.register(DEF); },
  });
  check('undeclared service access is refused with a named error', () => {
    assert.ok(noInject.threw, 'expected a throw, mount succeeded silently');
    assert.match(noInject.threw.message, /without inject/);
  });
  check('nothing was registered', () => {
    assert.equal(noInject.count, 0);
  });

  console.log('\n=== optional services are read with ctx.get(), not inject ===');
  const optional = await mount({
    name: 'my-bundle',
    inject: ['tools'],
    apply(ctx) {
      // A missing optional service reads as undefined and MUST NOT throw.
      const missing = ctx.get('definitely-not-a-service');
      if (missing !== undefined) throw new Error('expected undefined');
      ctx.tools.register(DEF);
    },
  });
  check('ctx.get() on a missing service returns undefined and mount proceeds', () => {
    assert.equal(optional.threw, null, 'mount threw: ' + (optional.threw && optional.threw.message));
    assert.equal(optional.count, 1);
  });

  console.log('\nAll ' + pass + ' host-shape checks passed.');
}

main().catch((err) => {
  console.error('\nHOST SHAPE TEST FAILED');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
