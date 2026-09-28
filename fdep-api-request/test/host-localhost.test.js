'use strict';

// Offline test for the host side of fdep-api-request-bundle.
//
// Goal: confirm the plugin object the package exports matches the static
// bundle contract (name + inject + apply), and that execute() with a mocked
// fetch produces the expected envelope — without booting dsh web.
//
// Run from the bundle root: `node test/host-localhost.test.js`

const assert = require('node:assert/strict');
const moduleAlias = require('node:module');
const path = require('node:path');

// Stub `fetch` so we never hit the real FDEP endpoint during the test.
const calls = [];
const stubFetch = async function (url, init) {
  calls.push({ url, init });
  if (url.indexOf('abc.feg.com.tw') === -1) {
    throw new Error('unexpected URL: ' + url);
  }
  let parsed = {};
  try { parsed = JSON.parse(init.body); } catch (_) {}
  if (parsed.do === false) {
    // docs mode
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          data: {
            docs: {
              desc: 'a tiny example',
              name: 'aaa',
            },
            flow: 'flowchart TD\n  N2@{ label: "fetch" }',
          },
        });
      },
    };
  }
  // execute mode
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        trace_id: 'fake-trace-id',
        data: { echoed: parsed.inbound },
      });
    },
  };
};
globalThis.fetch = stubFetch;

const plugin = require(path.join(__dirname, '..', 'lib', 'index.js'));

