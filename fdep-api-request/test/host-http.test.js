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
const os = require('node:os');
const path = require('node:path');

const DSH_ROOT = process.env.DSH_TREE
  || 'D:/Refine/Books/ntop/AI/node/global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const NEEDED = {
  cordis: path.join(DSH_ROOT, 'cordis'),
  systemPrompt: path.join(DSH_ROOT, 'dsh-system-prompt'),
  tools: path.join(DSH_ROOT, 'dsh-tools'),
  webServer: path.join(DSH_ROOT, 'dsh-host-webserver'),
  executor: path.join(DSH_ROOT, 'dsh-tool-executor-native'),
};
for (const [name, dir] of Object.entries(NEEDED)) {
  if (!fs.existsSync(dir)) {
    console.error('SKIP: real DSH package "' + name + '" not found at ' + dir);
    process.exit(2);
  }
}

const { Context } = require(NEEDED.cordis);
const { pathToFileURL } = require('node:url');
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
  // dsh-tools 0.2.x selects a tool executor from the mounting scope; assemble()
  // throws without one. The harness composes the native executor by default.
  const executorMod = await import(pathToFileURL(path.join(NEEDED.executor, 'lib', 'index.js')).href);
  await ctx.plugin({ name: executorMod.name, inject: executorMod.inject, apply: executorMod.apply }, {});
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

  console.log('\n=== execute route: the key stays in the host ===');
  // The route is the panel's execute path. The gateway call itself is intercepted
  // (this test must not reach the real FDEP host), while the route is exercised
  // over real HTTP.
  const CALL_URL = 'http://127.0.0.1:' + PORT + '/plugins/fdep-api-request/call';
  const realFetch = globalThis.fetch;
  let gatewayBodies = [];
  const credsPath = path.join(os.tmpdir(), 'fdep-http-credentials-' + process.pid + '.yaml');
  fs.writeFileSync(credsPath, 'version: 1\nrefs:\n  AIFE_API_KEY: sk-ExampleKeyReplaceMe001\n', 'utf8');
  const savedCreds = process.env.DSH_CREDENTIALS_PATH;
  process.env.DSH_CREDENTIALS_PATH = credsPath;
  globalThis.fetch = async (target, init) => {
    if (String(target).startsWith('https://abc.feg.com.tw/')) {
      gatewayBodies.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        async text() { return JSON.stringify({ data: { echoed: 'ok' }, trace_id: 'trace-route' }); },
      };
    }
    return realFetch(target, init);
  };
  const postCall = (payload, method) => realFetch(CALL_URL, {
    method: method || 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  try {
    const ok = await (await postCall({ api: 'test.demo', do: true, inbound: { name: 'aaa' } })).json();
    check('execute route forwards the call and reports the key source', () => {
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.equal(ok.keyRef, 'AIFE_API_KEY');
      assert.equal(ok.body.trace_id, 'trace-route');
      assert.equal(gatewayBodies.length, 1);
      assert.equal(typeof gatewayBodies[0].apiKey, 'string');
      assert.equal(gatewayBodies[0].apiKey.length, 71, 'expected MASK.md display form');
    });
    check('the route never echoes the key back to the browser', () => {
      assert.equal(JSON.stringify(ok).indexOf(gatewayBodies[0].apiKey), -1, 'masked key leaked into the reply');
      assert.equal(JSON.stringify(ok).indexOf('sk-Example'), -1, 'raw key leaked into the reply');
    });
    const docs = await (await postCall({ api: 'test.demo', do: false, inbound: {} })).json();
    check('docs through this route is refused, so it cannot carry a key', () => {
      assert.equal(docs.ok, false);
      assert.match(docs.error, /do: true/);
      assert.equal(gatewayBodies.length, 1, 'a docs request reached the gateway through the execute route');
    });

    process.env.DSH_CREDENTIALS_PATH = path.join(os.tmpdir(), 'fdep-http-missing-' + process.pid + '.yaml');
    gatewayBodies = [];
    const noKey = await (await postCall({ api: 'test.demo', do: true, inbound: { name: 'aaa' } })).json();
    check('a missing credential fails closed instead of running unauthenticated', () => {
      assert.equal(noKey.ok, false);
      assert.equal(noKey.keyRef, null);
      assert.match(String(noKey.error), /apiKey/);
      assert.equal(gatewayBodies.length, 0, 'an unauthenticated execute reached the gateway');
    });
  } finally {
    globalThis.fetch = realFetch;
    if (savedCreds === undefined) delete process.env.DSH_CREDENTIALS_PATH;
    else process.env.DSH_CREDENTIALS_PATH = savedCreds;
  }

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
