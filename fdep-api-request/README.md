# fdep-api-request-bundle

> DSH profile bundle that wraps the `fdep-api-request` skill: a model-facing `fdep_call` tool plus a sidebar panel with a parameter form.

The skill at `$DSH_HOME/skills/fdep-api-request/SKILL.md` remains the model-facing source of truth for the workflow. This bundle does not duplicate it — it only encodes the deterministic HTTP shape (URL, headers, JSON `{api, do, inbound}`) and the rule for splitting `data.docs` (everything except `desc` is an inbound parameter) so the model does not have to repeat either by hand.

## What you get

### Host side

A single tool `fdep_call` with three parameters:

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `api_id` | string | yes | FDEP API identifier, e.g. `test.demo`. |
| `mode` | `"docs" \| "execute"` | yes | `"docs"` fetches the schema; `"execute"` runs the call. |
| `inbound` | object | no | For `"docs"` pass `{}`. For `"execute"` pass one key per non-`desc` field returned by `"docs"`. Strings are accepted and parsed as JSON. |

The tool posts to `https://abc.feg.com.tw/oauth2/fdep` with `Content-Type: application/json` and the body shape from the skill. Results are normalised:

- `docs` mode returns `{api_id, desc, params, raw}` where `params` is `data.docs` minus `desc`.
- `execute` mode returns `{api_id, trace_id, data, inbound_sent}`.
- Failures return `{api_id, mode, error, upstream_status?, upstream_body?}` and never throw.

### Client side

A sidebar entry labelled **MCP Gateway**, marked with a green hexagon glyph, that opens a panel
titled **MCP Gateway**. The panel is a three-step flow — three numbered cards in order (1 → 2 → 3),
followed by the response and the fallback prompt:

1. **選擇 API** (Choose the API) — an API ID input (monospace) with **取得文件** (Fetch docs). Enter
   submits. The field starts prefilled with **`twseMops.todayMaterial`** (TWSE + TPEX 當日重大訊息),
   so the common case is one click; it stays editable for any other `api_id`.
2. **參數** (Parameters) — one control per non-`desc` field in the fetched docs, each labelled with
   the **type inferred from its example value** plus that example. Before the first fetch the card
   carries an empty-state hint; an API with no parameters says so instead of rendering an empty box.
3. **執行** (Run) — the primary action, plus **複製提示** (Copy prompt) and **開新工作階段**
   (New session). A response gets its own flush card with the `trace_id` and a copy button.
   Both fallbacks stay **disabled until 取得文件 succeeds** — everything they hand over *is* the
   docs. **開新工作階段** opens a blank session (the same action as the sidebar's 新工作階段) whose
   runtime context carries the api's docs — the host injects them, see *What the new session
   receives* — and it also puts the same **api brief** on the clipboard so the first message can
   say what to do (the brief is the fallback when the host route is unreachable).

**Language.** The panel's UI is **Traditional Chinese (zh-TW idiom)**, matching this profile's
`locale.preference: zh-TW` and the sibling `scene-template` bundle; the api ids, field names, types
and JSON stay verbatim because those are the wire contract. The same applies to the two pieces of
text the model receives: the clipboard brief and the injected runtime context.

### Field types come from the docs examples

A docs entry's value is an **example value**, and its JSON type is the field's type:

```json
{
  "an_code":   "M26",                  ->  string   ->  text input
  "keyword":   "資安",                  ->  string   ->  text input
  "watchlist": ["1402", "4904"],       ->  array    ->  textarea, sent as a JSON array
  "limit":     10,                     ->  number   ->  parsed to a number
  "dry_run":   false                   ->  boolean  ->  parsed to a boolean
}
```

So a list field takes several values (comma or newline separated) and is sent as
`["1402","4904","2330"]`, never as the string `"1402,4904,2330"`. Element types follow the
example too: an example of `["1402"]` sends strings, `[1, 2]` sends numbers. A field left blank is
**omitted** rather than sent as `""`, because these APIs document their filters as optional and an
empty string is not the same as "no filter".

The **複製提示** (Copy prompt) fallback carries the same assembled, typed object *and the docs*, so
the paste-into-a-session path cannot reintroduce a shape the form has already fixed — and the new
session starts with the api's schema in context instead of re-deriving it.

### What the new session receives (and what it does not)

**開新工作階段** (New session) feeds the api into the session twice, on purpose:

1. **As runtime context (the host half).** The client POSTs the brief to
   `/plugins/fdep-api-request/context` *before* opening the session; the host stores it armed and a
   `systemPrompt.context` provider contributes it to the new session's model steps. This is what
   makes the model *know* the api without being told: no paste, no re-fetch, no guessed field
   names. The text is capped (8 kB) and `{{` is neutralised — the prompt interpolates `{{name}}`
   groups and throws on unknown variables, so injected prose must never carry that shape.
2. **As a clipboard brief (the client half).** The same content, pasted by the user as the
   session's first message, which is also what *says what to do* ("execute with fdep_call and
   report the result"). It is the fallback when the host route is unavailable (a composition
   without `webServer`, or a plugin that has not been restarted yet).

