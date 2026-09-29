# scene-template

> A DSH (DeepSeek Harness) profile bundle that adds an **AI 工作流输入区** to the
> Web GUI: pick a 场景 (scenario) and a 分支 (branch) above the composer, and a
> 模板 (template) poster below it — the branch's preset is written into the
> composer, the template travels with the message.

Originally prototyped as a dynamic Cordis Package (plugin `awui-2`, packages
`pkg-2`…`pkg-15`); this bundle is that prototype frozen into an installable
profile layer.

> **Host compatibility.** Verified against `@deepseek-ai/dsh` **0.1.7-rc.2** (the
> conversation UI that turned `conversation.composer.dock` into a centred flex row —
> see *Why the wall is not in `composer.dock`*). The layout only relies on two stable
> things: a list slot's `display: contents` anchor and the flex `order` of the entry's
> root element, so the same code also works on 0.1.5.

## What it renders

| Entry id | Slot | Content |
|---|---|---|
| `st-top` (order 1) | `conversation.input.dock` | **no static labels** — before a choice: one line of scenario chips (the largest row); after a choice: a header holding the **selected scenario as a brand-coloured badge** (icon + name) with a `✕` close button inside it, and below it one line of branch chips (one step smaller). Drag to pan. The panel's top-right corner holds the **expert pet** (see below) |
| `st-wall` (order 2) | `conversation.input.dock` | the template wall. It lives in the **top** dock on purpose and carries flex `order: 2` on its root element, so it sorts **below** the composer card in every layout (see *Why the wall is not in `composer.dock`*) |

Interaction:

- **场景 chips** (the only chips before a choice) — single choice; picks the branch set
  (details are fetched on select) and **injects the scenario's name + description into the
  model context** (see *Context injection*). Once a scenario is chosen the chip list **collapses**
  (the long names would otherwise own the row) and the header shows the scenario badge alone:
  the `✕` inside that badge clears the selection and brings the list back. There is no separate
  `換場景` button and no `→ branch` tag — the selected branch is expressed by the branch chip's
  own highlight.
- **分支 chips** (the only chips after a choice) — single choice; each chip renders as
  `<branch name> ↘`, so the row reads as items hanging off the selected scenario. Selecting one
  replaces the whole composer draft with that branch's `preset` through the official
  `inputActions.setDraft(text)`.
- **模板** — **no scenario ⇒ the whole third part is not rendered** (recommendations are
  scenario-scoped, so there is nothing to show and no placeholder text either). With a
  scenario: single choice — the poster's title **and its reference content** go into the model
  context (see *Context injection*); double-click opens a preview modal (iframe, `data:` HTML);
  **按住拖曳** pans the wall left/right; scrollbars are hidden on purpose. Every user-facing
  string (chips, hints, buttons, poster text, preview page) is **Traditional Chinese (zh-TW
  idiom)** — see *Language* below.
- **✨ 推薦 / 🔄 換一批** — asks `api.recommend(cursor)` for the next batch of 4
  templates from the cross-scenario pool (30 templates ⇒ 8 batches, then it
  cycles) and shows `推薦第 N/8 批`; `返回場景模板` goes back to the scenario's own
  templates.
- The wall renders `null` until a scenario is chosen — recommendations are
  scenario-scoped by design.

### Why the wall is not in `conversation.composer.dock`

`conversation.composer.dock` is the seat that *is* below the card — and on DSH 0.1.5
(the line this plugin was written against) it was where the wall lived: the seat was
rendered straight into `.uV2eYG_root`, a flex **column**, so the wall had a row to
itself. From **0.1.7** (and in the 0.1.6 alphas) that seat sits inside a wrapper:

```css
.uV2eYG_dock{display:flex;justify-content:center;align-items:center;gap:12px;max-width:100%;padding-top:4px}
```

i.e. a **centred row** that also holds the shipped `ContextMeter`. Our panel is a
`flex: none` block that wants to be one card wide, so the two items end up sharing
one line: the wall overflows to the right and the meter is squeezed beside it.
Nothing inside that wrapper is addressable from a plugin (hashed class name, no
data attribute), and the wrapper's width is *fit-content*, so a percentage width
inside it no longer has the card's box as its base.

