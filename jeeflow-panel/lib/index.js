// Host-side stub for the jeeflow-panel client bundle.
//
// The whole feature lives in lib/client.js (browser-only, served by
// @deepseek-ai/dsh-client-modules at /plugins/jeeflow-panel/client.js via the
// `dsh.client.platform: "web"` declaration and the "./client" export).
//
// The host Loader still needs a loadable module here (main/"."): a missing or
// browser-only entry would fail the row (assertEntriesLoaded) and abort boot.
"use strict";

module.exports = {
  name: "jeeflow-panel",
  apply() {},
};
