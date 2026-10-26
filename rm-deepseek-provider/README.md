# rm-deepseek-provider

Package name: `@local/rm-deepseek-provider` (scoped — see
[Why the package name is scoped](#why-the-package-name-is-scoped)).

Two independent cleanups for a deployment that runs its own model gateway:

1. **No DeepSeek in the model surfaces.**
   - **Settings → Models** — no DeepSeek card (and no first-run prompt for a
     `DEEPSEEK_API_KEY`).
   - **Composer model menu and `/model` popup** — no DeepSeek provider group,
     in an existing session or in a new one.

2. **No third-party plugin install from the GUI.**
   - **Plugins page (Plugin Manager)** — the "Add plugin" button and its
     dropdown (whose entry is "Install a third-party plugin" / 安装第三方插件)
     are hidden. Both opened the same install dialog; both are gone now.
     Installed bundles keep their switches and uninstall actions.

## How it works

### 1. Provider routes (Host half)

`cordis.patch.yml` patches two existing loader rows, which keeps every plugin
package installed but stops the rows from activating:

| Row                    | Provider route       |
| ---------------------- | -------------------- |
| `llm-deepseek`         | `deepseek-official`  |
| `llm-deepseek-account` | `deepseek-account`   |

A disabled row never registers its adapter, so `ctx.llm.listProviders()` stops
listing the route. Both surfaces are projections of that live registry:
Settings → Models joins `llm/listProviders` with `llm/listConfigurableProviders`,
while the composer and `/model` read `session.modelCatalog`. No browser-side
filtering is involved.

`index.js` is a Host half that only observes the settled registry and logs
whether the routes are actually gone, so a later patch layer that re-enables a
row is loud instead of silently restoring the picker entries.

The profile's own `cordis.patch.yml` keeps the `llm-deepseek` configuration
(gateway `baseURL`, model list) and never sets `disabled`, so this bundle
layer's override survives the later profile layer.

### 2. Plugin Manager install controls (Client half)

`client.js` hides the add-plugin group of the Plugins page. It selects by plain
attributes, never by a hashed CSS-module class:

```css
[data-plugin-panel] span[role="group"][aria-label] { display: none !important; }
```

`[data-plugin-panel]` is the Plugins page root; the group is the page's only
`span[role="group"][aria-label]`. The page's other `role="group"` is the
install-approval `<section>`, which uses `aria-labelledby` and therefore does
not match. The rule is locale-independent — no text is matched — so it holds
for every UI language.

Two layers, as in the sibling `sidebar-plugins-toggle` plugin: the stylesheet
rule (survives React re-renders) plus an inline `display:none` mark reapplied
by a MutationObserver (covers a group that was already mounted when the client
half started). Diagnostics are published as a keyed slot occupant whose key the
page never dispatches, so nothing renders; read them with

```
cordis_inspect_query  platform=client  provider=Slots  method=listSubTree  root=plugins.row.config
```

which reports `rmdp-diag:panel=… group=… disp=…` (`panel` counts mounted
Plugins pages, `group` counts hidden add-plugin groups).

### Why the package name is scoped

The package is `@local/rm-deepseek-provider`. The client module service caches
each package manifest per (resolution base, module specifier) until the process
restarts, and a profile that loaded this bundle *before* it declared
`dsh.client` keeps the "not a client package" verdict cached under the old
specifier — the browser half would then only join the module graph after a
host restart. A scoped package name is a different specifier, so the manifest is
read again and the browser half registers in a running host. The scope also
keeps the name out of the public npm namespace, like the sibling
`@local/aife-provider`.

## Scope

- DeepSeek web search/fetch (`web-search-deepseek`, `web-deepseek-api`) and the
  DeepSeek account service are separate rows and stay untouched; only the two
  LLM provider routes are removed from model selection.
- Official optional bundles listed on the Plugins page keep their own cards and
  switches; only the third-party install path is hidden.
- A contributed Plugins tab (the plugin market's "Discover", when that bundle is
  installed) carries its own install action and is not affected — install that
  bundle only if third-party installs should stay possible.

## Revert

Disable or remove this bundle in the Plugins page. The rows return to their
previous state, the add-plugin controls come back, and the DeepSeek
configuration in the profile patch is unchanged.
