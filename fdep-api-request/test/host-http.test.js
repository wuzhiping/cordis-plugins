'use strict';

// HTTP-level integration test for the arm route, host side.
//
// This is NOT a mock either: it mounts the REAL @deepseek-ai/dsh-host-webserver
// (on a loopback port), the REAL dsh-system-prompt, the REAL dsh-tools registry
// and our plugin, then POSTs the arm route over real HTTP and reads the real
// assembly. It is the only test that proves the route is reachable at all — the
// matching layer dispatches registered exact routes before the /plugins
// fallback, which is exactly what makes the client's POST work in the GUI.
//
// Run: node test/host-http.test.js        (port 41337, or set DSH_TEST_PORT)
// Exit 2 when the DSH tree or a free port is unavailable (nothing to test).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DSH_ROOT = process.env.DSH_TREE
  || 'D:/Refine/Books/ntop/AI/node/global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const NEEDED = {
  cordis: path.join(DSH_ROOT, 'cordis'),
  systemPrompt: path.join(DSH_ROOT, 'dsh-system-prompt'),
  tools: path.join(DSH_ROOT, 'dsh-tools'),
  webServer: path.join(DSH_ROOT, 'dsh-host-webserver'),
};
for (const [name, dir] of Object.entries(NEEDED)) {
  if (!fs.existsSync(dir)) {
    console.error('SKIP: real DSH package "' + name + '" not found at ' + dir);
    process.exit(2);
  }
}

const { Context } = require(NEEDED.cordis);
const systemPromptMod = require(NEEDED.systemPrompt);
const toolsMod = require(NEEDED.tools);
const webServerMod = require(NEEDED.webServer);
const plugin = require(path.join(__dirname, '..', 'lib', 'index.js'));

const PORT = Number(process.env.DSH_TEST_PORT || 41337);

async function main() {
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

  const ctx = new Context();
  await ctx.plugin(systemPromptMod.default, {});
  await ctx.plugin(toolsMod.default, {});
  try {
    await ctx.plugin(webServerMod.default, {
      host: '127.0.0.1',
      port: PORT,
      compression: 'none',
    });
  } catch (err) {
    // A busy port is an environment problem, not a plugin problem.
    console.error('SKIP: could not listen on 127.0.0.1:' + PORT + ' (' + (err && err.message) + ')');
    console.error('      set DSH_TEST_PORT to a free port and re-run.');
    await ctx.fiber.dispose().catch(() => {});
    process.exit(2);
  }
  await ctx.plugin(plugin, {});

  // Provided AFTER the plugin mounted, on purpose: the plugin resolves both of
  // these optional services lazily, so they may appear at any time.
  const created = {};
  ctx.provide('sessions', {
    get(id) {
      return created[id] === undefined ? undefined : { header: { createdAt: created[id] } };
    },
  });

  const url = 'http://127.0.0.1:' + PORT + '/plugins/fdep-api-request/context';
  const post = (body, method) => fetch(url, {
    method: method || 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  console.log('=== arm route over real HTTP (' + url + ') ===');
  const armedAt = Date.now();
  // The multi-api form: one scenario spans several apis, and they arm together.
  const body = {
    apis: [
      {
        apiId: 'twseMops.todayMaterial',
        raw: { desc: '當日重大訊息', an_code: 'M26', watchlist: ['1402', '4904'] },
        inbound: { an_code: 'M26' },
      },
      {
        apiId: 'twseMops.companyProfile',
        raw: { desc: '公司基本資料', stockNo: '2330' },
        inbound: { stockNo: '2330' },
      },
    ],
  };
  const res = await post(body);
  const reply = await res.json();
  check('POST answers 200 and arms the whole set', () => {
    assert.equal(res.status, 200);
    assert.equal(reply.armed, true);
    assert.deepEqual(reply.api_ids, ['twseMops.todayMaterial', 'twseMops.companyProfile']);
    assert.ok(reply.chars > 0, 'no context text was rendered');
  });

  const wrongMethod = await post({}, 'PUT');
  check('a non-POST is refused (405), so a stray request cannot arm anything', () => {
    assert.equal(wrongMethod.status, 405);
  });

  const disarm = await (await post({ apis: [] })).json();
  check('an arm without docs disarms instead of keeping an old brief', () => {
    assert.equal(disarm.armed, false);
  });
  await post(body);

  console.log('\n=== the real assembler carries it, once, for the right session ===');
  // The real assembly context is `{ agent, scope: agent, signal? }` and `agent.id`
  // is the session id (Agent.id is a SessionId), so id stubs stand in for the
  // session the panel opened and for another one that is also assembling.
  const asSession = (id) => ({ agent: { id: id }, scope: { id: id } });
  const sessionAfter = asSession('session-after');
  const sessionBefore = asSession('session-before');
  const systemPrompt = ctx.get('systemPrompt');

  const after = await systemPrompt.assemble(sessionAfter);
  const mine = after.contexts.filter((c) => c.name === 'fdep-api-request/docs');
  check('the session assembled first after the arm gets exactly one context with every api', () => {
    assert.equal(mine.length, 1, 'saw: ' + after.contexts.map((c) => c.name).join(','));
    assert.match(mine[0].text, /2 個 FDEP api/);
    assert.match(mine[0].text, /api: twseMops\.todayMaterial/);
    assert.match(mine[0].text, /api: twseMops\.companyProfile/);
    assert.match(mine[0].text, /desc: 公司基本資料/);
    assert.match(mine[0].text, /watchlist: array<string>/);
    assert.match(mine[0].text, /stockNo: string/);
  });

  const before = await systemPrompt.assemble(sessionBefore);
  check('another session gets nothing', () => {
    const leaked = before.contexts.filter((c) => c.name === 'fdep-api-request/docs' && c.text !== '');
    assert.equal(leaked.length, 0, 'leaked: ' + JSON.stringify(leaked));
  });

  const again = await systemPrompt.assemble(sessionAfter);
  check('later steps of that session keep it', () => {
    const kept = again.contexts.filter((c) => c.name === 'fdep-api-request/docs' && c.text !== '');
    assert.equal(kept.length, 1);
  });

  console.log('\nAll ' + pass + ' HTTP-level checks passed.');

  await ctx.fiber.dispose();
}

main().then(
  () => {
    process.exitCode = 0;
  },
  (err) => {
    console.error('\nHTTP-LEVEL TEST FAILED');
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
    process.exit(1);
  },
);
