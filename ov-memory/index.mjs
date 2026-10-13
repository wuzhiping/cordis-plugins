import { OpenVikingClient } from "./client.mjs";
import { MCP_SERVER_NAME, resolveConfig } from "./config.mjs";
import { injectStartupProfile } from "./lifecycle.mjs";
import { mountOpenVikingMcp } from "./mcp.mjs";
import { OpenVikingRuntime } from "./runtime.mjs";
import { mountOpenVikingSkills } from "./skills.mjs";
import { fetchStoredConnection } from "./stored-credentials.mjs";
import { guardVikingUri, noticeVikingUri } from "./uri-guard.mjs";

export const name = "openviking-memory";
export const inject = ["agents", "sessions", "tools"];

/** Model-facing names of the bridged tools, which the session gate has to know. */
const BRIDGED_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/**
 * How long a per-session confirmation may take before it counts as failed.
 *
 * Shorter than the boot lookup's budget on purpose: this runs inside the serial
 * `agent/created` dispatch, which holds the new session's queued input until its
 * listeners settle, so a dead storage endpoint must not stall a new session for
 * the full eight seconds. A confirmation that times out is retried by simply
 * starting another session.
 */
const CONFIRM_TIMEOUT_MS = 3000;

export function apply(ctx, input = {}) {
  // Behaviour knobs (recall budgets, capture rules, peer settings) resolve as
  // always. Connection facts do not: `endpoint`/`baseUrl`/`apiKey` are replaced
  // by the BDD storage lookup below, and nothing may reach the server — or latch
  // a pending write — until that lookup has produced both values.
  const config = resolveConfig(input);
  const runtime = new OpenVikingRuntime(
    // A placeholder client: `createOvHttp` freezes the base URL at construction,
    // so the real one is built once a lookup answers.
    new OpenVikingClient(config),
    config,
    ctx.logger,
    cwd => (
      // Rebuild from the host input, not the config already merged for boot's cwd.
      // The shared loader preserves host/env precedence over workspace peers.
      resolveConfig(input, process.env, cwd).effectivePeer
    ),
  );

  /** Whether the MCP bridge and the skill provider have been mounted. */
  let active = false;
  /**
   * Sessions whose mask-key confirmation succeeded in this process.
   *
   * Default-deny: every listener asks this set, so a session that never confirmed
   * — because the lookup failed, or because it has not run yet — gets no memory
   * behaviour and no bridged tool calls. Confirmation is refreshed per session, so
   * a credential change takes effect on the next session instead of the next
   * process.
   */
  const confirmed = new Set();
  /** Last failure per session, quoted in the tool guard's denial. */
  const refusals = new Map();
  const idOf = session => String(session?.id ?? "");
  const usable = session => active && confirmed.has(idOf(session));

  const skipMemory = session => (
    config.skipSubagentSessions && session?.header?.origin === "subagent"
  );

  // Registration stays synchronous on purpose: the lookups are asynchronous, and
  // a listener registered in their continuation would miss the events that arrive
  // while they are in flight.
  ctx.provide("openvikingMemory", runtime);
  ctx.effect(
    () => () => runtime.disposeAll(),
    "openvikingMemory.disposeAll()",
  );
  ctx.effect(
    () => () => runtime.stopDrainer(),
    "openvikingMemory.stopDrainer()",
  );

  // Per-agent startup: confirm the connection for this session, register the
  // session's disposal commit, initialize the OpenViking session, and inject the
  // profile while the agent is still idle. Runs at most once per agent, whichever
  // DSH event reaches it.
  const started = new WeakSet();
  const startAgent = async (agent, signal) => {
    if (skipMemory(agent.session) || started.has(agent)) return false;
    started.add(agent);
    const sessionId = idOf(agent.session);
    agent.ctx.effect(
      () => () => {
        confirmed.delete(sessionId);
        refusals.delete(sessionId);
        runtime.dispose(agent.session);
      },
      "openvikingMemory.disposeSession()",
    );
    try {
      if (!(await confirmSession(agent.session))) return false;
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
    if (source === undefined) return undefined;
    await untilAborted(startAgent(agent, signal), signal);
    return undefined;
  });
  ctx.on("agent/session-start", ({ agent }) => startAgent(agent));

  // prepend: downstream waterfall listeners run first, so this plugin sees
  // the final claimed batch and appends after every other contributor.
  // Profile + recall are independent after `next()`; run them concurrently so
  // the agent/pre-step waterfall (which currently gates user/message push in
  // dsh-agent-loop) spends less wall time (#4515).
  ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    const decision = await next();
    if (!usable(agent.session) || skipMemory(agent.session)) return decision;
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
    if (!usable(session) || skipMemory(session)) return;
    runtime.capture(session, event);
    runtime.maybeCommit(session, event);
  });

  ctx.on("session/flush", async session => {
    if (!usable(session) || skipMemory(session)) return;
    await runtime.flush(session);
  });

  // The bridge and the skill provider mount once per process, so a session the
  // confirmation refused cannot be rid of them — it is refused at call time
  // instead. `tools/pre-execute` is agent-scoped, so this sees only the calling
  // session. The URI guard needs no server and stays unconditional.
  ctx.on("tools/pre-execute", guardUnconfirmedBridgedTool);
  ctx.on("tools/pre-execute", guardVikingUri);
  ctx.on("tools/post-execute", noticeVikingUri);

  // The boot lookup decides whether anything is mounted before the first session
  // exists; every session then re-confirms (below). The returned promise resolves
  // once activation has been decided, so a host that awaits plugin startup sees
  // the same outcome this function does.
  return activate();

  function guardUnconfirmedBridgedTool(exec, next) {
    if (!exec?.name?.startsWith(BRIDGED_TOOL_PREFIX)) return next();
    // The contract guarantees only `agent.id`; the live object also carries the
    // session, and which shape arrives has changed between DSH releases.
    const sessionId = String(exec.agent?.session?.id ?? exec.agent?.id ?? "");
    if (sessionId !== "" && usable({ id: sessionId })) return next();

    const refusal = refusals.get(sessionId);
    return { kind: "deny", reason: refusalReason(refusal) };
  }

  /**
   * What the model is told when a bridged call is refused.
   *
   * "The endpoint answered with no stored connection" is a *state*, not a fault:
   * an operator can disable memory for a machine by removing that record, and an
   * unknown key produces exactly the same answer. Saying "check your credential"
   * for both would send the reader after the wrong thing, so the two are worded
   * apart — and the empty case never claims the key is wrong.
   */
  function refusalReason(refusal) {
    if (refusal?.empty) {
      return "OpenViking memory is not enabled for this machine: the storage lookup "
        + "returned no stored connection for this credential. If that is not intended, "
        + "check refs.AIFE_API_KEY and the /BDD/API/AI/dsh/storage/ov record, then start "
        + "a new session; the connection is re-checked for every session.";
    }
    if (!refusal) {
      return "OpenViking is not available in this session: the mask-key lookup has not "
        + "succeeded. Start a new session to retry.";
    }
    return "OpenViking is not available in this session: the mask-key lookup failed at "
      + `stage "${refusal.stage}"`
      + `${refusal.status ? ` (HTTP ${refusal.status})` : ""}`
      + `${refusal.error ? `: ${refusal.error}` : ""}. `
      + "Start a new session to retry, or ask the operator to check "
      + "refs.AIFE_API_KEY and the storage endpoint.";
  }

  /**
   * Confirm the connection for one session, then make sure the bundle is mounted.
   *
   * The lookup is the only source of the connection, so it is re-asked per session
   * rather than trusted from process start: a rotated key or a re-pointed endpoint
   * takes effect on the next session, and the CLI does not have to be restarted.
   */
  async function confirmSession(session) {
    const sessionId = idOf(session);
    const credentials = await fetchStoredConnection({ timeoutMs: CONFIRM_TIMEOUT_MS });

    if (!credentials.ok) {
      confirmed.delete(sessionId);
      refusals.set(sessionId, {
        stage: credentials.stage,
        status: credentials.status,
        error: credentials.error,
        empty: credentials.empty === true,
      });
      ctx.logger?.debug?.(`[openviking:dsh] credentials_unavailable ${JSON.stringify({
        sessionId,
        stage: credentials.stage,
        status: credentials.status,
        error: credentials.error,
      })}`);
      return false;
    }

    confirmed.add(sessionId);
    refusals.delete(sessionId);
    applyConnection(credentials);
    mount();
    ctx.logger?.debug?.(`[openviking:dsh] credentials_resolved ${JSON.stringify({
      sessionId,
      ref: credentials.ref,
      endpoint: credentials.url,
    })}`);
    return true;
  }

  /** Point the bundle at a resolved connection, client included. */
  function applyConnection(credentials) {
    config.endpoint = credentials.url;
    config.baseUrl = credentials.url;
    config.apiKey = credentials.apiKey;
    // `createOvHttp` froze the base URL when the previous client was built, so a
    // resolved connection needs a client built after the lookup.
    runtime.client = new OpenVikingClient(config);
  }

  /**
   * Mount the halves that need a server. Called at boot when the lookup answers,
   * and again from the first session that confirms after a boot-time failure —
   * which is what lets a fixed credential file take effect without a restart.
   * Mounting twice would double the tool surface and the skill provider, so it
   * happens once.
   */
  function mount() {
    if (active) return;
    // The pending-queue drainer is the in-process recovery path: without it a
    // single transient write failure latches capture/commit until the next dsh
    // restart. Started here, so every session shares one single-flight drainer,
    // and only once there is a server to drain to.
    runtime.startDrainer();
    active = true;
    // Mounted last, and deliberately not awaited: the bridge's apply blocks on
    // its first tools/list, so a server that accepts the connection but never
    // answers would otherwise hold up every registration above it.
    mountOpenVikingMcp(ctx, config);
    mountOpenVikingSkills(ctx);
  }

  /** The boot lookup: decides the composition before any session exists. */
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

    applyConnection(credentials);
    mount();
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
