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
const os = require('node:os');

// ---- resolve the real DSH packages ----------------------------------------
const DSH_ROOT = 'D:/Refine/Books/ntop/AI/node/global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const CORDIS = path.join(DSH_ROOT, 'cordis');
const DSH_TOOLS = path.join(DSH_ROOT, 'dsh-tools');
const DSH_SYSTEM_PROMPT = path.join(DSH_ROOT, 'dsh-system-prompt');
// Since dsh-tools 0.2.x, `execute()` and `assemble()` select a *tool executor*
// from the mounting scope and throw `ToolExecutorUnavailableError` when none is
// registered. The harness composes one (native or PTC); this test mounts the
// native one so the real pipeline can run.
const DSH_TOOL_EXECUTOR = path.join(DSH_ROOT, 'dsh-tool-executor-native');

for (const p of [CORDIS, DSH_TOOLS, DSH_SYSTEM_PROMPT, DSH_TOOL_EXECUTOR]) {
  if (!fs.existsSync(p)) {
    console.error('SKIP: real DSH packages not found at ' + p);
    console.error('      this test needs the installed @deepseek-ai/dsh tree.');
    process.exit(2);
  }
}

const { Context } = require(CORDIS);
const { pathToFileURL } = require('node:url');
const toolsMod = require(DSH_TOOLS);
const systemPromptMod = require(DSH_SYSTEM_PROMPT);

const fdepPlugin = require('../lib/index.js');

// ---- credentials -----------------------------------------------------------
// Execute carries the gateway's apiKey, read from the credentials file. Point
// the plugin at a synthetic file so the test is hermetic and never touches the
// real key: MASK.md's own example token is used.
const CREDS_PATH = path.join(os.tmpdir(), 'fdep-test-credentials-' + process.pid + '.yaml');
fs.writeFileSync(CREDS_PATH, 'version: 1\nrefs:\n  AIFE_API_KEY: sk-ExampleKeyReplaceMe001\n', 'utf8');
process.env.DSH_CREDENTIALS_PATH = CREDS_PATH;
const SYNTHETIC_KEY = 'sk-ExampleKeyReplaceMe001';
const { maskApiKey } = fdepPlugin.__test;

/** The masked key for `stamp`, used to compare without pinning the clock. */
function maskedFor(stamp) {
  return maskApiKey(SYNTHETIC_KEY, new Date(stamp));
}

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
  // dsh-tools 0.2.x takes a *batch*: `{calls: [{id, name, arguments}]}` and
  // answers `{results: [{callId, result}]}`. Unwrap the single call so the
  // assertions below keep reading one result at a time.
  const out = await tools.execute({
    calls: [{
      id: callId || ('call-' + Math.random().toString(36).slice(2)),
      name: 'fdep_call',
      arguments: JSON.stringify(args),
    }],
    signal: new AbortController().signal,
  });
  const first = out && Array.isArray(out.results) ? out.results[0] : null;
  if (!first || !first.result) {
    throw new Error('no tool result in batch: ' + JSON.stringify(out));
  }
  return first.result;
}

