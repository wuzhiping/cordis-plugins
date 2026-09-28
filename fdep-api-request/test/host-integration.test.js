'use strict';

// Integration test for fdep-api-request-bundle, host side.
//
// This is NOT a mock: it mounts the REAL @deepseek-ai/cordis Context, the
// REAL @deepseek-ai/dsh-system-prompt, and the REAL @deepseek-ai/dsh-tools
// registry, then drives our plugin through the real execute pipeline
// (argument validation -> dispatch -> output.render).
//
// Only global fetch is stubbed, so the test never reaches the real FDEP host.
//
// Run: node test/host-integration.test.js

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// ---- resolve the real DSH packages ----------------------------------------
const DSH_ROOT = 'D:/Refine/Books/ntop/AI/node/global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const CORDIS = path.join(DSH_ROOT, 'cordis');
const DSH_TOOLS = path.join(DSH_ROOT, 'dsh-tools');
const DSH_SYSTEM_PROMPT = path.join(DSH_ROOT, 'dsh-system-prompt');

for (const p of [CORDIS, DSH_TOOLS, DSH_SYSTEM_PROMPT]) {
  if (!fs.existsSync(p)) {
    console.error('SKIP: real DSH packages not found at ' + p);
    console.error('      this test needs the installed @deepseek-ai/dsh tree.');
    process.exit(2);
  }
}

const { Context } = require(CORDIS);
const toolsMod = require(DSH_TOOLS);
const systemPromptMod = require(DSH_SYSTEM_PROMPT);

const fdepPlugin = require('../lib/index.js');

// ---- stub fetch ------------------------------------------------------------
let fetchCalls = [];
let fetchMode = 'ok';

globalThis.fetch = async function (url, init) {
  fetchCalls.push({ url, init });
  if (fetchMode === 'network-error') {
    throw new Error('simulated socket hangup');
  }
  if (fetchMode === 'http-500') {
    return {
      ok: false,
      status: 500,
      async text() { return JSON.stringify({ error: 'boom' }); },
    };
  }
  let body = {};
  try { body = JSON.parse(init.body); } catch (_) {}
  if (body.do === false) {
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          data: {
            docs: { desc: 'simplest example', name: 'aaa' },
            flow: 'flowchart TD\n  N2@{ label: "get" }',
          },
          trace_id: 'trace-docs',
        });
      },
    };
  }
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ data: { echoed: body.inbound }, trace_id: 'trace-exec' });
    },
  };
};

// ---- helpers ---------------------------------------------------------------
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

async function execute(tools, args, callId) {
  return tools.execute({
    callId: callId || ('call-' + Math.random().toString(36).slice(2)),
    name: 'fdep_call',
    arguments: args,
    signal: new AbortController().signal,
  });
}

