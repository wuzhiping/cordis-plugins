import assert from "node:assert/strict";
import test from "node:test";
import { apply } from "./index.mjs";
import { installStoredCredentials, TEST_CONNECTION } from "./test-support.mjs";

/**
 * A registry with Cordis's waterfall shape: one entry per event, listeners
 * composed in registration order, each receiving `(payload, next)`.
 *
 * A plain `Map` keeping the last listener is enough until an event has two —
 * `tools/pre-execute` now has the session gate and the URI guard — at which point
 * it silently tests the wrong one.
 */
function makeHandlers() {
  const listeners = new Map();
  return {
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(handler);
    },
    get(name) {
      const chain = listeners.get(name) ?? [];
      const run = (index, payload, next) => {
        const handler = chain[index];
        if (!handler) return next ? next() : undefined;
        return handler(payload, () => run(index + 1, payload, next));
      };
      return (payload, next) => run(0, payload, next);
    },
  };
}

test("session filtering skips subagents without changing main-session recall", async () => {
  const handlers = makeHandlers();
  let memoryRuntime;
  const ctx = {
    logger: { debug() {} },
    provide(name, value) {
      if (name === "openvikingMemory") memoryRuntime = value;
    },
    effect(execute) {
      execute();
      return async () => {};
    },
    tools: { register() {} },
    plugin() {},
    on: handlers.on,
  };

  const agent = {
    session: { id: "dsh-final-batch", header: { cwd: "/workspace" } },
    ctx: {
      effect(execute) {
        execute();
        return async () => {};
      },
    },
  };
  const initial = [message("initial input")];
  const downstream = [message("downstream replacement")];
  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/health") return response({});
    if (path === "/api/v1/sessions") return response({});
    if (path === "/api/v1/search/search") {
      seen.push(JSON.parse(init.body).query);
      return response({ rendered: "" });
    }
    if (path === "/api/v1/fs/ls") return response([]);
    return response({}, 404);
  };

  // Stub both halves before `apply`: the storage lookup decides whether anything
  // is mounted at all, so it has to be answerable from the first moment.
  const restoreCredentials = installStoredCredentials();
  try {
    await apply(ctx, {
      endpoint: "http://127.0.0.1:1933",
      workspacePeer: false,
      skipSubagentSessions: true,
    });

    // Registered synchronously by `apply`, so both exist well before the lookups
    // answer; the listeners themselves are what gate on the session's confirmation.
    const created = handlers.get("agent/created");
    assert.equal(typeof created, "function");
    const preStep = handlers.get("agent/pre-step");

    // The real sequence: DSH settles `agent/created` — where this session is
    // confirmed — before the first pre-step of that session.
    await created({ agent, source: "startup", signal: new AbortController().signal });

    await preStep({
      agent,
      messages: initial,
      signal: new AbortController().signal,
    }, async () => ({ kind: "enter", messages: downstream }));

    const child = {
      status: "idle",
      session: {
        id: "dsh-derived-child",
        header: { cwd: "/workspace", origin: "subagent" },
      },
      inject() {
        assert.fail("subagent profile must not be injected");
      },
      ctx: {
        effect() {
          assert.fail("subagent teardown commit must not be registered");
        },
      },
    };
    assert.equal(await created({ agent: child, source: "startup" }), undefined);
    assert.equal(await handlers.get("agent/session-start")({ agent: child }), false);
    const childMessages = [message("derived worker input")];
    const childDecision = await preStep({
      agent: child,
      messages: childMessages,
      signal: new AbortController().signal,
    }, async () => ({ kind: "enter", messages: childMessages }));
    handlers.get("session/event")(child.session, {
      type: "user/message",
      data: message("derived exploration chatter"),
    });
    handlers.get("session/event")(child.session, { type: "turn/end", data: {} });
    await handlers.get("session/flush")(child.session);

    assert.deepEqual(childDecision.messages, childMessages);
    assert.equal(memoryRuntime.states.has(child.session.id), false);
  } finally {
    restoreCredentials();
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(seen, ["downstream replacement"]);
});

