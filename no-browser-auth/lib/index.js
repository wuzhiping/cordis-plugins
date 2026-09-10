// Host entry for the no-browser-auth bundle.
//
// The Web transport authenticates browser requests in two independent halves:
//
//   1. the Host/Origin trust fence  — `isTrustedApiRequest()` in
//      @deepseek-ai/dsh-client-connection (loopback or a configured
//      `trustedHosts` authority, no `sec-fetch-site: cross-site`, and an
//      `Origin` matching `Host` when present);
//   2. the browser session          — `BrowserAuth` in the same package: a
//      process launch token (`?token=…`) exchanged once for a signed,
//      authority-bound, HttpOnly cookie, verified on every later request.
//
// Only the second half is disabled here. `HostConnectionService` is the sole
// reader of `BrowserAuth` — it owns an instance in its public `browserAuth`
// field and reaches it from exactly two places:
//
//   HostConnectionService#requestRejection(request)
//     → fence (403) → this.browserAuth.isAuthenticated(request) ? ok : 401
//   HostConnectionService#authorizeIndex(request, response)
//     → this.browserAuth.authorizeIndex(request, response)
//
// Every consumer calls those two methods *through the live `connection`
// service* (`ctx.connection.requestRejection(...)` in @deepseek-ai/dsh-api-gateway
// and in the connection plugin's own `/api` route; `ctx.connection.authorizeIndex(...)`
// in @deepseek-ai/dsh-host-frontend-static), so replacing the two methods on that
// instance's `browserAuth` object disables the session check for all of them at
// once, while the fence in `requestRejection` keeps running untouched.
"use strict";

/** Stable Cordis plugin name; also the package name and the patch row id. */
const name = "no-browser-auth";

/**
 * The transport service this bundle needs. Cordis parks the plugin until the
 * service exists and re-applies it if the service is ever re-provided, so the
 * patch never races the Client Connection row and never survives a reload of it.
 */
const inject = ["connection"];

/**
 * Install the session bypass on one `BrowserAuth` owner.
 * @param browserAuth - the live `connection.browserAuth` instance.
 * @param effect - the owning context's `ctx.effect` (registers the disposer).
 */
function installBypass(browserAuth, effect) {
  const original = {
    isAuthenticated: browserAuth.isAuthenticated,
    authorizeIndex: browserAuth.authorizeIndex,
  };
  effect(function bypassBrowserSession() {
    // `isAuthenticated` answers the /api fence: `true` means "no rejection".
    browserAuth.isAuthenticated = function isAuthenticated() {
      return true;
    };
    // `authorizeIndex` answers the index request: `true` means "serve index.html".
    browserAuth.authorizeIndex = function authorizeIndex() {
      return true;
    };
    console.log(
      "no-browser-auth: browser-session verification disabled; "
        + "the Host/Origin fence is unchanged",
    );
    return function restoreBrowserSession() {
      browserAuth.isAuthenticated = original.isAuthenticated;
      browserAuth.authorizeIndex = original.authorizeIndex;
      console.log("no-browser-auth: browser-session verification restored");
    };
  }, "no-browser-auth: bypass the browser session check");
}

/**
 * Mount the bypass on the live Client Connection transport.
 * @param ctx - the plugin's Cordis context, carrying `connection` via `inject`.
 */
function apply(ctx) {
  const connection = ctx.connection;
  const browserAuth = connection === undefined || connection === null
    ? undefined
    : connection.browserAuth;
  if (browserAuth === undefined || browserAuth === null) {
    console.error(
      "no-browser-auth: connection.browserAuth is unavailable; "
        + "browser-session verification stays enforced",
    );
    return;
  }
  installBypass(browserAuth, ctx.effect.bind(ctx));
}

module.exports = { name, inject, apply };