The top dock has neither problem: a list slot's `SlotOutlet` anchor is
`display: contents`, so the entry is a **direct flex item of `composerStack`** (a
flex column, `gap: 6px`) and `order: 2` sorts it after the card (`order: 0`). Its
`100%` is the stack width — the same base the card uses — so
`calc(100% - 2×clearance)` + `margin: 0 auto` reproduces the card's box exactly,
in a normal session **and** in a hero (brand-new) one. That is why one entry
covers both cases and no `composer.dock` copy exists.

Consequence to know about: the shipped `ContextMeter` stays where the host puts it
(directly under the card, inside the composer), so the vertical order is
**card → meter → wall**. The meter renders nothing at all while the context
occupancy is unknown, which is why fresh sessions show the wall right under the
card.

## Data sources

| endpoint | source |
|---|---|
| `scenarios.list` | **real API**: `GET https://abc.feg.com.tw/BDD/API/AI/dsh/scene/list?preset=<agent preset id>` — the list is **per agent preset**, so the current session's preset id travels as the `preset` query parameter (see *The list is per preset*) |
| `scenarios.get` (detail + branches + templates) | **real API**: `POST https://abc.feg.com.tw/BDD/API/AI/dsh/scene/detail` with `{"id":"scn_writing"}` |
| recommend (`✨ 推薦` / `🔄 換一批`) | **real API**: `POST https://abc.feg.com.tw/BDD/API/AI/dsh/scene/suggestion_template` with `{"scene_id":"scn_writing","content":"<composer draft>"}` |
| `scenarios.templates` (dynamic templates), `templates.preview` | mock in `lib/client.js` (with `LATENCY`) — in practice the preview never needs the endpoint, because every template already carries a working `previewUrl` |

Both real endpoints answer with `access-control-allow-origin: *` (their preflights return `204`
with `allow-methods: GET,HEAD,PUT,PATCH,POST,DELETE`), and each is wrapped in a **mock fallback**:
timeout (8s), a non-2xx status, a malformed payload, or a network error falls back to the embedded
data. Hover says which one you are looking at — the chip row reports the scene list's source, the
branch row and the template wall report the detail's, and the recommend button reports the
recommendation's (`場景清單：遠端 API` / `…mock（遠端 API 失敗，已回退）`).

Two behaviours worth knowing about the recommendation endpoint:

- it returns a **bare array of 3 templates** (not `{templates:[…]}`) and the order **differs on
  every call**, so `🔄 換一批` is simply "call it again" — no cursor is needed. The client still
  sends `cursor`, but only the mock fallback reads it (that path keeps the 4-per-batch pool and
  the `推薦第 N/M 批` hint).
- its `previewUrl` is a **relative path** (`/share/ehr/pages/dev/preview/template_preview.html`), so
  the client resolves it against `https://abc.feg.com.tw` before feeding the iframe.

**The preview uses the API's URL.** Each template object already carries `previewUrl`, so
double-clicking a poster renders *that* URL in the modal iframe (relative paths are resolved against
`https://abc.feg.com.tw`) — the §3.4 endpoint is only consulted when a template arrives without a
`previewUrl`. The modal shows a skeleton overlay until the iframe fires `load`; if that has not
happened after 2.5s it adds a one-line hint.

That iframe **works now** (probed 2026-09-24): the route answers `200 text/html; charset=UTF-8`
(777 bytes) with **no `X-Frame-Options` and no CSP header at all**, so nothing blocks the frame. The
earlier blocker — `x-frame-options: DENY` plus a `frame-ancestors` list without the DSH origin, and
a 4-byte body — is gone.

What is still missing is **per-template content**: every template's `previewUrl` is the *same* page,
and it ignores query parameters — `?id=`, `?template_id=` and `?templateId=&scene_id=` all return
byte-identical HTML (a sample whose `<h2>` is `會議紀要與決議看板`, i.e. the `tpl_meeting` sample),
while `/share/ehr/pages/dev/preview/tpl_weekly.html` is a `404`. So double-clicking any poster shows
the same preview until the backend parameterizes the page by template id (or serves one page per
template).

Also note the iframe is `sandbox=""` (no scripts, no same-origin): if the real preview page needs
JavaScript to render a template, relax it to `sandbox="allow-scripts"`.