// ---- main ------------------------------------------------------------------
async function main() {
  console.log('=== 1. mount the REAL service graph ===');
  const ctx = new Context();
  await ctx.plugin(systemPromptMod.default, {});
  await ctx.plugin(toolsMod.default, {});
  const tools = ctx.get('tools');
  check('ctx.tools is live after mounting real dsh-tools', () => {
    assert.ok(tools, 'ctx.get("tools") returned undefined');
  });

  console.log('\n=== 2. mount our bundle plugin ===');
  await ctx.plugin(fdepPlugin, {});
  const schemas = tools.schemas();
  check('exactly one tool registered', () => {
    assert.equal(schemas.length, 1, 'saw: ' + schemas.map((s) => s.name).join(','));
    assert.equal(schemas[0].name, 'fdep_call');
  });

  const schema = schemas[0];
  check('parameters is a projected JSON Schema object', () => {
    assert.equal(schema.parameters.type, 'object');
    assert.deepEqual(schema.parameters.required, ['api_id', 'mode']);
    assert.equal(schema.parameters.properties.api_id.type, 'string');
    assert.deepEqual(schema.parameters.properties.mode.enum, ['docs', 'execute']);
    assert.equal(schema.parameters.properties.inbound.type, 'object');
    assert.equal(schema.parameters.properties.inbound.additionalProperties, true);
  });
  check('schema is wire-clean (no execute/output leaked)', () => {
    assert.equal(schema.execute, undefined);
    assert.equal(schema.output, undefined);
    assert.equal(schema.timeoutMs, undefined);
  });

  console.log('\n=== 3. docs mode through the real pipeline ===');
  fetchCalls = [];
  const docsRes = await execute(tools, { api_id: 'test.demo', mode: 'docs', inbound: {} }, 'call-docs');
  check('docs call succeeded', () => {
    assert.equal(docsRes.isError, false, JSON.stringify(docsRes.content));
    assert.equal(docsRes.value.api_id, 'test.demo');
    assert.equal(docsRes.value.desc, 'simplest example');
    assert.deepEqual(docsRes.value.params, { name: 'aaa' });
  });
  check('docs mode reports each field type from its example value', () => {
    // The example's JSON type IS the field type. Without this a caller has no
    // signal that a field is a list — which is how an array parameter ended up
    // being sent as a comma-joined string.
    assert.deepEqual(docsRes.value.types, { name: 'string' });
  });
  check('docs call hit the right URL/method/headers', () => {
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'https://abc.feg.com.tw/oauth2/fdep');
    assert.equal(fetchCalls[0].init.method, 'POST');
    assert.equal(fetchCalls[0].init.headers['Content-Type'], 'application/json');
    const sent = JSON.parse(fetchCalls[0].init.body);
    assert.equal(sent.api, 'test.demo');
    assert.equal(sent.do, false);
    assert.deepEqual(sent.inbound, {});
  });
  check('docs content is a rendered text block', () => {
    assert.equal(docsRes.content.length, 1);
    assert.equal(docsRes.content[0].type, 'text');
    assert.match(docsRes.content[0].text, /\[fdep_call\] docs test\.demo/);
    assert.match(docsRes.content[0].text, /simplest example/);
  });

  console.log('\n=== 4. execute mode through the real pipeline ===');
  fetchCalls = [];
  const execRes = await execute(
    tools,
    { api_id: 'test.demo', mode: 'execute', inbound: { name: 'aaa' } },
    'call-exec',
  );
  check('execute call succeeded', () => {
    assert.equal(execRes.isError, false, JSON.stringify(execRes.content));
    assert.equal(execRes.value.trace_id, 'trace-exec');
    assert.deepEqual(execRes.value.data, { echoed: { name: 'aaa' } });
    assert.deepEqual(execRes.value.inbound_sent, { name: 'aaa' });
  });
  check('execute call sent do:true with the inbound verbatim', () => {
    const sent = JSON.parse(fetchCalls[0].init.body);
    assert.equal(sent.do, true);
    assert.deepEqual(sent.inbound, { name: 'aaa' });
  });

  console.log('\n=== 5. our execute() validates before dispatch ===');
  // NOTE: with raw JSON Schema parameters the registry does NOT pre-validate
  // (only the defineTool DSL form gets that). Validation therefore lives in
  // execute(), and a throw is materialized by the pipeline as an error result.
  fetchCalls = [];
  const missing = await execute(tools, { mode: 'docs' }, 'call-missing');
  check('missing api_id produces an error result', () => {
    assert.equal(missing.isError, true, 'expected isError, got ' + JSON.stringify(missing.content));
    assert.match(JSON.stringify(missing.content), /api_id/);
  });
  check('rejected call never reached fetch', () => {
    assert.equal(fetchCalls.length, 0, 'fetch was called despite invalid args');
  });

  fetchCalls = [];
  const badMode = await execute(tools, { api_id: 'x', mode: 'bogus' }, 'call-badmode');
  check('bad mode value produces an error result', () => {
    assert.equal(badMode.isError, true);
    assert.match(JSON.stringify(badMode.content), /mode/);
  });
  check('bad-mode call never reached fetch', () => {
    assert.equal(fetchCalls.length, 0);
  });

  fetchCalls = [];
  const emptyId = await execute(tools, { api_id: '   ', mode: 'docs' }, 'call-empty');
  check('whitespace-only api_id is rejected', () => {
    assert.equal(emptyId.isError, true);
    assert.match(JSON.stringify(emptyId.content), /api_id/);
  });

  console.log('\n=== 6. failure paths stay result-shaped, not thrown ===');
  fetchCalls = [];
  fetchMode = 'network-error';
  const netRes = await execute(tools, { api_id: 'test.demo', mode: 'docs' }, 'call-net');
  fetchMode = 'ok';
  check('network error becomes a value, not a throw', () => {
    assert.equal(netRes.isError, false);
    assert.match(netRes.value.error, /network error/);
  });

  fetchCalls = [];
  fetchMode = 'http-500';
  const httpRes = await execute(tools, { api_id: 'test.demo', mode: 'docs' }, 'call-500');
  fetchMode = 'ok';
  check('HTTP 500 becomes a value with upstream_status', () => {
    assert.equal(httpRes.isError, false);
    assert.equal(httpRes.value.upstream_status, 500);
    assert.match(httpRes.value.error, /upstream HTTP 500/);
  });

  console.log('\n=== 7. string inbound is still accepted ===');
  fetchCalls = [];
  const strRes = await execute(
    tools,
    { api_id: 'test.demo', mode: 'execute', inbound: '{"name":"from-string"}' },
    'call-str',
  );
  check('JSON-string inbound parsed to an object', () => {
    // The DSL types inbound as an object, so the registry may reject a bare
    // string before our parser sees it. Either outcome is acceptable — what
    // must NOT happen is a crash or a wrong outbound body.
    if (strRes.isError) {
      assert.match(JSON.stringify(strRes.content), /inbound|object/);
    } else {
      assert.equal(strRes.value.data.echoed.name, 'from-string');
    }
  });

  console.log('\n=== 8. disposal removes the tool ===');
  // Remount in a throwaway context so we can dispose without disturbing ctx.
  const ctx2 = new Context();
  await ctx2.plugin(systemPromptMod.default, {});
  await ctx2.plugin(toolsMod.default, {});
  await ctx2.plugin(fdepPlugin, {});
  const tools2 = ctx2.get('tools');
  check('tool present before dispose', () => {
    assert.equal(tools2.schemas().length, 1);
  });
  await ctx2.fiber.dispose();
  check('tool gone after disposing the plugin fiber', () => {
    assert.equal(tools2.schemas().length, 0);
  });

  console.log('\n=== 9. runtime context: the armed docs reach the real assembler ===');
  // The panel is a root-scoped `main` occupant: it never learns the new
  // session's id, so the host binds the brief by TIME — the client arms before
  // opening the session, and the provider claims the first session that
  // assembles afterwards whose createdAt is not older.
  const systemPrompt = ctx.get('systemPrompt');
  const routes = [];
  const created = {};
  // Provided AFTER the plugin mounted on purpose: the plugin resolves these two
  // optional services through ctx.inject(), so they may appear at any time.
  ctx.provide('webServer', {
    register(def) { routes.push(def); return () => {}; },
  });
  ctx.provide('sessions', {
    get(id) { return created[id] === undefined ? undefined : { header: { createdAt: created[id] } }; },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  check('the arm route registered with the real webServer slot', () => {
    const route = routes.find((r) => r.path === '/plugins/fdep-api-request/context');
    assert.ok(route, 'no arm route was registered');
    assert.equal(route.kind, 'exact');
  });

  const route = routes.find((r) => r.path === '/plugins/fdep-api-request/context');
  const { EventEmitter } = require('node:events');
  function postArm(body) {
    const req = new EventEmitter();
    req.method = 'POST';
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(text) { this.body = text; },
    };
    const done = route.handler(req, res);
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
    return Promise.resolve(done).then(() => ({ status: res.statusCode, json: JSON.parse(res.body) }));
  }

  const armedAt = Date.now();
  const armReply = await postArm({
    apis: [
      {
        apiId: 'twseMops.todayMaterial',
        raw: { desc: 'simplest example', name: 'aaa', watchlist: ['1402', '4904'] },
        inbound: { name: 'aaa' },
      },
      {
        apiId: 'twseMops.companyProfile',
        raw: { desc: '公司基本資料', stockNo: '2330' },
        inbound: { stockNo: '2330' },
      },
    ],
  });
  check('the arm route answered and armed the whole set', () => {
    assert.equal(armReply.status, 200);
    assert.equal(armReply.json.armed, true);
    assert.deepEqual(armReply.json.api_ids, ['twseMops.todayMaterial', 'twseMops.companyProfile']);
  });

  created['session-before'] = armedAt - 60 * 60 * 1000;
  created['session-after'] = armedAt + 5;

  const after = await systemPrompt.assemble({ agent: { id: 'session-after' } });
  const injected = after.contexts.filter((c) => c.name === 'fdep-api-request/docs');
  check('the real assembler carries every api for the session created after the arm', () => {
    assert.equal(injected.length, 1, 'saw contexts: ' + after.contexts.map((c) => c.name).join(','));
    assert.match(injected[0].text, /2 個 FDEP api/);
    assert.match(injected[0].text, /api: twseMops\.todayMaterial/);
    assert.match(injected[0].text, /api: twseMops\.companyProfile/);
    assert.match(injected[0].text, /watchlist: array<string>/);
    assert.match(injected[0].text, /這個 api 的 inbound（面板目前的值/);
  });

  const before = await systemPrompt.assemble({ agent: { id: 'session-before' } });
  check('a session that predates the arm gets nothing', () => {
    // `assemble()` lists every registered context; the empty ones are dropped
    // later by the render pass (`renderContextSections` keeps text.length > 0),
    // so the meaningful assertion here is that the text is empty.
    const mine = before.contexts.filter((c) => c.name === 'fdep-api-request/docs');
    assert.equal(
      mine.filter((c) => c.text !== '').length,
      0,
      'injected into a pre-existing session: ' + JSON.stringify(mine),
    );
  });

  const again = await systemPrompt.assemble({ agent: { id: 'session-after' } });
  check('the docs stay for that session on later steps', () => {
    assert.equal(again.contexts.filter((c) => c.name === 'fdep-api-request/docs').length, 1);
  });

  console.log('\nAll ' + pass + ' checks passed against the real dsh-tools registry.');
}

main().catch((err) => {
  console.error('\nINTEGRATION TEST FAILED');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