**How the host picks the session** — the panel is a root-scoped `main` occupant and never learns
the new session's id (`uiWorkspace.startSession()` returns `void`), so the binding is by **time**:
the provider claims the first session that assembles after the arm whose `createdAt` is not older
than the arm instant, then keeps contributing to that one session for the rest of its life. A
session that already existed never receives it, another session cannot steal it, an arm nobody
claims expires after 30 minutes, and a later arm (or one without docs) replaces or clears it
entirely. Nothing is written to the session log or the filesystem.

Both texts are zh-TW (see *Language*). The **injected context** reads:

```
GUI 的「MCP Gateway」面板剛取得了下列 FDEP api 的文件，並把它注入為本工作階段的背景上下文。
請把它當作欄位名稱與型別的唯一依據，不要再呼叫 docs。

api: twseMops.todayMaterial
desc: 抓取 TWSE(上市) + TPEX(上櫃) 當日全市場重大訊息…

參數（名稱: 型別 — 範例值；留空的欄位不送）：
  an_code: string — "M26"
  keyword: string — "資安"
  watchlist: array<string> — ["1402","4904"]

原始 docs 內容（與 fdep_call mode:"docs" 回傳的 data.docs 完全相同）：
{ … }

面板目前持有的 inbound（使用者另有指示時以使用者為準）：
{ … }

要執行時，用 fdep_call 工具（mode:"execute"）帶上面的 inbound；需要再確認欄位時才用 mode:"docs"。
```

…and the clipboard **brief** (also visible in the collapsed block at the bottom of the panel):

```
請使用 fdep-api-request skill 呼叫下列 FDEP API。

api: twseMops.todayMaterial

這個 api 的文件（已取得 —— 請不要再呼叫 docs 端點）：
desc: 抓取 TWSE(上市) + TPEX(上櫃) 當日全市場重大訊息…
參數（名稱: 型別 — 範例值；留空的欄位不送）：
  an_code: string — "M26"
  keyword: string — "資安"
  watchlist: array — ["1402","4904"]
原始 docs 內容（與 fdep_call mode:"docs" 回傳的 data.docs 完全相同）：
{ … }

inbound:
{ … }

步驟：
1. 不要再取得文件 —— 上面的文件就是欄位名稱與型別的唯一依據。
2. inbound 照上面送即可，空白的篩選條件已經省略。
3. 用 fdep_call 工具（mode: "execute"）執行，並回報結果。
```

**Still not** done, and why — removing the paste step as well:

