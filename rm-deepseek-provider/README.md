# rm-deepseek-provider

Disables the DeepSeek LLM provider routes so no model surface offers them:

- **Settings → Models** — no DeepSeek card (and no first-run prompt for a
  `DEEPSEEK_API_KEY`).
- **Composer model menu and `/model` popup** — no DeepSeek provider group,
  in an existing session or in a new one.

## How it works

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

## Scope

DeepSeek web search/fetch (`web-search-deepseek`, `web-deepseek-api`) and the
DeepSeek account service are separate rows and stay untouched; only the two LLM
provider routes are removed from model selection.

## Revert

Disable or remove this bundle in the Plugins page. The rows return to their
previous state; the DeepSeek configuration in the profile patch is unchanged.