// ---- main ------------------------------------------------------------------
async function main() {
  console.log('=== 1. mount the REAL service graph ===');
  const ctx = new Context();
  await ctx.plugin(systemPromptMod.default, {});
  await ctx.plugin(toolsMod.default, {});
  // The executor is a separate ESM package; mount it as the deployment default.
  const executorMod = await import(pathToFileURL(path.join(DSH_TOOL_EXECUTOR, 'lib', 'index.js')).href);
  await ctx.plugin({ name: executorMod.name, inject: executorMod.inject, apply: executorMod.apply }, {});
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
  check('docs mode carries NO apiKey (the gateway answers it anonymously)', () => {
    // The user-facing rule: authorization applies to execute only. Sending the
    // credential with a docs request would run the gateway's auth step for a
    // request that does not need it (measured: it then stalls).
    const sent = JSON.parse(fetchCalls[0].init.body);
    assert.equal(sent.apiKey, undefined, 'docs request carried an apiKey');
    assert.deepEqual(Object.keys(sent).sort(), ['api', 'do', 'inbound']);
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
  check('execute carries the masked apiKey, and it is the ONLY added field', () => {
    const sent = JSON.parse(fetchCalls[0].init.body);
    assert.deepEqual(Object.keys(sent).sort(), ['api', 'apiKey', 'do', 'inbound']);
    assert.equal(typeof sent.apiKey, 'string');
    // MASK.md's display formula: "sk-" + base64(key + "@" + ISO), 71 chars for a
    // 25-char key. The 67-char variant is rejected by this endpoint (measured),
    // so the shape is pinned here rather than left to drift.
    assert.equal(sent.apiKey.length, 71);
    const decoded = Buffer.from(sent.apiKey.slice(3), 'base64').toString('utf8');
    assert.ok(decoded.startsWith(SYNTHETIC_KEY), 'inner value must keep the sk- prefix');
    assert.match(decoded, /@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const stamp = decoded.slice(SYNTHETIC_KEY.length);
    assert.equal(sent.apiKey, maskApiKey(SYNTHETIC_KEY, new Date(stamp.slice(1))));
  });
  check('the raw key never appears in the request or in the result', () => {
    const sent = JSON.parse(fetchCalls[0].init.body);
    assert.equal(JSON.stringify(sent).indexOf(SYNTHETIC_KEY + '@'), -1, 'raw key leaked into the wire body');
    assert.equal(JSON.stringify(execRes.value).indexOf(SYNTHETIC_KEY), -1, 'raw key leaked into the result');
    assert.equal(JSON.stringify(execRes.content).indexOf(SYNTHETIC_KEY), -1, 'raw key leaked into the rendered content');
  });

  console.log('\n=== 4b. execute fails closed when no credential is available ===');
  // A missing key must never produce a silent unauthenticated execute.
  process.env.DSH_CREDENTIALS_PATH = path.join(os.tmpdir(), 'fdep-missing-' + process.pid + '.yaml');
  fetchCalls = [];
  const noKey = await execute(tools, { api_id: 'test.demo', mode: 'execute', inbound: { name: 'aaa' } }, 'call-nokey');
  process.env.DSH_CREDENTIALS_PATH = CREDS_PATH;
  check('a missing credential becomes an error result, not a call', () => {
    assert.equal(noKey.isError, false, 'it must be a result, not a throw: ' + JSON.stringify(noKey.content));
    assert.equal(noKey.value.api_id, 'test.demo');
    assert.match(String(noKey.value.error), /apiKey/);
    assert.equal(fetchCalls.length, 0, 'an execute without a key still reached the gateway');
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
  // session's id, so the host binds the brief by TIME and SCOPE — the client arms
  // before opening the session, and the provider claims the first scope that
  // assembles afterwards.
  const systemPrompt = ctx.get('systemPrompt');
  const routes = [];

  // Contract guard. This plugin derives the session id from the assembly context,
  // which only works because `dsh-agent`'s `assembleContextFor(agent, signal)`
  // returns `{ agent, scope: agent, signal? }` — `agent.id` is a SessionId. The
  // *published* `AssembleContext` type is narrower (it documents only
  // `{ scope?, signal? }`), so the implementation is the source of truth here:
  // pinning it means a DSH upgrade that changes the shape fails loudly instead of
  // silently injecting into the wrong session (or nowhere at all).
  {
    const agentLib = path.join(DSH_ROOT, 'dsh-agent', 'lib', 'index.js');
    const src = fs.readFileSync(agentLib, 'utf8');
    const at = src.indexOf('function assembleContextFor');
    const body = at === -1 ? '' : src.slice(at, at + 260);
    check('the runtime still hands the provider an agent (whose id is the session id)', () => {
      assert.ok(at !== -1, 'assembleContextFor is gone from dsh-agent');
      assert.match(body, /\bagent,/, 'assembleContextFor no longer passes the agent');
      assert.match(body, /scope:\s*agent/, 'the assembly scope is no longer the agent object');
    });
  }

  // Provided AFTER the plugin mounted on purpose: the plugin resolves these two
  // optional services through ctx.inject(), so they may appear at any time.
  ctx.provide('webServer', {
    register(def) { routes.push(def); return () => {}; },
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

  // The real assembly context is `{ agent, scope: agent, signal? }` and `agent.id`
  // is the session id (Agent.id is a SessionId), so id stubs stand in for the
  // session the panel opened and for another one that is also assembling.
  const asSession = (id) => ({ agent: { id: id }, scope: { id: id } });
  const sessionAfter = asSession('session-after');
  const sessionBefore = asSession('session-before');

  const after = await systemPrompt.assemble(sessionAfter);
  const injected = after.contexts.filter((c) => c.name === 'fdep-api-request/docs');
  check('the real assembler carries every api for the session assembled after the arm', () => {
    assert.equal(injected.length, 1, 'saw contexts: ' + after.contexts.map((c) => c.name).join(','));
    assert.match(injected[0].text, /2 個 FDEP api/);
    assert.match(injected[0].text, /api: twseMops\.todayMaterial/);
    assert.match(injected[0].text, /api: twseMops\.companyProfile/);
    assert.match(injected[0].text, /desc: 公司基本資料/);
    assert.match(injected[0].text, /watchlist: array<string>/);
    assert.match(injected[0].text, /這個 api 的 inbound（面板目前的值/);
  });

  const before = await systemPrompt.assemble(sessionBefore);
  check('another session gets nothing', () => {
    // `assemble()` lists every registered context; the empty ones are dropped
    // later by the render pass (`renderContextSections` keeps text.length > 0),
    // so the meaningful assertion here is that the text is empty.
    const mine = before.contexts.filter((c) => c.name === 'fdep-api-request/docs');
    assert.equal(
      mine.filter((c) => c.text !== '').length,
      0,
      'injected into another session: ' + JSON.stringify(mine),
    );
  });

  const again = await systemPrompt.assemble(sessionAfter);
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