**When does it fetch?** The scene list and the scenario detail are keyed on the slot's
`sessionId` (the detail additionally on the scenario id), so **every new or switched session
re-fetches them** — a session switch is not a page reload, the same panel instance just changes
`sessionId`. The list is keyed on the **agent preset** as well (see below), so switching the
mode chip re-fetches it too. A click on the expert pet bumps `tick` on the module bus (the
dependency is `[sessionId, agentPreset, tick]`, the detail `[scenarioId, sessionId, tick]`) and
is the one *manual* refresh — see "The expert pet". An already-loaded list stays visible while
the refresh is in flight (no skeleton flash); only the very first load shows the skeleton.

### The list is per preset

The scene list is scoped to the **agent preset** the session runs (the mode chip on the new
session screen: 標準模式 / 办公模式 / …), so the request carries it:

```
GET https://abc.feg.com.tw/BDD/API/AI/dsh/scene/list?_t=<ms>&preset=<preset id>
```

The id is read from the session row's `projectionValues.agentPreset` — the same key
`ui-agent-preset` uses for the header label and the hero chip's `current` — through the slot's
standard `useSessions` prop: the row for the slot's own `sessionId`, falling back to the row the
main view retains (`retainedBy.mainView > 0`). When the slot exposes no `useSessions`, or no
session records a preset yet, the parameter is omitted and the list is fetched without one; both
are silent degradations, not errors.

Because the list is per preset, the preset is part of the fetch effect's dependency array:
**switching the mode chip re-pulls the list** (and the pet's tooltip reports which preset the
current list belongs to: `當前模式 preset：office`).

> The live endpoint still answers the same six scenarios for every preset — including a
> nonsense one — so the parameter is not honoured server-side yet. The client sends it as
> agreed, and per-preset filtering starts working the moment the backend reads it.

Where the request happens differs by delivery form, because the two halves have different globals:

- **static bundle** — `lib/client.js` runs in the browser, so it calls `fetch()` directly (GET for
  the list, POST for the detail). No proxy is needed. The list URL carries a unique `?_t=<ms>`
  cache-buster: the response has only a weak `etag` (no `cache-control` / `last-modified`), so
  without it a browser or intermediary cache could hand back the previous list. A query param keeps
  the request *simple* (no CORS preflight), unlike `fetch(…, { cache: "no-store" })`, which adds
  `cache-control` request headers and therefore forces a preflight the endpoint has to allow.
- **dynamic Package** — the client sandbox exposes only `ctx` / `React` / `host` / `styles` /
  `console`, and the host half's builtins are `ctx` / `harness` / `console` / `btoa` / `atob` /
  `TextEncoder` / `TextDecoder`. The only outbound HTTP the host has is the `web` Service, whose
  `fetch(request)` takes just `{ url }` — **GET only**. So the host half does the list through
  `ctx.get('web').fetch({ url })`, and bridges both POSTs (detail, recommendation) through
  `ctx.get('subprocess').spawn({ argv: ['curl', …] })`, reading stdout from the collect reader.
  (The cwd for that spawn comes from `ctx.get('fs').resolve('.')` + `processPath`.)

> ⚠️ The detail route answers a **GET with `200` and an empty body** (a matching route that
> returns nothing), so a GET looks like success but carries no data — only the POST returns the
> payload. The prototype's GET-only `web` path therefore cannot use it, hence the curl bridge.

## Context injection

The three choices do different jobs — only one of them is text in the composer:

| choice | what the user sees | where it lands |
|---|---|---|
| **scenario** | the badge in the header | its name + description enter the step's runtime context |
| **branch** | its `preset` **replaces the composer draft** (editable, via `inputActions.setDraft`) | the user's own message — nothing extra is injected |
| **template** | the highlighted poster | its title + **reference content** enter the runtime context |

The scenario and the template are injected host-side, because a composer draft is the wrong
place for them: bulky, and the user would have to read (and could break) them.

1. `lib/client.js` (browser) POSTs the current selection to `/plugins/scene-template/selection`
   — an exact, same-origin route. The body carries `sessionId`, the scenario id/name/description,
   the branch id/name, and the template id/title/`previewUrl`.
2. `lib/index.js` (host) stores it per session and registers
   `systemPrompt.context({ name: 'scene-template/selection', order: 130, text })`. The prompt
   assembler calls that provider once per model step; it returns the rendered block, or `""`
   when nothing is selected — empty contexts are dropped, so an idle session adds nothing.

Two runtime facts shape the code:

