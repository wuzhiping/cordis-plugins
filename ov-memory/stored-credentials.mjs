/**
 * Where this bundle's connection comes from.
 *
 * The profile patch and the process environment are deliberately **not** trusted
 * for connection facts: `OPENVIKING_URL` / `OPENVIKING_API_KEY` are not read from
 * either. Both come from one lookup against the BDD storage API, authenticated
 * by this machine's own `AIFE_API_KEY`, masked per `MASK.md`. If the lookup does
 * not yield both values, the bundle stays inert — no MCP tool surface, no skills,
 * and no recall or capture (index.mjs).
 *
 * Why the mask travels at all: the storage endpoint identifies the caller by the
 * masked key it receives, so there is no second secret to configure. `MASK.md`
 * is explicit that this makes the value a credential in transit, which is why
 * `requireStorageUrl` refuses any host other than `abc.feg.com.tw`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The only host a masked `apiKey` may be sent to (`MASK.md`, "Domain boundary"). */
export const STORAGE_HOST = "abc.feg.com.tw";

/** Where this bundle's endpoint and key are stored. */
export const DEFAULT_STORAGE_URL = `https://${STORAGE_HOST}/BDD/API/AI/dsh/storage/ov`;

/**
 * Credential refs to try, in priority order.
 *
 * `AIFE_API_KEY` first because that is what this machine's credential file
 * actually holds, and because the masking test on the sibling `/storage/ntfy`
 * endpoint measured a difference: the AIFE key resolves to stored data, a
 * `FEG_API_KEY` of the same shape comes back `200 {}` (well-formed, no data).
 * The rest are fallbacks for other machines; order is tried, not guessed.
 */
export const CREDENTIAL_REFS = ["AIFE_API_KEY", "FEG_API_KEY", "DEEPSEEK_API_KEY"];

/** Field names the storage endpoint is expected to return. */
export const URL_FIELD = "OPENVIKING_URL";
export const KEY_FIELD = "OPENVIKING_API_KEY";

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Locate the DSH credential file: `DSH_CREDENTIALS_PATH` (tests, and moving the
 * file) → `$DSH_HOME/.credentials.yaml` → `$HOME/.dsh/.credentials.yaml`.
 */
export function credentialsFilePath(env = process.env) {
  const override = env.DSH_CREDENTIALS_PATH;
  if (typeof override === "string" && override.trim() !== "") return override.trim();
  const home = env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, ".credentials.yaml");
}

/**
 * Read `refs.<name>` out of a DSH credential file.
 *
 * A hand-rolled reader rather than a YAML dependency: DSH writes this file, its
 * shape is fixed (`refs:` with two-space-indented `name: value`), and this bundle
 * has no runtime dependencies. Anything it cannot recognise returns null, and the
 * caller reports that as a readable failure.
 */
export function readCredentialRef(text, name) {
  if (typeof text !== "string" || typeof name !== "string" || name === "") return null;
  let inRefs = false;
  let refsIndent = -1;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (/^refs:\s*$/.test(trimmed)) {
      inRefs = true;
      refsIndent = indent;
      continue;
    }
    if (!inRefs) continue;
    if (indent <= refsIndent) { inRefs = false; continue; }   // refs block ended

    const match = trimmed.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match || match[1] !== name) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value === "" ? null : value;
  }
  return null;
}

/**
 * Mask a key the way the storage endpoint expects.
 *
 * `sk-` + base64(key + "@" + ISO), the 71-character form — the shape measured
 * against the live endpoint family. (`MASK.md` documents a 67-character variant
 * that strips the inner `sk-` and says the 71-character form is rejected with
 * `500 找不到用户`; the control call to `/storage/ntfy` contradicts that for this
 * endpoint family: the 71-character form returned real stored data. Keep this
 * shape unless a measurement says otherwise.)
 */
export function maskKey(key, now = new Date()) {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("maskKey: key must be a non-empty string");
  }
  const stamp = `@${(now instanceof Date ? now : new Date(now)).toISOString()}`;
  return `sk-${Buffer.from(key + stamp, "utf8").toString("base64")}`;
}

/**
 * Read the first present credential ref and mask it.
 *
 * @returns `{ ok: true, masked, ref, source }`, or `{ ok: false, stage: "credential", error }`.
 */
