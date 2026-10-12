import { OpenVikingClient } from "./client.mjs";
import { resolveConfig } from "./config.mjs";
import { injectStartupProfile } from "./lifecycle.mjs";
import { mountOpenVikingMcp } from "./mcp.mjs";
import { OpenVikingRuntime } from "./runtime.mjs";
import { mountOpenVikingSkills } from "./skills.mjs";
import { fetchStoredConnection } from "./stored-credentials.mjs";
import { guardVikingUri, noticeVikingUri } from "./uri-guard.mjs";

export const name = "openviking-memory";
export const inject = ["agents", "sessions", "tools"];

export function apply(ctx, input = {}) {
  // Behaviour knobs (recall budgets, capture rules, peer settings) resolve as
  // always. Connection facts do not: `endpoint`/`baseUrl`/`apiKey` are replaced
  // below by the BDD storage lookup, and nothing may reach the server — or latch
  // a pending write — until that lookup has produced both values.
  const config = resolveConfig(input);
  const runtime = new OpenVikingRuntime(
    // A placeholder client: `createOvHttp` freezes the base URL at construction,
    // so the real one is built once the lookup answers. Until then `active` is
    // false and nothing calls into it.
    new OpenVikingClient(config),
    config,
    ctx.logger,
    cwd => (
      // Rebuild from the host input, not the config already merged for boot's cwd.
      // The shared loader preserves host/env precedence over workspace peers.
      resolveConfig(input, process.env, cwd).effectivePeer
    ),
  );
  let active = false;
  const skipMemory = session => (
    config.skipSubagentSessions && session?.header?.origin === "subagent"
  );

  // Registration stays synchronous on purpose: the credential lookup is
  // asynchronous, and a listener registered in its continuation would miss the
  // events that arrive while it is in flight.
  ctx.provide("openvikingMemory", runtime);
  ctx.effect(
    () => () => runtime.disposeAll(),
    "openvikingMemory.disposeAll()",
  );
  ctx.effect(
    () => () => runtime.stopDrainer(),
    "openvikingMemory.stopDrainer()",
  );

  // Per-agent startup: register the session's disposal commit, initialize the
  // OpenViking session, and inject the profile while the agent is still idle.
  // Runs at most once per agent, whichever DSH event reaches it.
  const started = new WeakSet();
  const startAgent = async (agent, signal) => {
    if (!active || skipMemory(agent.session) || started.has(agent)) return false;
    started.add(agent);
    agent.ctx.effect(
      () => () => runtime.dispose(agent.session),
      "openvikingMemory.disposeSession()",
    );
    try {
      return await injectStartupProfile(agent, runtime, signal);
    } catch (error) {
      // A throw from a serial `agent/created` listener fails agent creation;
      // memory startup must never do that. pre-step retries profile delivery.
      runtime.log("startup_error", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  // DSH 0.1.7+ has no `agent/session-start`; startup is the serial
  // `agent/created` event with `{ agent, source, signal? }`, and AgentLoop holds
  // queued input until its listeners settle. DSH 0.1.0-rc.6 and 0.1.5 still
  // emit a composition-only `agent/created` with `{ agent }` only, followed by
  // `agent/session-start`, so a missing `source` leaves startup to that event.
  // The listener must resolve to undefined: any other value bails the serial
  // dispatch and skips the listeners registered after this one.
  ctx.on("agent/created", async ({ agent, source, signal }) => {
    if (source === undefined || !active) return undefined;
    await untilAborted(startAgent(agent, signal), signal);
    return undefined;
  });
  ctx.on("agent/session-start", ({ agent }) => (active ? startAgent(agent) : false));

  // prepend: downstream waterfall listeners run first, so this plugin sees
  // the final claimed batch and appends after every other contributor.
  // Profile + recall are independent after `next()`; run them concurrently so
  // the agent/pre-step waterfall (which currently gates user/message push in
  // dsh-agent-loop) spends less wall time (#4515).
  ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    const decision = await next();
    if (!active || skipMemory(agent.session)) return decision;
    if (decision.kind !== "enter" || signal.aborted) return decision;
    const [profile, recall] = await Promise.all([
      runtime.profileMessage(agent),
      runtime.recallMessage(agent, decision.messages),
    ]);
    if (signal.aborted) return decision;
    const additions = [profile, recall].filter(Boolean);
    return additions.length > 0
      ? { kind: "enter", messages: [...decision.messages, ...additions] }
      : decision;
  }, { prepend: true });

  ctx.on("session/event", (session, event) => {
    if (!active || skipMemory(session)) return;
    runtime.capture(session, event);
    runtime.maybeCommit(session, event);
  });

  ctx.on("session/flush", async session => {
    if (!active || skipMemory(session)) return;
    await runtime.flush(session);
  });

  // The URI guard needs no server: it only stops the model from handing a
  // `viking://` path to a filesystem tool, which is wrong whether or not this
  // bundle reached the server.
  ctx.on("tools/pre-execute", guardVikingUri);
  ctx.on("tools/post-execute", noticeVikingUri);

  // Resolved in the background because `apply` cannot await. The returned promise
  // resolves once activation has been decided, so a host that awaits plugin
  // startup sees the same outcome this function does.
  return activate();

  /**
   * Resolve the connection, then bring up the halves that need a server.
   *
   * A failure here is not an error the host should surface as a broken plugin:
   * it is the designed state for a machine without a stored Open Viking
   * connection. Nothing is mounted, all listeners stay inert, and the reason is
   * logged with the stage that failed.
   */
  async function activate() {
    const credentials = await fetchStoredConnection();

    if (!credentials.ok) {
      ctx.logger?.debug?.(`[openviking:dsh] credentials_unavailable ${JSON.stringify({
        stage: credentials.stage,
        status: credentials.status,
        error: credentials.error,
      })}`);
      return false;
    }

    config.endpoint = credentials.url;
    config.baseUrl = credentials.url;
    config.apiKey = credentials.apiKey;
    runtime.client = new OpenVikingClient(config);
    // The pending-queue drainer is the in-process recovery path: without it a
    // single transient write failure latches capture/commit until the next dsh
    // restart. Started here so every session shares one single-flight drainer,
    // and only once there is a server to drain to.
    runtime.startDrainer();
    active = true;

    // Mounted last, and deliberately not awaited: the bridge's apply blocks on
    // its first tools/list, so a server that accepts the connection but never
    // answers would otherwise hold up every registration above it.
    mountOpenVikingMcp(ctx, config);
    mountOpenVikingSkills(ctx);
    ctx.logger?.debug?.(`[openviking:dsh] credentials_resolved ${JSON.stringify({
      ref: credentials.ref,
      endpoint: credentials.url,
    })}`);
    return true;
  }
}

// Resolve when `promise` settles or `signal` aborts, whichever comes first. An
// abandoned initialization keeps running and is reused by the pre-step path.
function untilAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.finally(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}
