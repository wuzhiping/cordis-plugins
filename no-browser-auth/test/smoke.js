// Dependency-free smoke test for the no-browser-auth bundle host half.
//
// It runs the real lib/index.js against a stand-in for the Web transport that
// reproduces the two call sites DSH actually uses:
//
//   connection.requestRejection(request)  — fence first, then the session check
//   connection.authorizeIndex(req, res)   — the session check alone
//
// and asserts that the bypass installs, that the Host/Origin fence still
// rejects, and that stopping the plugin restores the original methods.
//
// Run: node test/smoke.js   (or: npm test)
"use strict";

const assert = require("node:assert/strict");
const plugin = require("../lib/index.js");

/** The shipped `browserAuth` contract, in its authenticated state. */
function fakeBrowserAuth() {
  return {
    isAuthenticated() {
      return false;
    },
    authorizeIndex() {
      return false;
    },
  };
}

/** A stand-in HostConnectionService with the shipped call structure. */
function fakeConnection(isTrustedRequest) {
  return {
    browserAuth: fakeBrowserAuth(),
    requestRejection(request) {
      if (!isTrustedRequest(request)) return 403;
      return this.browserAuth.isAuthenticated(request) ? undefined : 401;
    },
    authorizeIndex(request, response) {
      return this.browserAuth.authorizeIndex(request, response);
    },
  };
}

/** A minimal Cordis context: `connection` plus a recording `ctx.effect`. */
function fakeContext(connection) {
  const ctx = {
    connection,
    disposers: [],
    effect(callback) {
      ctx.disposers.push(callback());
    },
  };
  return ctx;
}

const trusted = () => true;
const untrusted = () => false;

// --- before install: the shipped behaviour ---------------------------------
{
  const connection = fakeConnection(trusted);
  assert.equal(connection.requestRejection({}), 401, "an anonymous /api request is rejected");
  assert.equal(connection.authorizeIndex({}, {}), false, "an anonymous index request is not served");
}

// --- installing the bypass ------------------------------------------------
const connection = fakeConnection(trusted);
const originalIsAuthenticated = connection.browserAuth.isAuthenticated;
const originalAuthorizeIndex = connection.browserAuth.authorizeIndex;
const ctx = fakeContext(connection);
plugin.apply(ctx);

assert.equal(typeof plugin.name, "string");
assert.deepEqual(plugin.inject, ["connection"]);
assert.equal(ctx.disposers.length, 1, "the bypass registered exactly one effect");

// --- session check is gone ------------------------------------------------
assert.equal(connection.requestRejection({}), undefined, "an anonymous /api request now passes");
assert.equal(connection.authorizeIndex({}, {}), true, "an anonymous index request is now served");

// --- the Host/Origin fence is NOT gone ------------------------------------
assert.equal(fakeConnection(untrusted).requestRejection({}), 403, "the fence still rejects by itself");
{
  const fenced = fakeConnection(untrusted);
  const fencedCtx = fakeContext(fenced);
  plugin.apply(fencedCtx);
  assert.equal(fenced.requestRejection({}), 403, "the fence still rejects with the bypass installed");
  assert.equal(fenced.authorizeIndex({}, {}), true, "index serving is still bypassed");
  for (const dispose of fencedCtx.disposers) dispose();
}

// --- missing transport stays safe -----------------------------------------
{
  const empty = { effect() { throw new Error("must not install without a transport"); } };
  assert.doesNotThrow(() => plugin.apply(empty), "a missing connection service is reported, not thrown");
}

// --- stopping the plugin restores the shipped behaviour -------------------
for (const dispose of ctx.disposers) dispose();

assert.equal(connection.browserAuth.isAuthenticated, originalIsAuthenticated, "isAuthenticated is restored");
assert.equal(connection.browserAuth.authorizeIndex, originalAuthorizeIndex, "authorizeIndex is restored");
assert.equal(connection.requestRejection({}), 401, "anonymous /api requests are rejected again");
assert.equal(connection.authorizeIndex({}, {}), false, "anonymous index requests are refused again");

console.log("no-browser-auth: smoke test passed");
