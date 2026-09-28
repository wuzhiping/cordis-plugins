# aife-provider

Ships the **AIFE** pi-ai route as configuration owned by a plugin bundle, so the
Models settings page renders it **without a Delete button**.

The API key is deliberately **not** part of this package. The route keeps
`apiKeyEnv: AIFE_API_KEY`, so the secret stays write-only in
`$DSH_HOME/.credentials.yaml` and never appears in a settings document or here.

## What it supplies

| Field | Value |
|---|---|
| route key | `aife` (inside `llm-pi-ai.providers`) |
| `displayName` | `AIFE` |
| `api` | `openai-completions` |
| `baseURL` | `https://routellm.feg.cn/v1` |
| `models` | `MiniMax-M3` (the only default model) |
| `apiKeyEnv` | `AIFE_API_KEY` — a **reference**, not a secret |

## Why the Delete button disappears

`dsh-client-ui-settings-models` decides whether a provider row is removable with
one line:

```js
removable = hasPath(namespace.user, settingsPath) && !hasPath(namespace.base, settingsPath)
```

`namespace.user` is the profile patch layer; `namespace.base` is every inherited
layer. So a route that a **bundle** layer already supplies is never removable —
and `row.removable` gates the button's very rendering:

```js
row.removable ? <button …>{t('remove')}</button> : null
```

`cordis.patch.yml` in this package therefore carries `llm-pi-ai.providers.aife`
as its own layer. Nothing is blocked at click time; the control is simply not
rendered, so there is no error dialog to explain.

Two consequences worth knowing:

- The route must **not** also be configured in the profile patch
  (`$DSH_PROFILE_DIR/cordis.patch.yml`). A profile-layer `llm-pi-ai` config
  overrides this layer wholesale, and its presence is what makes a row removable
  again. If you move the route back there, the button comes back.
- The Host half writes nothing, on purpose. "Repairing" a missing route by
  writing `providers.aife` into the profile layer would re-create the very entry
  that makes it removable. A missing route is reported as an error naming this
  package's patch file instead.

The API key stays editable: an edit stores the key through the credentials
service and records the reference in the profile layer, while this layer keeps
supplying the rest. The configuration editor merges the two, so no `config`
override is written and the row stays non-removable.

## Installing

```
plugin_manager install_bundle  ->  C:\Users\shawoo\Desktop\feg.cn\cordis-plugins\aife-provider
```

`plugin_manager` writes the bundle into `dsh.profile.bundles` as a `link:`
dependency, so moving this directory afterwards invalidates that link — reinstall
from the new path instead of editing the manifest by hand.

Active in the `web` profile. The layer composes when `dsh web` starts.

## Checks

`node check.mjs` reads `cordis.patch.yml` and asserts the composition the page
needs: the plugin row inserted, the layer targeting `llm-pi-ai` with no `name`
assertion, the route carrying every field the Host half also asserts, the model
list, and that no field holds secret material.

## Removing it

Delete the bundle. The route then has no provider in any layer, and the Models
page will no longer list it at all — recreate it from the page if you want it
back as a plain, removable entry.
