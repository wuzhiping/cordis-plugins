// Host-side stub for the vi-VN client bundle.
//
// The real implementation is lib/client.js (browser-only, served by the client
// module group at /plugins/vi-VN/client.js through the dsh.client.platform
// "web" declaration and the "./client" export). The host Loader still needs a
// loadable module here (main / "."): a browser-only entry would fail the row
// (assertEntriesLoaded) and abort boot.
"use strict";

module.exports = {
	name: "vi-VN",
	apply() {}
};