async function mountPlugin() {
  const handlers = makeHandlers();
  let runtime;
  const ctx = {
    logger: { debug() {} },
    provide(name, value) {
      if (name === "openvikingMemory") runtime = value;
    },
    effect(execute) {
      execute();
      return async () => {};
    },
    tools: { register() {} },
    plugin() {},
    on: handlers.on,
  };
  const restore = installStoredCredentials();
  try {
    await apply(ctx, { endpoint: "http://127.0.0.1:1933", workspacePeer: false });
  } finally {
    restore();
  }
  runtime.stopDrainer();
  // Replace only the network-bound part; initialize/profileMessage stay real so
  // the single-flight and delivered-once guarantees are the plugin's own.
  const calls = { initialize: 0 };
  runtime.initializeState = async state => {
    calls.initialize += 1;
    state.profileBlock = "<openviking-context source=\"profile\">p</openviking-context>";
    state.ready = true;
    return state;
  };
  return { handlers, runtime, calls };
}

function startupAgent(id = "dsh-startup") {
  const agent = {
    status: "idle",
    session: { id, header: { cwd: "/workspace" } },
    injected: [],
    effects: [],
    inject(message) {
      this.injected.push(message);
    },
    ctx: {
      effect(execute, label) {
        agent.effects.push(label);
        return async () => {};
      },
    },
  };
  return agent;
}

async function withQuietFetch(run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response({ rendered: "" });
  // The per-session confirmation runs inside `agent/created`, so the lookup has to
  // be answerable for as long as the handler calls are — not just around `apply`.
  const restoreCredentials = installStoredCredentials();
  try {
    return await run();
  } finally {
    restoreCredentials();
    globalThis.fetch = originalFetch;
  }
}

test("agent/created (dsh 0.1.7+) runs startup once and pre-step does not re-inject the profile", async () => {
  const { handlers, calls } = await mountPlugin();
  const agent = startupAgent();
  await withQuietFetch(async () => {
    const result = await handlers.get("agent/created")({
      agent,
      source: "startup",
      signal: new AbortController().signal,
    });
    // Anything but undefined would bail DSH's serial agent/created dispatch.
    assert.equal(result, undefined);
    assert.equal(calls.initialize, 1);
    assert.equal(agent.injected.length, 1);
    assert.match(agent.injected[0].content[0].text, /source="profile"/);
    assert.deepEqual(agent.effects, ["openvikingMemory.disposeSession()"]);

    // A stray session-start on the same agent must not repeat startup.
    await handlers.get("agent/session-start")({ agent, source: "startup" });
    const input = [message("first prompt")];
    const decision = await handlers.get("agent/pre-step")({
      agent,
      messages: input,
      signal: new AbortController().signal,
    }, async () => ({ kind: "enter", messages: input }));

    assert.equal(calls.initialize, 1);
    assert.equal(agent.injected.length, 1);
    assert.deepEqual(agent.effects, ["openvikingMemory.disposeSession()"]);
    assert.equal(
      decision.messages.some(m => /source="profile"/.test(m.content?.[0]?.text || "")),
      false,
    );
  });
});

test("dsh 0.1.x: source-less agent/created defers startup to agent/session-start", async () => {
  const { handlers, calls } = await mountPlugin();
  const agent = startupAgent("dsh-legacy");
  await withQuietFetch(async () => {
    assert.equal(await handlers.get("agent/created")({ agent }), undefined);
    assert.equal(calls.initialize, 0);
    assert.deepEqual(agent.effects, []);

    assert.equal(
      await handlers.get("agent/session-start")({ agent, source: "startup" }),
      true,
    );
    assert.equal(calls.initialize, 1);
    assert.equal(agent.injected.length, 1);
    assert.deepEqual(agent.effects, ["openvikingMemory.disposeSession()"]);
  });
});