- The assembly context the provider receives is built by `dsh-agent`'s
  `assembleContextFor(agent, signal)` — `{ agent, scope: agent, signal? }` — so the session comes
  straight off `context.agent.id`. (`AssembleContext`'s published type lists only `scope`/`signal`;
  the runtime object carries `agent` too, and trusting the published type is what made the first
  version guess instead.) `agents.currentInitiator()` — the `AsyncLocalStorage` the driver chain
  runs inside — stays as a fallback, and the pet's tooltip names the path that resolved it
  (`已注入 N 字（context.agent）`), so a wrong guess stays visible instead of silent.
- `agent-loop`'s `preStep` renders those contexts and **projects them as a plugin-sourced user
  message** (`source.kind = 'plugin'`, `form = 'snapshot'`, carrying the named sections) appended to
  that step's messages — and only when the snapshot actually changed. The injected block is
  therefore both in the step's prompt and visible in the conversation as a context node; when the
  selection is cleared the projector sends its `CLEARED` replacement.
- The prompt interpolates `{{name}}` groups and **throws** on an unknown variable, so injected
  prose is sanitised (`{{` → `{ {`). A template body that happens to use mustache syntax would
  otherwise break every later step of that session.

**What the block looks like.** A selected scenario + branch + template renders as:

```
以下是使用者在輸入區選中的場景/分支/模板資料,請把它當作本次對話的背景上下文:
【已選場景】财报与经营数据分析
場景說明:分析场景:从财报、经营报表与埋点数据中提取关键指标…
【已選分支】指标异动归因分析(該分支的 preset 已寫入輸入框,若使用者改過則以輸入框內容為準)
【參考模板】經營看板速覽
預覽地址: https://abc.feg.com.tw/share/ehr/pages/dev/preview/template_preview.html
模板案例內容(生成檔案時可參考):
…reduced preview text…
```

**Template reference content.** `previewUrl` is fetched once per template, cached by
id + URL, and reduced to text (`<script>`/`<style>` dropped, tags stripped, entities decoded,
capped at 4000 characters). Inline `data:text/html` templates are decoded locally instead of
fetched — that path is what the offline fallback data uses.

The block always carries the template's **preview address** as well (http(s) only — an inline
`data:` URL *is* the content and is kilobytes long, so it is skipped). That is deliberate: when the
extraction yields nothing, the model still gets a reference it can open — the block then reads
`(案例內容未能自動取出，需要時可抓取上面的預覽地址查看完整範例)` instead of a dead end, and the pet's
tooltip says `（案例內容未取到：error，已附預覽地址）`.

Note the current data gap: the API answers **the same page for every template**, so every poster
injects the same sample today; `mock/README.md` §3.4 tracks the per-template content the backend
still owes (until then the address is the only per-template reference).

The expert pet's tooltip states what will be injected and how the last assembly went —
`會注入模型上下文：場景「…」·模板「…」（案例 1234 字，來源 API）` and
`上次組裝：已注入 1234 字` (or `未注入（…）`) — so the wiring is observable from the UI,
without a debugger or a log dig.

## Loading states

Every fetch has visible feedback, and the mock latencies are deliberately staggered
(`LATENCY = { list: 520, detail: 420, dynamic: 760, recommend: 640, preview: 300 }` ms — `list`
only applies on the mock-fallback path now) so each transition can be watched on its own:

| load | feedback |
|---|---|
| scenario list (`scenarios.list`) | 4 pulsing skeleton chips (the row starts as `null`, not `[]`, so "loading" is a real state) |
| scenario detail (`scenarios.get`) | 3 skeleton branch chips until `active` arrives |
| template wall (`scenarios.get` again, and `templates.recommend`) | 3 skeleton posters reusing the poster card's box |
| recommend batch | the button reads `重新整理中…` and the wall switches to the skeleton strip |
| dynamic templates (`scenarios.templates`) | the header hint reads `動態模板載入中…` (the wall keeps the static set) |
| preview (`templates.preview`) | the modal opens **immediately** with a skeleton + `預覽載入中…`, then swaps in the iframe |

Skeletons are grey blocks with the real element's size and radius plus the injected
`.st-skel` pulse; when data lands the container changes its React `key` and fades in through
`.st-in`. In the static bundle the latency is a local `setTimeout` inside `delayed()` — wiring a
real backend means deleting `LATENCY`/`delayed` and returning the fetch promise instead.

## The expert pet