export function readMaskedCredential({
  env = process.env,
  now = new Date(),
  refs = CREDENTIAL_REFS,
  readFile = readFileSync,
} = {}) {
  const file = credentialsFilePath(env);

  let text;
  try {
    text = readFile(file, "utf8");
  } catch (error) {
    return {
      ok: false,
      stage: "credential",
      error: `cannot read the credential file (${file}): ${error?.message || error}`,
    };
  }

  for (const ref of refs) {
    const key = readCredentialRef(text, ref);
    if (!key) continue;
    try {
      return { ok: true, masked: maskKey(key, now), ref, source: file };
    } catch (error) {
      return { ok: false, stage: "credential", error: `cannot mask refs.${ref}: ${error?.message || error}` };
    }
  }

  return {
    ok: false,
    stage: "credential",
    error: `no usable key in ${file} (tried ${refs.join(", ")})`,
  };
}

/**
 * Refuse any storage URL that would send the masked key somewhere other than
 * `abc.feg.com.tw`. Returns the normalised URL, or throws.
 */
export function requireStorageUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`storage URL is not a URL: ${url}`);
  }
  if (parsed.protocol !== "https:") throw new Error(`storage URL must be https: ${url}`);
  if (parsed.hostname !== STORAGE_HOST) {
    throw new Error(
      `refusing to send a masked key to ${parsed.hostname}: only ${STORAGE_HOST} may receive it`,
    );
  }
  return url;
}

/**
 * Pull the connection out of a storage response.
 *
 * Field names are the two the endpoint is asked for. When they are absent the
 * error names the keys that did arrive, because the measured failure mode of
 * this endpoint family is a `200` with an empty body — "well-formed request, no
 * stored data" — which otherwise looks exactly like success.
 */
export function extractStoredConnection(payload) {
  const read = field => (typeof payload?.[field] === "string" ? payload[field].trim() : "");
  const url = read(URL_FIELD);
  const apiKey = read(KEY_FIELD);
  const keys = payload && typeof payload === "object" ? Object.keys(payload) : [];

  if (!url || !apiKey) {
    return {
      ok: false,
      stage: "response",
      error: `storage response carries no ${[url ? null : URL_FIELD, apiKey ? null : KEY_FIELD].filter(Boolean).join(" and ")}`
        + ` (received: ${keys.length > 0 ? keys.join(", ") : "no fields"})`,
    };
  }
  if (!/^https?:\/\//.test(url)) {
    return { ok: false, stage: "response", error: `${URL_FIELD} is not an http(s) URL: ${url}` };
  }
  return { ok: true, url: url.replace(/\/+$/, ""), apiKey };
}

/**
 * Resolve the OpenViking connection through the storage API.
 *
 * Never throws: the caller distinguishes failures by `stage` —
 *
 * - `config`     — the storage URL itself is unusable (or not `abc.feg.com.tw`)
 * - `credential` — no readable `AIFE_API_KEY` in the credential file
 * - `request`    — the lookup could not be made, or the endpoint rejected it
 *                  (measured: `500` means the request shape was refused)
 * - `response`   — the endpoint answered, but without a usable connection
 *
 * @returns `{ ok: true, url, apiKey, ref }` or `{ ok: false, stage, error, status? }`.
 */
export async function fetchStoredConnection({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  storageUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  readFile = readFileSync,
} = {}) {
  const requested = storageUrl || env.OPENVIKING_STORAGE_URL || DEFAULT_STORAGE_URL;
  let url;
  try {
    url = requireStorageUrl(requested);
  } catch (error) {
    return { ok: false, stage: "config", error: error.message };
  }

  const credential = readMaskedCredential({ env, now, readFile });
  if (!credential.ok) return credential;

  if (typeof fetchImpl !== "function") {
    return { ok: false, stage: "request", error: "no fetch implementation available" };
  }

  let response;
  let raw;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: credential.masked }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    raw = await response.text();
  } catch (error) {
    return {
      ok: false,
      stage: "request",
      status: 0,
      error: `storage lookup failed: ${error?.message || error}`,
    };
  }

  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }

  if (response.status === 500) {
    const detail = typeof payload?.error === "string" ? `: ${payload.error}` : "";
    return {
      ok: false,
      stage: "request",
      status: 500,
      error: `the storage endpoint rejected the request (HTTP 500)${detail}`,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      stage: "request",
      status: response.status,
      error: `the storage endpoint returned HTTP ${response.status}`,
    };
  }
  if (!payload || typeof payload !== "object") {
    return {
      ok: false,
      stage: "response",
      status: response.status,
      error: "the storage endpoint did not return JSON",
    };
  }

  const connection = extractStoredConnection(payload);
  return connection.ok
    ? { ...connection, ref: credential.ref, source: credential.source }
    : { ...connection, status: response.status, ref: credential.ref };
}
