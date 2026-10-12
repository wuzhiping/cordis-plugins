import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CREDENTIAL_REFS,
  DEFAULT_STORAGE_URL,
  credentialsFilePath,
  extractStoredConnection,
  fetchStoredConnection,
  maskKey,
  readCredentialRef,
  readMaskedCredential,
  requireStorageUrl,
} from "./stored-credentials.mjs";

const PINNED = new Date("2026-01-01T00:00:00.000Z");
const STAMP = "@2026-01-01T00:00:00.000Z";

async function withCredentialsFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), "ov-credentials-"));
  const file = join(dir, ".credentials.yaml");
  writeFileSync(file, content, "utf8");
  try {
    return await fn({ file, dir, env: { DSH_CREDENTIALS_PATH: file } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function storageResponse(payload, status = 200) {
  return async () => new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("reads only the refs block, and strips quotes", () => {
  const text = [
    "version: 1",
    "refs:",
    "  AIFE_API_KEY: sk-AbC",
    "  OTHER: sk-Def",
    "other:",
    "  AIFE_API_KEY: not-this-one",
  ].join("\n");

  assert.equal(readCredentialRef(text, "AIFE_API_KEY"), "sk-AbC");
  assert.equal(readCredentialRef(text, "OTHER"), "sk-Def");
  assert.equal(readCredentialRef(text, "NOPE"), null);
  assert.equal(readCredentialRef('refs:\n  K: "sk-q"\n', "K"), "sk-q");
  assert.equal(readCredentialRef("refs:\n  K: 'sk-s'\n", "K"), "sk-s");
  assert.equal(readCredentialRef("refs:\n  K:\n", "K"), null);
  assert.equal(readCredentialRef("other:\n  K: x\n", "K"), null);
  assert.equal(readCredentialRef(null, "K"), null);
});

test("the credential file is DSH_HOME's, with the documented fallbacks", () => {
  assert.equal(
    credentialsFilePath({ DSH_CREDENTIALS_PATH: " C:\\tmp\\c.yaml " }),
    "C:\\tmp\\c.yaml",
  );
  assert.equal(
    credentialsFilePath({ DSH_HOME: "D:\\dsh" }),
    join("D:\\dsh", ".credentials.yaml"),
  );
  // No DSH_HOME in the environment is the case that silently reads the wrong
  // file: the fallback is the historical default, not a guess about this box.
  assert.match(credentialsFilePath({ HOME: "/home/x", USERPROFILE: "C:\\Users\\x" }), /\.credentials\.yaml$/);
});

test("maskKey matches the MASK.md formula and round-trips", () => {
  const key = "sk-ExampleKeyReplaceMe001";
  const masked = maskKey(key, PINNED);

  assert.equal(masked, `sk-${Buffer.from(key + STAMP, "utf8").toString("base64")}`);
  assert.equal(masked.length, 71, "a 25-character key masks to 71 characters");
  assert.equal(Buffer.from(masked.slice(3), "base64").toString("utf8"), key + STAMP);
  assert.throws(() => maskKey(""), /non-empty/);
  assert.throws(() => maskKey(null), /non-empty/);
});

test("readMaskedCredential prefers AIFE, then falls back in order", async () => {
  await withCredentialsFile("refs:\n  FEG_API_KEY: sk-feg\n  AIFE_API_KEY: sk-aife\n", ({ env }) => {
    const result = readMaskedCredential({ env, now: PINNED });
    assert.equal(result.ok, true);
    // Measured against the storage endpoint family: a FEG key of the right shape
    // comes back `200 {}`, so AIFE has to win when both are present.
    assert.equal(result.ref, "AIFE_API_KEY");
    assert.equal(result.masked, maskKey("sk-aife", PINNED));
    assert.equal(CREDENTIAL_REFS[0], "AIFE_API_KEY");
  });

  await withCredentialsFile("refs:\n  FEG_API_KEY: sk-feg\n", ({ env }) => {
    assert.equal(readMaskedCredential({ env, now: PINNED }).ref, "FEG_API_KEY");
  });
});

test("readMaskedCredential names the file and the refs it tried", async () => {
  const missing = readMaskedCredential({ env: { DSH_CREDENTIALS_PATH: join(tmpdir(), "ov-absent.yaml") } });
  assert.equal(missing.ok, false);
  assert.equal(missing.stage, "credential");
  assert.match(missing.error, /ov-absent\.yaml/);

  await withCredentialsFile("refs:\n  OTHER: sk-x\n", ({ env }) => {
    const empty = readMaskedCredential({ env });
    assert.equal(empty.stage, "credential");
    assert.match(empty.error, /AIFE_API_KEY/);
  });
});

test("a masked key may only travel to abc.feg.com.tw over https", () => {
  assert.equal(requireStorageUrl(DEFAULT_STORAGE_URL), DEFAULT_STORAGE_URL);
  assert.throws(() => requireStorageUrl("https://evil.example/ov"), /only abc\.feg\.com\.tw/);
  assert.throws(() => requireStorageUrl("http://abc.feg.com.tw/ov"), /must be https/);
  assert.throws(() => requireStorageUrl("not a url"), /not a URL/);
});

test("the storage response supplies both fields, or the failure names what arrived", () => {
  assert.deepEqual(extractStoredConnection({
    OPENVIKING_URL: "https://ov.example/",
    OPENVIKING_API_KEY: "key-1",
  }), { ok: true, url: "https://ov.example", apiKey: "key-1" });

  const empty = extractStoredConnection({});
  assert.equal(empty.ok, false);
  assert.equal(empty.stage, "response");
  assert.match(empty.error, /OPENVIKING_URL and OPENVIKING_API_KEY/);
  assert.match(empty.error, /no fields/);

  const partial = extractStoredConnection({ OPENVIKING_URL: "https://ov.example", name: "Jinbe" });
  assert.match(partial.error, /OPENVIKING_API_KEY/);
  assert.match(partial.error, /name/, "the error lists the keys that did arrive");

  assert.equal(extractStoredConnection({ OPENVIKING_URL: "ftp://x", OPENVIKING_API_KEY: "k" }).ok, false);
});

test("a successful lookup reports the URL, the key and the ref used", async () => {
  await withCredentialsFile("refs:\n  AIFE_API_KEY: sk-aife\n", async ({ env }) => {
    const result = await fetchStoredConnection({
      env,
      fetchImpl: storageResponse({ OPENVIKING_URL: "https://ov.example", OPENVIKING_API_KEY: "key-1" }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.url, "https://ov.example");
    assert.equal(result.apiKey, "key-1");
    assert.equal(result.ref, "AIFE_API_KEY");
  });
});

test("the lookup never sends the raw key, and sends the 71-character mask", async () => {
  // A 25-character key is the shape the 71-character figure assumes.
  const key = "sk-ExampleKeyReplaceMe001";
  await withCredentialsFile(`refs:\n  AIFE_API_KEY: ${key}\n`, async ({ env }) => {
    let seen;
    await fetchStoredConnection({
      env,
      now: PINNED,
      fetchImpl: async (url, init) => {
        seen = { url, body: JSON.parse(init.body) };
        return new Response(JSON.stringify({
          OPENVIKING_URL: "https://ov.example",
          OPENVIKING_API_KEY: "key-1",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });

    assert.equal(seen.url, DEFAULT_STORAGE_URL);
    assert.deepEqual(Object.keys(seen.body), ["apiKey"]);
    assert.equal(seen.body.apiKey, maskKey(key, PINNED));
    assert.equal(seen.body.apiKey.length, 71);
    assert.equal(JSON.stringify(seen.body).includes(key), false);
  });
});

// The endpoint family's measured failure modes, each mapped to a distinct stage
// so the log says which half failed: 500 = the request was refused, 200 {} =
// well-formed but this key has nothing stored.
test("failure stages: config, credential, request and response are distinct", async () => {
  const rejected = await fetchStoredConnection({
    env: { OPENVIKING_STORAGE_URL: "https://evil.example/ov", DSH_CREDENTIALS_PATH: "x" },
  });
  assert.equal(rejected.stage, "config");

  const noCredential = await fetchStoredConnection({
    env: { DSH_CREDENTIALS_PATH: join(tmpdir(), "ov-absent.yaml") },
    fetchImpl: storageResponse({}),
  });
  assert.equal(noCredential.stage, "credential");

  await withCredentialsFile("refs:\n  AIFE_API_KEY: sk-aife\n", async ({ env }) => {
    const refused = await fetchStoredConnection({
      env,
      fetchImpl: storageResponse({ error: "apikey无效" }, 500),
    });
    assert.equal(refused.stage, "request");
    assert.equal(refused.status, 500);
    assert.match(refused.error, /rejected the request/);

    const empty = await fetchStoredConnection({ env, fetchImpl: storageResponse({}) });
    assert.equal(empty.stage, "response");
    assert.equal(empty.status, 200);
    assert.match(empty.error, /carries no/);

    const notJson = await fetchStoredConnection({
      env,
      fetchImpl: async () => new Response("boom", { status: 200 }),
    });
    assert.equal(notJson.stage, "response");
    assert.match(notJson.error, /did not return JSON/);

    const down = await fetchStoredConnection({
      env,
      fetchImpl: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    });
    assert.equal(down.stage, "request");
    assert.equal(down.status, 0);
    assert.match(down.error, /ENOTFOUND/);
  });
});