A transparent 44×44 square **hanging upright on the panel's top-right corner**: an inline-SVG robot
(no external asset, no icon font) with round glasses, drawn straight into `lib/client.js`.

- Its centre sits a hair inside the corner — `right/top = PET_HANG - PET/2` with `PET_HANG = 6`
  (= 6px in from the corner). Exactly `0` looks best but clips against the conversation column's
  right edge; 6px keeps it clear of both the clip and the panel content.
- The panel therefore needs **no left/right gutter** (chips stay in the column of the input text)
  and `S.panelPet` only adds `marginTop: PET_AIR` (44) to reserve the air the pet hangs in. That
  space grows *upward* (the composer seat is bottom-anchored, so the input bar does not move) and,
  in a hero session, keeps the pet clear of the workspace chip row above.
- Four CSS animations, injected with the rest of the plugin CSS: `.st-pet-sway` (a gentle ±3°
  idle sway), `.st-pet-hop` (replayed once per state change, via a React `key`), `.st-pet-float`
  (idle bobbing) and `.st-pet-eyes` (`transform-box: fill-box` for the blink).
- `S.petRotate` is the wrapper the body's transform lives on (`rotate(0deg)` while the pet is
  upright) so the speech bubble stays level. The bubble sits on the pet's left (`right: PET - 4`) —
  the side that faces into the panel, which also keeps it inside the conversation column — and it
  tracks the selection: `💭` nothing chosen → `💡` scenario chosen → `✨` branch chosen.
- It is **clickable** — the only manual refresh in the UI. A click emits `{ type: "refresh" }` on the
  module bus; each panel holds `useRefreshTick()` in the dependency array of its scene-list /
  scenario-detail effect, so one click re-pulls the list *and* the open scenario's detail. It carries
  `cursor: pointer` and the tooltip `點我刷新：重新拉一次場景清單與詳情`. The hit box is the same
  44×44 transparent square hanging over the corner, so chips underneath are unaffected.

Swapping the character is a one-component change (`ExpertPet`): any emoji, your own SVG, or an
`<img>` of a transparent PNG drops into the same box. Moving it along the corner is `PET_HANG`;
the air above is `PET_AIR`; the idle sway is one line in `CSS_TEXT`.

## Install

```sh
dsh plugin --profile web add ./scene-template
# or: dsh plugin --profile web add github:wuzhiping/cordis-plugins/scene-template
```

`dsh plugin` only edits `~/.dsh/profiles/web/` — **restart the `dsh web` process**
for the row to be composed.

## Language (zh-TW)

Every string this bundle puts on screen is **Traditional Chinese**, in Taiwan idiom:
chips carry the scenario/branch names, the panel shows `✨ 推薦` / `推薦第 N/8 批` /
`按住拖曳查看 · 雙擊預覽`, the preview modal says `預覽 · …` / `關閉`.

The strings are converted **in the source**, not at runtime — `lib/client.js` holds real
Traditional literals (mock data included), so the delivered file is self-describing and
there is no conversion table to ship. The conversion was produced once by
`tools/s2t/` (inside this bundle — run the commands below from the bundle root):

- `tools/s2t/winmap.ps1` — Windows `LCMapString(LCMAP_TRADITIONAL_CHINESE)` per-character
  map for every CJK char in this file (complete character coverage).
- `tools/s2t/convert.js` — applies the phrase+char table from
  [`zhtw-traditional-chinese`](../zhtw-traditional-chinese) first (Taiwan idiom and
  ambiguous characters: `后→後`, `设置→設定`, `拖动→拖曳`, `界面→介面`, `计划→計畫`,
  `刷新→重新整理`…), then the Windows map for anything it misses (`數/觸/達/點/題/線/評/價`…),
  then a small hand-written `POLISH` list for the points neither table handles
  (`怎么→怎麼`, `在于→在於`, `本周→本週`, `采用→採用`, `取舍→取捨`, `交互→互動`,
  `复数→複數`, `占位符→佔位符`, `范围→範圍`, and the over-conversion
  `裡程碑→里程碑`). Run `node tools/s2t/convert.js --report <file>` to re-audit a file.

> Note: this bundle's UI is Traditional because the product is; the Chinese *comments*
> in `lib/client.js` were converted as well. Documentation (`README.md`, `UI.md`) stays
> Simplified on purpose.

## Verify

