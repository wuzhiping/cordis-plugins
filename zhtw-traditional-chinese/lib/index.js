// Host-side stub for the zhtw-traditional-chinese client bundle.
// The real implementation is lib/client.js (browser-only, served by
// @deepseek-ai/dsh-client-modules at /plugins/zhtw-traditional-chinese/client.js
// via the dsh.client.platform: "web" declaration and the "./client" export).
// The host Loader still needs a loadable module here (main/"."): a missing or
// browser-only entry would fail the row (assertEntriesLoaded) and abort boot.
"use strict";
module.exports = {
	name: "zhtw-traditional-chinese",
	apply() {}
};