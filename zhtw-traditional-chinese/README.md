# zhtw-traditional-chinese

> A DSH (DeepSeek Harness) profile bundle that adds **繁體中文 (zh-TW)** to the
> Web GUI language picker and converts every Simplified Chinese UI string
> shipped by DSH into Traditional on the fly.

DSH ships with two languages — Simplified Chinese (`zh`, labelled "中文") and
English (`en`). Traditional Chinese is not built in. This bundle monkey-patches
`LocaleRuntime` so:

1. The Language picker grows a third row, `繁體中文`, which becomes the
   default on activation.
2. All 27 shipped namespaces' `zh` dictionaries are converted to `zh-TW` per
   call through a Simplified-to-Traditional character/phrase table, so every
   label, button, menu, and command description that has a Chinese source
   string renders in Traditional without per-package dictionaries.
3. Two namespaces (`common` and `settings.locale`) have hand-curated
   `zh-TW` entries that override the character conversion where idiomatic
   wording matters.

The conversion is purely runtime — no source data is mutated, no DSH package
is forked, and uninstalling returns the runtime to its shipped behaviour.

## Install

This bundle lives in the [`cordis-plugins`](https://github.com/wuzhiping/cordis-plugins)
monorepo under `zhtw-traditional-chinese/`.

Add it to the `web` profile:

```sh
dsh plugin --profile web add "github:wuzhiping/cordis-plugins#path:/zhtw-traditional-chinese"

```

If you cloned the monorepo locally, use the relative path:

```sh
git clone https://github.com/wuzhiping/cordis-plugins.git
cd cordis-plugins
dsh plugin --profile web add ./zhtw-traditional-chinese
```

Other install forms work too: a `file:` URL, an absolute path, or a tarball.

Then **restart** the running DSH web process — `dsh plugin` only edits
`~/.dsh/profiles/web/`, it does not relaunch the host.

The first boot after install resolves the bundle, applies its
`cordis.patch.yml`, and registers a host plugin entry that the
`@deepseek-ai/dsh-client-modules` registry discovers (via the package's
`dsh.client.platform: "web"` declaration). The browser then fetches
`/plugins/zhtw-traditional-chinese/client.js` and materializes the patch
factory, which switches the active locale to `zh-TW`.

## Verify

Open the DSH web UI → **Settings → General → Language**. The picker should
show three options: `中文` (zh-CN), `繁體中文` (zh-TW, selected by default),
and `English`.

The settings panel chrome (`Settings`, `General`, `Close`, `Open
configuration file`) and most shell strings should render in Traditional.
Hardcoded English labels registered as `label: "Workspaces"` etc. stay in
English — that is a property of the source plugin, not the runtime.

## Uninstall

```sh
dsh plugin --profile web remove zhtw-traditional-chinese
```

The removal purges the dependency from `~/.dsh/profiles/web/package.json`
and removes the bundle from `dsh.profile.bundles`. Restart DSH web to take
effect. The original `LocaleRuntime` is unaffected because this bundle's
disposers restore the patched methods on stop.

## How it works

A single browser-side plugin loaded into the client composition:

- `package.json` declares both `dsh.bundle.patch` (so `dsh plugin add` can
  install it as a profile layer) and `dsh.client.platform: "web"`
  (so `@deepseek-ai/dsh-client-modules` lists it in `window.__DSH_BOOT__`).
- `cordis.patch.yml` adds a host plugin entry whose `name` is the package
  itself; that entry is the trigger the modules system reads.
- `lib/client.js` is a CJS bundle wrapped in
  `window.__ModuleLoader__.load({ id, factory })`. The factory closes over
  the S→T tables and returns a Cordis plugin with
  `inject: ['locale']` whose `apply(ctx)`:

  1. **Patches `publish`** to keep a `zh-TW` entry in `snapshot.locales`
     so the Language picker shows three options.
  2. **Patches `setLocale`** to accept `'zh-TW'` (the shipped runtime
     rejects unknown locale ids).
  3. **Patches `lookup`** to fall back to the `zh` value plus a
     S→T conversion **before** the `en` fallback. Without this reordering
     the existing `en` fallback would always win and the conversion
     would never run.
  4. **Registers** explicit `zh-TW` dictionaries for `common` and
     `settings.locale` (overrides the conversion for those 23 keys).
  5. **Calls `setLocale('zh-TW')`** to make Traditional the active
     language immediately.

The `ctx.effect()` disposer restores the original methods on plugin stop.

## Limitations

- Hardcoded English labels registered as plain string slot options stay
  English. They never go through `t()`.
- Ambiguous Simplified characters are resolved by OpenCC's preferred reading
  plus the phrase table (`发` → `發` in 发送, `髮` in 头发). Where a phrase is
  still wrong for this product's register, add it to `OVERRIDES` in
  `test/build-tables.js` and regenerate — longest match wins, and overrides are
  applied before everything else.
- **User content is never converted**, by design. Session titles, message text,
  code and file paths are data, not UI copy: the conversion only runs on the
  dictionaries DSH renders through `locale.lookup`. A title the model wrote in
  Simplified Chinese therefore stays as it was written. Converting those too
  would mean a DOM pass, which also risks rewriting code samples and paths —
  ask before adding one.
- `<html lang>` is not updated to `zh-TW` because the runtime's
  `DOCUMENT_LANGUAGE` table only has `zh-CN` and `en`. Screen readers
  that key off the attribute won't switch, but visual rendering is
  unaffected.
- `locale.preference` schema only accepts `zh` / `en`, so the durable
  preference can never be `zh-TW`. The bundle reasserts the active
  locale on every boot.

## Table coverage

The S→T tables in `lib/client.js` are **generated**, not hand-written, and they
are checked against what DSH actually ships:

| | entries | provenance |
|---|---|---|
| `S2T_CHARS` | ~2600 | OpenCC `STCharacters` (complete), composed with `TWVariants` |
| `S2T_PHRASES` | ~360 | 181 hand-curated idioms (kept verbatim) + overrides + the OpenCC `TWPhrases`/`STPhrases` entries that DSH's corpus needs |

An earlier revision was hand-written (317 characters, 181 phrases). Anything
outside that set reached the screen unchanged — live examples were
`收合侧边栏`, `搜尋工作階段名称`, `檢視選项`, `预設`. The tables are now complete for
DSH's strings: every Simplified character used by the 5545 Chinese strings in the
48 web client bundles has a mapping, verified against OpenCC's tables
(`node test/run-all.js`).

The phrase table stays small on purpose: an OpenCC phrase is only kept when it
disagrees with what the character map alone would produce (that is where the
Taiwan idiom lives — 全局→全域, 演示文稿→簡報, 四舍五入→四捨五入) and when DSH's
corpus actually contains it.

`convertS2T` is a **single left-to-right pass with longest-match** at each
position. The earlier version applied every phrase as a global replacement in
sequence, which let a phrase rewrite another phrase's output: `客户端` →
`用戶端` → `使用者端`, because `用戶→使用者` fired on the finished result.

## Branding

The same bundle rebrands the shell for this deployment: `BRAND_NAME`
(`企業數位員工@AIFE`) replaces the sidebar banner, the wordmark in
`document.title` and the PWA manifest, and `BRAND_HEADLINE` (per locale)
replaces the hero headline. The sidebar/hero overrides are CSS against
`hHd-Xa_*` / `pXSMma_*` class hashes emitted by the DSH build — **they can go
stale after a DSH upgrade** and need refreshing from the current DOM.

The new-session hero headline keeps the brand but drops the greeting:
`BRAND_HEADLINE` overrides `conversation.hero.headline` with
`企業智慧數位員工@AIFE` — no `歡迎使用` / `Welcome to` prefix — still in the
sapphire brand colour. Two ways back, both one-liners in `lib/client.js`:

| Want | Change |
|---|---|
| DSH's own copy (`探索未至之境` / `Into the Unknown`) | drop the `conversation: { "hero.headline": … }` entry from `BRAND_STRINGS` |
| no headline line at all | add `.pXSMma_headline{display:none!important}` to `BRAND_CSS` |

Only the headline is affected: the sidebar banner, `document.title`, favicon and
PWA manifest keep the brand either way.

### The mark is a PNG, not the 💡 emoji

The brand mark used to be the `💡` emoji, rendered in three places (the sidebar
banner, the hero headline, and the collapsed rail). It is now the feg.cn logo as
a **48×48 PNG embedded in `lib/client.js` as a `data:image/png;base64,` URL**
(`BRAND_ICON_DATA_URL`), drawn as a CSS background box at each placement:

| where | element | box |
|---|---|---|
| sidebar banner | `.hHd-Xa_brand::before` (icon box + `padding-left`, the brand name is its text) | 16px |
| hero headline | `.pXSMma_headline::before` | 24px |
| collapsed 56px rail | `.hHd-Xa_railMark::before` | 20px |

Two constraints decided this shape:

- **A plugin directory has no HTTP route.** Only `<plugin>/client.js` is served
  (via the module group at `/plugins/??…`), so an `url(logo.png)` or `<img src>`
  would 404 and the asset has to travel inside the bundle.
- **`padding` alone does not reserve space for a generated box.** Here the draw
  sites are flex items, whose padding box collapses to zero; each rule therefore
  sets an explicit `width`/`height` and positions the background inside it.

48px is the master size: it covers the 24px headline at 2× DPR, and the browser
downsamples it for the 20px and 16px placements (1.9 KB of base64, versus 1.3 KB
at 32px). To swap the logo, regenerate the data URL at 48×48 with alpha and
replace the one constant; to change a size, edit that placement's `background`
shorthand plus its `width`/`height`. The favicon is still the separate inline
`BRAND_FAVICON_SVG` (the `f` tile), so nothing there moves with the mark.

> A raster mark cannot follow the theme, and this one is a dark teal on a dark
> sidebar in dark mode. The bundle keeps the original colours; a dark-mode variant
> would need a second data URL and a `@media (prefers-color-scheme: dark)` swap.

> Client bundles are served as one module group whose content is cached until the
> profile reloads. After a `lib/client.js` edit, trigger a profile reload — for
> example re-run `plugin_manager install_bundle` on this bundle — which rebuilds
> the group under a **new `rev`**; a page refresh then picks the edit up with no
> host restart. A plain refresh on its own keeps serving the cached copy (same
> `rev`), and `restart-required` from the installer refers to the host-side row,
> not to whether the browser half got republished.

## Development

Everything below runs offline; only the `audit-dom` tools touch a browser.

```sh
# 1. regenerate the tables (needs the OpenCC .txt files, see test/opencc.js)
node test/build-tables.js --dry     # show what would change
node test/build-tables.js           # write lib/client.js

# 2. check the result
node test/run-all.js                # 45 checks: known pairs, curated table
                                    # integrity, single-pass invariant, coverage

# 3. look at what DSH ships, and at what the GUI shows
node test/audit-corpus.js           # every string in the client bundles
node test/audit-dom.js              # the RUNNING GUI
node test/audit-dom.js --click 設定,外掛   # …with dialogs opened first
```

- `test/audit-corpus.js` splits characters the table does not know into
  "OpenCC would convert these" (real misses — must be empty) and "already
  Traditional" (leave alone).
- `test/audit-dom.js` reports **path misses** (text containing a character the
  table knows — i.e. text that never travelled through `lookup`) separately from
  **table gaps**, and flags anything still Simplified on screen.
- `test/curated-tables.json` holds the hand-curated half; `test/build-tables.js`
  always starts from it, never from the generated output (otherwise a generated
  entry would look hand-picked forever).
- `test/s2t.js` mirrors the bundle's converter so the tools can never disagree
  with the shipped code.
- `test/sweep-simplified.js` and `test/sweep-settings.js` walk the live GUI surface
  by surface (main views; then every Settings sub-page) and
  `test/verify-mcp-and-simplified.js` does the same for one panel plus the
  `MCP網關` label. All three classify each rendered string with the shipped table:
  **Simplified** (a Simplified-only character that would change — must be 0) vs
  **zh-TW phrasing** (already Traditional text whose phrasing the table's
  preference list would still rewrite, e.g. `文件 → 檔案`, `參數 → 引數`). Only the
  first kind is a defect; the second is a wording preference, so read the list
  before acting on it.
- There is no build step: `lib/client.js` is served as-is. After editing it,
  either restart `dsh web` or copy the file into
  `~/.dsh/profiles/web/node_modules/zhtw-traditional-chinese/lib/` (the running
  host re-reads the file when its watch is alive and the browser fetches the new
  revision; a page reload picks it up).
- A DSH upgrade should be followed by `node test/run-all.js` — new UI strings
  may introduce characters the tables lack, and the audit names them.

To test the patched `lookup` chain without leaving the host, run
`dsh --profile web --dump-config` to inspect the composed tree; the
zhtw bundle's patch shows up under the `zhtw-traditional-chinese` row.

**OpenCC data** (Apache-2.0) is an *input*, never shipped: the bundle carries
only the corpus-filtered result. Fetch it with:

```sh
curl -o "$TEMP/zhtw-opencc/STCharacters.txt" https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/STCharacters.txt
# …and STPhrases.txt, TWPhrases.txt, TWVariants.txt
```

## License

MIT — see the [LICENSE at the monorepo root](https://github.com/wuzhiping/cordis-plugins/blob/main/LICENSE).