- Open any conversation (or a brand-new one): a line of scenario chips above the
  composer and, after picking one, the template panel below it (above the composer in a
  hero session) — **no labels and no prompt text anywhere**. With nothing selected the
  third part simply does not exist; pick a scenario to bring it in. Every visible string
  is Traditional Chinese.
- Pick 場景 → 分支: the composer draft is replaced by that branch's preset.
- Click a poster (blue outline + ✓), double-click it (preview modal, `預覽 · …`).
- Drag the chip rows / poster wall left-right: they pan, no scrollbar, and a drag
  never selects anything by accident; a plain click still selects.
- `✨ 推薦` → four different posters; click again → the next batch.
- Hover the scenario chip row: the tooltip names the source **and** the preset the list belongs to
  (`場景清單：遠端 API（abc.feg.com.tw）` / `當前模式 preset：office`).
- Switch the mode chip (標準模式 ↔ 办公模式 …) on a new session: the scene list is re-fetched with
  the new `&preset=` value. `node tools/verify-preset-param.js` drives exactly this against the
  running GUI and prints every `scene/list` URL (see *Tools*).

## Tools

| tool | what it does |
|---|---|
| `tools/verify-preset-param.js` | Opens the running GUI (http://127.0.0.1:3080) in its own headless Chrome, wraps `fetch` to record every `scene/list` call, prints the DOM's scenario chips + list tooltip, then switches the agent preset in that *throwaway* browser and prints the `scene/list` call the switch produced. Restores the preset it found; the user's window is untouched. |
| `tools/s2t/` | The one-off Simplified→Traditional (zh-TW) conversion of `lib/client.js` — see *Language*. |

## Mock data → `mock/` (one file per endpoint)

The dataset (6 scenarios / 20 branches / 24 static + 6 dynamic templates) is exported **per API
endpoint** into [`mock/`](./mock), so it can go straight to the backend for contract review:

| file | endpoint (spec §3) |
|---|---|
| `scenarios_list.json` | `GET /api/scenarios` — skeletons only |
| `scenario_detail.json` | `GET /api/scenarios/{id}` — keyed by scenario id |
| `template_suggestion_for_scenarios.json` | `POST /api/scenarios/{id}/templates` — `{request, response}` per scenario |
| `template_preview.html` | `GET /api/templates/{id}/preview` — a sample HTML page (live route: `GET /share/ehr/pages/dev/preview/template_preview.html`) |
| `conversations_submit.json` | `POST /api/conversations` — request samples |

Templates are exported in the spec's §2.3 shape only (`id` / `title` / `thumbnailUrl` /
`previewUrl` / `contentType`); the mock-internal authoring fields (`sections`, `hue`, `icon`)
stay in `lib/client.js`. `previewUrl` uses the live URL form
(`/share/ehr/pages/dev/preview/template_preview.html` — one page for every template today) rather
than the inline `data:` URL the prototype falls back to.

These files are a **snapshot taken from `lib/client.js`** — a hand-off artifact for the API
review, not a second source of truth. If the mock data in `lib/client.js` changes, update this
directory by hand (or regenerate the files once and copy them over).

[`mock/README.md`](./mock/README.md) is the handover note: the endpoint ↔ file table, the field
tables, and **five open alignment points** (notably: §3.2 must return `hasDynamicTemplates` — the
prototype omits it today and dynamic templates never fire because of it).

## Wiring a real backend

The mock data and every data entry point live in `lib/client.js` in one object:

```js
var api = {
  listScenarios: function () { /* → [{ id, name, icon, hasDynamicTemplates }] */ },
  getScenario:   function (id) { /* → { id, name, description, branches, templates } */ },
  getDynamicTemplates: function (scenarioId, input, branchId) { /* → [template] */ },
  recommend:     function (cursor) { /* → { templates, nextCursor, batchIndex, total } */ },
  getPreview:    function (id) { /* → { previewUrl, contentType } */ },
};
```