- *Writing the brief straight into the new session's composer.* The client input facade is
  session-addressed but reachable only through a **retained** session scope:
  `conversation.input.for(actx)` throws `requires a retained Session scope`, and a scope is
  minted with `ctx.sessions.scope(sessionId)`. `uiWorkspace.startSession()` returns `void`, so the
  panel never learns the new session's id; `uiWorkspace.connectWorkspace(workspaceId)` does return
  one, but the panel has no workspace id of its own to pass (the sidebar's "current or most recent
  workspace" rule lives inside `UiWorkspaceService`). Doing this properly means reimplementing that
  resolution and racing the composer's mount — fragile for a panel that is itself unmounted by the
  navigation it triggers.
- *Injecting the docs into every session, or into a guessed "next" session.* The time-bound rule
  above is deliberately narrow (created-at-or-after + bound-once + expiry) precisely so unrelated
  sessions never inherit an api they did not ask for.

`node test/fdep-docs.js <api_id>` prints an API's docs straight from the endpoint, so the field
shapes can be checked without opening the GUI.

A single status strip sits between the header and the cards. It renders nothing until an action
happens, then reports that action with a state dot, a short title and a detail line. It is a
`role="status" aria-live="polite"` region, so screen readers announce outcomes.

**Styling.** The panel uses only the shipped `--dsw-alias-*` theme tokens, so it follows the
active light/dark theme and the surrounding shell instead of carrying its own palette, and it
does not fork on `data-ds-dark-theme`. The sidebar mark is an inline SVG — a hexagonal node with
a filled core — that paints with `currentColor`; the stylesheet points that at
`--dsw-alias-state-success-primary`, so the glyph is green in both themes (a deep green on light,
a bright green on dark) without the component knowing a colour exists.

The panel tries `fetch()` directly from the browser first. Because FDEP is an internal-looking
endpoint, browser CORS will likely block the call. When that happens the status strip explains the
fallback: click **開新工作階段** (it copies the api brief — api id + docs + inbound — and opens a
blank session) or **複製提示** to grab the same text, then paste it into a session so the
host-side `fdep_call` tool does the actual HTTP work (no CORS in the Node host). Both buttons are
disabled until the docs are loaded, because that brief is the docs.

### Previewing the panel without restarting

`test/preview.js` renders the real component in six states with the real stylesheet and writes a
standalone page:

```sh
node test/preview.js       # writes test/preview.html
```

Open `test/preview.html` in any browser. It has a light/dark toggle, shows the sidebar glyph at
rail size, and freezes each state (initial, docs loaded, in flight, completed, CORS warning,
failure) into its own card. Hover and focus are live because they are pure CSS.

The generator validates its own output before writing: every class the component emits must have
a rule in the stylesheet, SVG shapes must be self-closed, and no React-only prop may leak into
the markup. Three real defects were found this way — an `fdep__btn--default` modifier with no
rule, `<path>` tags that the HTML parser swallowed, and a leaked `key` attribute. The page's
token *values* are approximations from the shipped boot palette (the live values belong to the
running theme); the structure, classes and token *usage* are exact.

## Install

From the workspace root:

```sh
dsh plugin --profile web add ./cordis-plugins/fdep-api-request
```

(This bundle used to live in `bundles/fdep-api-request`; it moved next to the other
local plugins under `cordis-plugins/`, which is the directory that is published and
git-tracked. The profile's `link:` dependency, `pnpm-lock.yaml` and the
`node_modules/fdep-api-request-bundle` symlink all point at the new path.)

The bundle installs as a `link:` dependency so further edits here are picked up by the next `dsh web` restart. Restart the running `dsh web` process for the row to be composed — `dsh plugin` only edits `~/.dsh/profiles/web/`.

To remove:

```sh
dsh plugin --profile web remove fdep-api-request-bundle
```

## Verify

1. Restart `dsh web`.
2. The sidebar should show a green hexagon glyph labelled **MCP Gateway** in the global panels list.
3. Click it — the main column should render the three numbered cards (1 選擇 API → 2 參數 → 3 執行),
   with `twseMops.todayMaterial` already in the API ID box and **複製提示** / **開新工作階段**
   greyed out until **取得文件** succeeds.
4. The host-side tool appears in the active model toolset. Send any prompt that exercises it (`call fdep_call on test.demo with mode docs`); the model receives a normalised schema object.
5. **Runtime context:** click **取得文件**, then **開新工作階段**. In the new session, ask what the
   current api's parameters are — it answers from the injected docs (they arrive as a plugin-source
   runtime-context message, so they are visible in the transcript too). A session you had already
   opened before clicking never receives them.

### Test suite (no dsh web, no profile writes)

```sh
cd cordis-plugins/fdep-api-request
node test/run-all.js
```

Six suites, each a separate process:

| Suite | What it proves | Needs the DSH tree |
|---|---|---|
| `host-integration.test.js` | Mounts the **real** `@deepseek-ai/cordis` Context, the real `dsh-system-prompt`, and the real `dsh-tools` registry, then drives `fdep_call` through the live execute pipeline — and arms the docs route to assert the **real assembler** carries them for the session created after the arm (and not for one that predates it). Only `fetch` is stubbed. | yes (exit 2 = skipped) |
| `host-http.test.js` | Mounts the **real** `dsh-host-webserver` on a loopback port and POSTs the arm route over real HTTP — proving the registered exact route wins over the `/plugins` fallback (which is what makes the client's POST work in the GUI), that a non-POST is refused, and that disarming works. Set `DSH_TEST_PORT` if 41337 is taken (a busy port = skip, not fail). | yes (exit 2 = skipped) |
| `host-shape.test.js` | Pins the host-plugin shape contract: a direct `{name, inject, apply}` mounts, the factory form fails **silently**, and an undeclared service access throws `... without inject`. | yes (exit 2 = skipped) |
| `host-localhost.test.js` | Dependency-free unit checks against a mocked ctx: plugin shape, schema, argument parsing, inbound normalisation, and the arm/bind/expire rules of the runtime context. | no |
| `client-contract.test.js` | The static-bundle wrapper, the `require("react")` dependency, the `slots.inject`/`slots.register` contract, a real render of the panel with its buttons clicked (including "the arm must reach the host before the session exists", and the degrade-to-clipboard path), and the presentation contract (every CSS variable is a real token, no hard-coded light/dark fork). | no |
| `preview.js` | Regenerates `preview.html` and validates its own markup before writing it. | no |

A companion design guide for this kind of work lives at [`../../FDEP-API.md`](../../FDEP-API.md).

## Development loop (no restart for UI work)

Editing `lib/client.js` does **not** require restarting `dsh web`. The host re-reads the bundle
from disk and the browser swaps the plugin in place.

```sh
node test/dev.js            # watch + verify + report, Ctrl+C to stop
node test/dev.js --once     # one-shot: run the checks and exit
```

On every save it prints what happened. A real run:

```
[12:40:09] changed  lib\client.js  (tier 2)
[12:40:12]   contract  PASSED (43 checks)
[12:40:13]   preview   regenerated (58 classes verified)
[12:40:17]   HMR       rebuilt frame -> 3cecfeb5151d
           the browser swaps this plugin in place; no refresh needed
[12:40:17]   served rev 3cecfeb5151d (host re-read the file)
```

### Why it works

`@deepseek-ai/dsh-client-hmr` runs a stat-poll (default `pollIntervalMs: 500`) over every graph
bundle and serves an SSE channel at **`/plugins/events`**. When a bundle's revision changes it
broadcasts a `rebuilt` frame; the browser half of that plugin reloads the entry in place, with no
page reload. Because a static bundle is served as its **source file** — no build step — saving the
file is the entire rebuild.

The revision is a pure content hash, which is checkable: edit the file, note the new `rev` in
`__DSH_BOOT__`, revert the edit, and the original `rev` comes back byte for byte.

```sh
node test/dev-boot.js       # print this bundle's served URL + rev from the running host
node test/dev-events.js 10  # watch /plugins/events for 10s
```

### The three tiers

| Tier | Trigger | Cost | Verified by |
|---|---|---|---|
| 1 | edit `test/preview.js` (or any `lib/client.js` change) | instant, offline | contract test + regenerated preview page |
| 2 | edit `lib/client.js` | ~500ms, **no restart, no refresh** | `rebuilt` SSE frame + changed `rev` |
| 3 | edit `lib/index.js` (the tool definition) | **host restart** | offline host tests; the running host imports the module once at boot |

So a UI iteration is tier 1 → tier 2: save, look at the browser (or at `preview.html`), repeat.
A restart is only ever needed when the **tool definition** itself changes — which the offline
integration test already covers, so it does not need to be in the fast loop at all.

> **Moving this directory breaks tier 2 until the host restarts.** `dsh-client-hmr` polls the
> *absolute* `clientPath` captured when the profile was composed. Once the bundle (or its
> `link:` target) moves, that poll `stat`s a path that no longer exists, marks itself dirty and
> never publishes again — so the host keeps serving the bytes it read at boot, and
> `node test/dev-diff.js` reports `DRIFTED`. This is exactly what happened when the bundle moved
> from `bundles/fdep-api-request` to `cordis-plugins/fdep-api-request`. Restart `dsh web` and the
> new path is composed; nothing else in the plugin depends on where it lives.

### Optional: host-side HMR

`@deepseek-ai/cordis-plugin-hmr` (chokidar watch → module-cache clear → reload only the affected
entries) is already composed but **disabled**. Enabling it would make tier 3 live too. It is not
enabled here because it is a change to the *host* composition, not to this bundle, and it carries
real risk: the plugin documents that changes to framework-level dependencies fall back to
`loader.exit()`, i.e. the host restarts — the very thing tier 3 is trying to avoid, only now
triggered by a save instead of by you.

If you want to try it, add to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: hmr
  disabled: false
  config:
    root:
      - .
    debounce: 150
```

and restart once to pick it up. Roll it back by removing the entry and restarting again.

## What the contract testing changed

Five defects were found and fixed by running against the real packages — and, for the last one, by
no longer trusting a test that stubbed the very thing under test:
1. **`ctx.effect(dispose)` unregistered the tool immediately.** Cordis invokes the effect callback at once and treats its *return value* as the disposer, so passing the disposer itself tore the registration down. `ctx.tools.register()` already binds disposal to the calling fiber, so the wrapper was removed entirely. The same mistake in the client's stylesheet call is now written as `ctx.effect(() => dispose)`.
2. **`parameters` must be raw JSON Schema, not the DSL.** A hand-written literal in the `dsh-tools` ParameterSchemaSpec form is projected to the model verbatim, which is not a valid model-facing schema. The DSL only becomes JSON Schema when passed through `defineTool`. Since `require('@deepseek-ai/dsh-tools')` resolves differently under symlinked profile installs (verified: it fails without `--preserve-symlinks`), the bundle declares the raw JSON Schema directly — the documented wire-level form used by MCP — and validates every argument in `execute`.
3. **A bare `React` global does not exist in a static bundle.** React must come from the loader-provided `require`.
4. **The `output.schema` `oneOf` branches must be mutually exclusive.** The execute branch originally required only `api_id`, so a docs result matched two branches and the registry rejected every successful docs call as invalid output.
5. **`ctx.get()` is not a substitute for a dependency declaration.** The contract test only ever
   proved that the button calls *whatever service the test itself installed*; it never modelled the
   real resolution path. Mirroring the real mechanism (an `inject` callback that can fire late, and
   a `ctx.get` that must not be used) turned the live "Service unavailable" report into a
   reproducible check — section 12 of `test/client-contract.test.js`.

## What this bundle does NOT do

- It does not fork or override the existing `fdep-api-request` skill. The skill stays at `~/.dsh/skills/fdep-api-request/SKILL.md` and is loaded via the `skill` tool as before.
- It does not provide per-API custom UI; the form is generic over the docs schema.
- It does not authenticate against FDEP. The endpoint URL is hard-coded; if your deployment uses a different host, edit `lib/index.js` and `lib/client.js`.

## How it fits the static-bundle contract

Both halves follow the same conventions `no-browser-auth` and `scene-template` already use:

- `lib/index.js` exports the host plugin directly as `{ name, inject, apply }`. The Cordis loader resolves the bundle by `name` and mounts it.
- `lib/client.js` registers via `window.__ModuleLoader__.load({ id, factory })`. The factory receives `require` from the loader, pulls `react` from there (there is no `React` global in a static bundle), and returns `{ inject: ['slots'], apply(ctx) }`.
- **An optional client service must be resolved with `ctx.inject(deps, cb)`, never read once with
  `ctx.get()` in `apply`.** Two independent traps, both hit in practice:
  1. `ctx.get(name)` only answers for a provider whose fiber is already **active**
     (`ReflectService._getImpl` filters on `fiber.state === ACTIVE`). This bundle declares
     `dsh.client.immediately`, so `apply()` regularly runs *before* the workspace plugin provides
     `uiWorkspace` — the old one-shot read captured `undefined` and "New session" answered
     "Service unavailable" forever in a GUI where the service was mounted all along.
  2. Listing it in `inject` instead would park the whole plugin in a composition without the
     workspace plugin, which also hides the sidebar entry.

  `ctx.inject(['uiWorkspace'], scope => { … })` gets both properties: the panel mounts either way,
  and the callback fires (with a disposer) when the service appears.
- Slot occupants are wrapped in `ctx.slots.inject(slotKey, () => ctx.slots.register({name, ...meta}, (props) => React.createElement(Component, props)))` so the binding lifecycle is re-applied if a slot declaration collapses. The registered component forwards its slot props; the inner component does the rendering.
- Services the components need are captured in a closure built in `apply` — components never reach for a global `ctx`, which a static bundle does not guarantee.

## Layout

```
cordis-plugins/fdep-api-request/
├── package.json           # dsh.bundle.patch + dsh.client declarations
├── cordis.patch.yml       # inserts the host plugin row
├── lib/
│   ├── index.js           # host: registers the fdep_call tool
│   └── client.js          # browser: sidebar panellist + main panel
├── test/
│   ├── run-all.js               # runs the three suites
│   ├── host-integration.test.js # real cordis + dsh-tools pipeline
│   ├── host-localhost.test.js   # dependency-free unit checks
│   └── client-contract.test.js  # loader wrapper + slot + render
└── README.md
```