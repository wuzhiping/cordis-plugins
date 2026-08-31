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
- The conversion is mechanical: a small set of ambiguous Simplified
  characters (e.g. `发` → `發` in "发送" but `髮` in "头发") are mapped
  to a single Traditional form. A wrong mapping can be overridden by
  adding the context-specific phrase to `S2T_PHRASES` (longest match
  wins).
- `<html lang>` is not updated to `zh-TW` because the runtime's
  `DOCUMENT_LANGUAGE` table only has `zh-CN` and `en`. Screen readers
  that key off the attribute won't switch, but visual rendering is
  unaffected.
- `locale.preference` schema only accepts `zh` / `en`, so the durable
  preference can never be `zh-TW`. The bundle reasserts the active
  locale on every boot.

## Development

The S→T tables live at the top of `lib/client.js`. To add or correct a
mapping:

1. Edit the `S2T_PHRASES` array (multi-character) **before** the
   `S2T_CHARS` object (single-character). Phrase entries are applied
   first, so they let you override the default single-char map for
   common collocations.
2. Rebuild or copy the file as-is — there is no build step. The
   `dsh-client-modules` registry reads the file's content hash on every
   request, so changes are picked up on the next page reload.
3. Reinstall: `dsh plugin --profile web remove zhtw-traditional-chinese
   && dsh plugin --profile web add file:./zhtw-traditional-chinese` (or
   bump the version in `package.json` if installed from a registry).

To test the patched `lookup` chain without leaving the host, run
`dsh --profile web --dump-config` to inspect the composed tree; the
zhtw bundle's patch shows up under the `zhtw-traditional-chinese` row.

## License

MIT — see the [LICENSE at the monorepo root](https://github.com/wuzhiping/cordis-plugins/blob/main/LICENSE).