Replace those bodies with `fetch(...)` calls (or a host RPC — the API contracts
match the `AI 工作流输入区 UI 规范 v0.1` §3 endpoints exactly, `templates.recommend`
being the spec's "刷新模板" button). No component changes are needed.

## How it works

- `package.json` declares `dsh.bundle.patch` **and** `dsh.client.platform: "web"`.
- `cordis.patch.yml` inserts one host row named `scene-template`; the
  `@deepseek-ai/dsh-client-modules` registry uses that row to discover the client
  module. The row's `lib/index.js` is a real (small) host plugin: it owns the
  selection route and the runtime prompt context described under *Context
  injection*; if every service it wants is missing, it degrades to a no-op and the
  UI still renders.
- `lib/client.js` is a CJS bundle wrapped in `window.__ModuleLoader__.load({ id, factory })`
  whose factory returns `{ inject: ['slots'], apply(ctx) }` and registers two entries,
  both in the top dock (`st-top`, `st-wall` — see the table above). It uses
  `require("react")`, plain browser timers and `document` — a static client bundle is
  **not** sandboxed the way a dynamic Package is.

### Gotchas worth remembering (they cost real debugging time)

1. **Dock geometry is CSS-variable driven, not measured — but copy the formula of the
   element you are a *sibling* of.** This entry lands in `composerStack` next to
   `inputBar` (SlotOutlet anchors are `display: contents`), so its `100%` is the stack
   width and the match for the input card is:

   ```js
   width:      calc(100% - 2*var(--dsh-composer-side-clearance))
   max-width:  var(--dsh-composer-card-max-width)   /* .uV2eYG_card inside .uV2eYG_root */
   margin:     0 auto
   padding:    0 14px      /* aligns with .uV2eYG_input's padding-left: 14px */
   ```

   Do **not** copy `TodoPanel`'s `.lXshSW_root`, which subtracts 4 extra
   `--dsh-composer-dock-inset`s (that is its own "floating tip card" geometry) — doing so
   makes the panel 16px narrower than the input card on each side. Do not copy
   `._7yHdaG_dock` either: despite the name it is **not** the `composer.dock` wrapper but
   the shipped *queue* panel (`QueueDock.module.css`, `padding: 0 8px`, negative
   `margin-bottom`), and it is a sibling of the card in the stack. Measuring the card
   with `getBoundingClientRect()` instead is also fragile — the dock's parent is not a
   reliable base.
2. **The composer is a Lexical `contenteditable`, not a `<textarea>`.** Writing
   `textContent` and dispatching `input` is silently reverted by the editor.
   The supported write is the slot prop `inputActions.setDraft(text)`; the
   supported read is `useInput(state => state.draft)` (`InputState.draft`).
3. **Registering a component must forward the slot props** —
   `slots.register(options, (props) => React.createElement(Comp, props))`.
   Dropping them loses `inputActions` / `useInput` entirely.
4. **`conversation.composer.dock` is a trap in 0.1.7 — put below-the-card content in the
   top dock with flex `order: 2` instead.** Two independent reasons, both verified against
   `dsh-client-ui-conversation`:
   - the seat only renders for `variant === "composer"`, so a hero (new) session has no
     seat below the card at all;
   - since 0.1.7 its wrapper `.uV2eYG_dock` is `display:flex; justify-content:center;
     align-items:center; gap:12px` and also holds `ContextMeter` — a full-width panel
     there shares one line with the meter and both squeeze/overflow (this is the
     "擠在一起" bug of 0.1.7). Its width is also fit-content, so `%` widths lose the
     card's box as their base.

   The fix is *not* a floating layer or an injected `:has()` rule: register the entry in
   the top dock and give its root element flex `order: 2` — a list slot's `SlotOutlet`
   anchor is `display: contents` (`dsh-client-ui-renderer/lib/client.js:762-776`), so the
   entry is a direct flex item of `composerStack` (`flex-direction: column`) and sorts
   after the card. One entry then serves hero and normal sessions alike, and no DOM
   sniffing (`isHeroLayout`) or "is the other copy mounted" flag is needed.
5. **Pointer capture retargets clicks.** Calling `setPointerCapture` on
   `pointerdown` makes the following `mouseup`/`click` land on the capturing
   element, so items stop being selectable. Capture only after the drag
   threshold (4px) and swallow the click that follows a real drag.
6. **Width/centering come from CSS variables, never from measurement.** See (1). A
   `getBoundingClientRect()`-based offset is self-referential: the base you subtract
   from moves with the element you are positioning.

## Uninstall

```sh
dsh plugin --profile web remove scene-template
```

Restart `dsh web`. Nothing else is touched — the bundle only registers slot
entries and one `<style>` tag, both released on unload.

## License

MIT — see the [LICENSE at the monorepo root](https://github.com/wuzhiping/cordis-plugins/blob/main/LICENSE).