async function main() {
  // Shape checks
  assert.equal(typeof plugin, 'object', 'module.exports must be the plugin object, not a factory');
  assert.equal(plugin.name, 'fdep-api-request-bundle');
  assert.deepEqual(plugin.inject, ['tools']);
  assert.equal(typeof plugin.apply, 'function');

  // Mock the tools service
  const toolsRegistry = {};
  const effects = [];
  const ctx = {
    tools: {
      register(def) {
        toolsRegistry[def.name] = def;
        return function dispose() { delete toolsRegistry[def.name]; };
      },
    },
    effect(fn, label) {
      effects.push({ fn, label });
    },
  };

  plugin.apply(ctx);

  assert.ok(toolsRegistry.fdep_call, 'fdep_call tool should be registered');
  // The plugin must NOT wrap the register() disposer in ctx.effect: cordis
  // invokes the effect callback immediately and treats its return value as
  // the disposer, so `ctx.effect(dispose)` would unregister the tool at once.
  // register() already binds disposal to the calling fiber.
  assert.equal(effects.length, 0, 'the plugin must not queue a ctx.effect for the tool');

  const tool = toolsRegistry.fdep_call;
  assert.equal(tool.name, 'fdep_call');
  assert.equal(tool.parameters.type, 'object');
  assert.equal(tool.parameters.required[0], 'api_id');
  assert.equal(tool.parameters.required[1], 'mode');
  assert.deepEqual(tool.parameters.properties.mode.enum, ['docs', 'execute']);
  assert.equal(typeof tool.execute, 'function');
  assert.equal(tool.timeoutMs, 30000);
  assert.equal(tool.isConcurrencySafe(), true);

  // ---- docs mode ----
  calls.length = 0;
  const docsRes = await tool.execute({ api_id: 'test.demo', mode: 'docs', inbound: {} }, {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://abc.feg.com.tw/oauth2/fdep');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  const sentBody = JSON.parse(calls[0].init.body);
  assert.equal(sentBody.api, 'test.demo');
  assert.equal(sentBody.do, false);
  assert.deepEqual(sentBody.inbound, {});

  assert.equal(docsRes.api_id, 'test.demo');
  assert.equal(docsRes.desc, 'a tiny example');
  assert.deepEqual(docsRes.params, { name: 'aaa' });

  // ---- execute mode ----
  calls.length = 0;
  const execRes = await tool.execute(
    { api_id: 'test.demo', mode: 'execute', inbound: { name: 'aaa' } },
    {},
  );
  assert.equal(calls.length, 1);
  const execBody = JSON.parse(calls[0].init.body);
  assert.equal(execBody.do, true);
  assert.deepEqual(execBody.inbound, { name: 'aaa' });

  assert.equal(execRes.api_id, 'test.demo');
  assert.equal(execRes.trace_id, 'fake-trace-id');
  assert.deepEqual(execRes.data, { echoed: { name: 'aaa' } });
  assert.deepEqual(execRes.inbound_sent, { name: 'aaa' });

  // ---- inbound accepts JSON-stringified object ----
  calls.length = 0;
  const stringRes = await tool.execute(
    { api_id: 'test.demo', mode: 'execute', inbound: '{"name":"from-string"}' },
    {},
  );
  assert.equal(stringRes.data.echoed.name, 'from-string');

  // ---- inbound rejects garbage strings ----
  const badRes = await tool.execute(
    { api_id: 'test.demo', mode: 'execute', inbound: 'not json' },
    {},
  );
  assert.ok(badRes.error, 'should return an error object, not throw');
  assert.match(badRes.error, /JSON object/);

  // ---- validation: empty api_id ----
  await assert.rejects(
    () => tool.execute({ api_id: '', mode: 'docs' }, {}),
    /api_id/,
  );

  // ---- validation: bad mode ----
  await assert.rejects(
    () => tool.execute({ api_id: 'x', mode: 'bogus' }, {}),
    /mode/,
  );

  // ---- output.render wraps the value in a ContentBlock ----
  const blocks = tool.output.render({ mode: 'docs', api_id: 'test.demo' }, docsRes);
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /test\.demo/);

  // ---------------------------------------------------------------------
  // Runtime context: the docs armed for the session the panel opens next.
  //
  // The panel cannot know the new session's id (uiWorkspace.startSession()
  // returns void), so the host binds by TIME: the client POSTs the brief before
  // opening the session, and the provider claims the first session that
  // assembles after that instant and whose createdAt is not older.
  // ---------------------------------------------------------------------
  console.log('\n-- runtime context (systemPrompt + arm route, faked) --');

  const contexts = [];
  const routes = [];
  const created = {};
  const fakeServices = {
    systemPrompt: {
      context(spec) { contexts.push(spec); return () => {}; },
    },
    webServer: {
      register(def) { routes.push(def); return () => {}; },
    },
    sessions: {
      get(id) {
        return created[id] === undefined ? undefined : { header: { createdAt: created[id] } };
      },
    },
  };
  const registry2 = {};
  const ctx2 = {
    tools: {
      register(def) { registry2[def.name] = def; return () => {}; },
    },
    effect(fn) { return fn(); },
    inject(deps, cb) {
      const scope = {};
      for (const dep of deps) scope[dep] = fakeServices[dep];
      cb(scope);
    },
    get(name) { return fakeServices[name]; },
  };
  plugin.apply(ctx2);

  const spec = contexts.find((c) => c.name === 'fdep-api-request/docs');
  assert.ok(spec, 'the docs prompt context was not registered');
  assert.equal(spec.order, 140, 'context order should follow the built-ins');
  assert.equal(typeof spec.text, 'function');
  const route = routes.find((r) => r.path === '/plugins/fdep-api-request/context');
  assert.ok(route, 'the arm route was not registered');
  assert.equal(route.kind, 'exact');

  const { EventEmitter } = require('node:events');
  function post(body, method) {
    const req = new EventEmitter();
    req.method = method || 'POST';
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(text) { this.body = text; },
    };
    const done = route.handler(req, res);
    if ((method || 'POST') === 'POST') {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    }
    return Promise.resolve(done).then(() => ({
      status: res.statusCode,
      json: res.body === undefined ? undefined : JSON.parse(res.body),
    }));
  }

  const armAt = Date.now();
  const armReply = await post({
    apiId: 'twseMops.todayMaterial',
    raw: { desc: '當日重大訊息 {{not a variable}}', an_code: 'M26', watchlist: ['1402', '4904'] },
    inbound: { an_code: 'M26', watchlist: ['1402', '4904'] },
  });
  assert.equal(armReply.status, 200);
  assert.equal(armReply.json.armed, true);
  assert.ok(armReply.json.chars > 0);

  // A session that already existed is never touched.
  created['session-old'] = armAt - 60 * 60 * 1000;
  created['session-new'] = armAt + 5;
  created['session-later'] = armAt + 10;
  assert.equal(spec.text({ agent: { id: 'session-old' } }), '',
    'a pre-existing session must not receive the armed docs');

  const injected = spec.text({ agent: { id: 'session-new' } });
  assert.match(injected, /twseMops\.todayMaterial/, 'the api id is missing');
  assert.match(injected, /an_code: string — "M26"/, 'the parameter line is missing its type/example');
  assert.match(injected, /watchlist: array<string> — \["1402","4904"\]/, 'array types must be named');
  assert.match(injected, /inbound the panel holds right now/, 'the typed inbound is missing');
  assert.match(injected, /\{ \{not a variable\}\}/, 'the {{ }} guard did not run');

  // Bound to that one session, and it stays for the whole session.
  assert.equal(spec.text({ agent: { id: 'session-later' } }), '',
    'the docs must not leak into another session');
  assert.equal(spec.text({ agent: { id: 'session-new' } }), injected,
    'the bound session must keep its context');

  // Disarm: a later arm without docs clears whatever was pending.
  const cleared = await post({ apiId: '', raw: null });
  assert.equal(cleared.json.armed, false);
  assert.equal(spec.text({ agent: { id: 'session-new' } }), '', 'disarm did not clear the context');

  // An arm nobody claimed expires instead of leaking into a much later session.
  await post({ apiId: 'test.demo', raw: { desc: 'x', name: 'aaa' }, inbound: {} });
  const realNow = Date.now;
  Date.now = () => realNow() + 31 * 60 * 1000;
  try {
    assert.equal(spec.text({ agent: { id: 'session-much-later' } }), '',
      'a stale unclaimed arm must expire');
  } finally {
    Date.now = realNow;
  }

  // Non-POST is refused, and the tool still works with no systemPrompt/webServer.
  const refused = await post({}, 'GET');
  assert.equal(refused.status, 405);
  assert.ok(registry2.fdep_call, 'the tool must register with or without the optional services');

  console.log('OK — runtime context checks held.');
  console.log('  • arm route: POST /plugins/fdep-api-request/context');
  console.log('  • binds to the first session assembled after the arm (createdAt >= arm)');
  console.log('  • keeps the docs for that session, never leaks to another');
  console.log('  • disarm + 30-minute expiry for unclaimed arms');
  console.log('  • {{ }} neutralised before the text becomes prompt context');

  console.log('\nOK — host plugin passes ' + calls.length + ' additional dummy checks; all assertions held.');
  console.log('  • plugin shape: { name, inject: [tools], apply }');
  console.log('  • fdep_call registered with docs/execute modes');
  console.log('  • fetch is called with POST + Content-Type: application/json');
  console.log('  • docs splits into desc + params (excluding desc)');
  console.log('  • execute returns trace_id + data + inbound_sent');
  console.log('  • inbound accepts JSON-string or object');
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});