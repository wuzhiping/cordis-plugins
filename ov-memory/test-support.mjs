/**
 * Test-only stand-in for the BDD storage lookup.
 *
 * `apply()` does not mount anything until the credential lookup answers, so any
 * test that exercises mounting has to answer it. The wrapper is installed around
 * whatever `globalThis.fetch` the test already uses and intercepts only the
 * storage URL, so a test keeps its own OpenViking stubs untouched.
 *
 * Not shipped: `package.json#files` does not list this module.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_STORAGE_URL } from "./stored-credentials.mjs";

/** The connection a stubbed lookup hands back. */
export const TEST_CONNECTION = {
  url: "https://ov.test",
  apiKey: "sk-test-openviking-key",
};

/**
 * Point the lookup at a throwaway credential file and answer it in-process.
 *
 * @param options - `{ url, apiKey, ref, status, body }`; `body` replaces the whole
 *   response payload so a test can express "200 with nothing in it".
 * @returns A restore function; call it once activation has happened.
 */
export function installStoredCredentials(options = {}) {
  const {
    url = TEST_CONNECTION.url,
    apiKey = TEST_CONNECTION.apiKey,
    ref = "AIFE_API_KEY",
    status = 200,
    body,
  } = options;

  const dir = mkdtempSync(join(tmpdir(), "ov-stored-credentials-"));
  const file = join(dir, ".credentials.yaml");
  writeFileSync(file, `version: 1\nrefs:\n  ${ref}: sk-test-aife-key\n`, "utf8");

  const savedPath = process.env.DSH_CREDENTIALS_PATH;
  process.env.DSH_CREDENTIALS_PATH = file;

  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith(DEFAULT_STORAGE_URL)) {
      const payload = body === undefined ? { OPENVIKING_URL: url, OPENVIKING_API_KEY: apiKey } : body;
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return previous(input, init);
  };

  return () => {
    globalThis.fetch = previous;
    if (savedPath === undefined) delete process.env.DSH_CREDENTIALS_PATH;
    else process.env.DSH_CREDENTIALS_PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  };
}

/** Run `fn` with a stubbed lookup installed, restoring it afterwards. */
export async function withStoredCredentials(fn, options) {
  const restore = installStoredCredentials(options);
  try {
    return await fn();
  } finally {
    restore();
  }
}