test("agent/created returns on abort and never rejects on startup failure", async () => {
  const { handlers, runtime } = await mountPlugin();
  // These handlers are called directly, so the per-session confirmation needs an
  // answerable lookup for the whole test — not just around `apply`.
  const restoreCredentials = installStoredCredentials();
  try {
    let release;
    runtime.initializeState = () => new Promise(resolve => {
      release = resolve;
    });
    const controller = new AbortController();
    const agent = startupAgent("dsh-aborted");
    const pending = handlers.get("agent/created")({
      agent,
      source: "startup",
      signal: controller.signal,
    });
    // The session confirmation is awaited before `initializeState` is reached, so
    // wait until that promise is actually pending — aborting earlier would leave
    // `release` undefined and test the wrong thing.
    for (let i = 0; i < 50 && !release; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();
    assert.equal(await pending, undefined);
    release({ ready: false });
    assert.deepEqual(agent.injected, []);

    runtime.initializeState = async () => {
      throw new Error("boom");
    };
    const failing = startupAgent("dsh-failing");
    assert.equal(
      await handlers.get("agent/created")({ agent: failing, source: "startup" }),
      undefined,
    );
    assert.deepEqual(failing.injected, []);
  } finally {
    restoreCredentials();
  }
});

// The mask-key lookup is re-asked for every new session, and a session whose
// lookup comes back empty is refused even though the process is otherwise
// connected: no injection, no recall, no capture, and no bridged tool calls.
test("a session whose confirmation fails is refused while the process stays connected", async () => {
  const { handlers, runtime } = await mountPlugin();
  const restoreCredentials = installStoredCredentials({ body: {} });
  try {
    const agent = startupAgent("dsh-unconfirmed");
    assert.equal(
      await handlers.get("agent/created")({ agent, source: "startup", signal: new AbortController().signal }),
      undefined,
    );
    assert.deepEqual(agent.injected, [], "no profile injection");

    const input = [message("what did we decide")];
    const decision = await handlers.get("agent/pre-step")({
      agent,
      messages: input,
      signal: new AbortController().signal,
    }, async () => ({ kind: "enter", messages: input }));
    assert.deepEqual(decision.messages, input, "the batch enters untouched");

    handlers.get("session/event")(agent.session, { type: "user/message", data: message("remember this") });
    handlers.get("session/event")(agent.session, { type: "turn/end", data: {} });
    await handlers.get("session/flush")(agent.session);
    assert.equal(runtime.states.has(agent.session.id), false, "no session state");

    // The bridge cannot be unmounted per session, so the refusal happens here.
    const denied = await handlers.get("tools/pre-execute")({
      name: "mcp__openviking__search",
      arguments: { query: "x" },
      agent: { session: { id: agent.session.id } },
    }, async () => ({ kind: "allow" }));
    assert.equal(denied.kind, "deny");
    // An empty record is a *state*, not a fault: this is what removing the stored
    // connection for a machine looks like, so the wording must not send the reader
    // after a broken key.
    assert.match(denied.reason, /not enabled for this machine/);
    assert.match(denied.reason, /no stored connection/);
    assert.doesNotMatch(denied.reason, /check refs\.AIFE_API_KEY and the storage endpoint\.$/);

    // An unrelated tool is untouched, and so is the URI guard.
    assert.deepEqual(
      await handlers.get("tools/pre-execute")({ name: "read", arguments: { file_path: "/tmp/a" } }, async () => ({ kind: "allow" })),
      { kind: "allow" },
    );
  } finally {
    restoreCredentials();
  }
});

// `agent/created` is serial and holds the new session's queued input until its
// listeners settle, so an unreachable storage endpoint must cost the session a
// bounded delay and nothing else: it can still be created, just without memory.
test("a confirmation that cannot complete never blocks or fails session creation", async () => {
  const { handlers } = await mountPlugin();
  const restoreCredentials = installStoredCredentials({
    responses: [{ networkError: "getaddrinfo ENOTFOUND abc.feg.com.tw" }],
  });
  try {
    const agent = startupAgent("dsh-network-down");
    const startedAt = Date.now();
    assert.equal(
      await handlers.get("agent/created")({ agent, source: "startup", signal: new AbortController().signal }),
      undefined,
      "the listener resolves to undefined; anything else bails the serial dispatch",
    );
    assert.ok(Date.now() - startedAt < 2000, "a network failure must settle immediately, not stall");
    assert.deepEqual(agent.injected, []);

    const denied = await handlers.get("tools/pre-execute")({
      name: "mcp__openviking__search",
      arguments: { query: "x" },
      agent: { session: { id: agent.session.id } },
    }, async () => ({ kind: "allow" }));
    assert.equal(denied.kind, "deny");
    assert.match(denied.reason, /failed at stage "request"/, "a transport failure reads differently");
  } finally {
    restoreCredentials();
  }
});

// 方案 A's other half: a boot-time failure no longer needs a DSH restart. The
// first session that confirms mounts the bridge and the skill provider itself.
test("late activation: a failed boot lookup is recovered by the next session", async () => {
  const handlers = makeHandlers();
  let runtime;
  const mounted = [];
  const ctx = {
    logger: { debug() {} },
    provide(name, value) {
      if (name === "openvikingMemory") runtime = value;
    },
    effect(execute) {
      execute();
      return async () => {};
    },
    plugin: (plugin, config) => mounted.push({ name: plugin.name, config }),
    tools: { register() {} },
    on: handlers.on,
  };

  // Call 1 (boot) has no connection in it; call 2 (the first session) succeeds.
  const restoreCredentials = installStoredCredentials({
    responses: [
      { body: {} },
      { body: { OPENVIKING_URL: TEST_CONNECTION.url, OPENVIKING_API_KEY: TEST_CONNECTION.apiKey } },
    ],
  });
  try {
    assert.equal(await apply(ctx, { endpoint: "http://127.0.0.1:1933", workspacePeer: false }), false);
    assert.deepEqual(mounted, [], "nothing mounted while the lookup fails");

    runtime.initializeState = async state => {
      state.profileBlock = "profile";
      state.ready = true;
      return state;
    };
    const agent = startupAgent("dsh-late");
    await handlers.get("agent/created")({ agent, source: "startup", signal: new AbortController().signal });

    assert.deepEqual(mounted.map(entry => entry.name).sort(), ["mcp-client", "skill-filesystem"]);
    assert.equal(agent.injected.length, 1, "the confirming session is usable");
    runtime.stopDrainer();
  } finally {
    restoreCredentials();
  }
});

// The whole point of routing the connection through the storage lookup: a
// machine that cannot resolve one gets no tool surface, no skills, and no
// session state — not a bundle that quietly reaches some other server.
test("a failed credential lookup activates nothing", async () => {
  const handlers = makeHandlers();
  let runtime;
  const mounted = [];
  const registered = [];
  const ctx = {
    logger: { debug() {} },
    provide(name, value) {
      if (name === "openvikingMemory") runtime = value;
    },
    effect(execute) {
      execute();
      return async () => {};
    },
    plugin: (plugin, config) => mounted.push({ name: plugin.name, config }),
    tools: { register: definition => registered.push(definition) },
    on: handlers.on,
  };

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    calls.push(String(url));
    return response({});
  };
  // A 200 with no connection in it: the endpoint answered, this key has nothing
  // stored. Measured against the live endpoint, this is exactly what a wrong or
  // unknown `AIFE_API_KEY` produces (`stage: "response"`, `status: 200`), so this
  // test models "someone pasted the wrong key", not just a hypothetical.
  const restoreCredentials = installStoredCredentials({ body: {} });

  try {
    assert.equal(await apply(ctx, { endpoint: "http://127.0.0.1:1933", workspacePeer: false }), false);

    assert.deepEqual(mounted, [], "no MCP bridge and no skills provider");
    assert.deepEqual(registered, []);
    assert.deepEqual(calls, [], "nothing reached the OpenViking server");

    // Listeners stay registered but inert, including the serial startup path.
    const agent = startupAgent("dsh-no-credentials");
    assert.equal(
      await handlers.get("agent/created")({ agent, source: "startup", signal: new AbortController().signal }),
      undefined,
    );
    assert.deepEqual(agent.injected, []);
    // The teardown hook is registered before the lookup so cleanup can never be
    // skipped; on its own it is inert, because no session state was ever created.
    assert.deepEqual(agent.effects, ["openvikingMemory.disposeSession()"]);
    handlers.get("session/event")(
      { id: "no-credentials", header: { cwd: "/workspace" } },
      { type: "user/message", data: message("Remember this despite no connection.") },
    );
    assert.equal(runtime.states.has("no-credentials"), false);
    assert.deepEqual(calls, [], "a captured message must not reach any server");
  } finally {
    restoreCredentials();
    globalThis.fetch = originalFetch;
  }
});

function message(text) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

function response(result, status = 200) {
  return new Response(JSON.stringify({
    status: status < 400 ? "ok" : "error",
    ...(status < 400 ? { result } : { error: { code: "NOT_FOUND" } }),
  }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
