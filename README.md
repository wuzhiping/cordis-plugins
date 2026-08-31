# cordis-plugins

A monorepo of DSH (DeepSeek Harness) profile bundles — community packages
that install into a DSH profile via `dsh plugin --profile <name> add`.

Each subdirectory is one self-contained bundle: its own `package.json`,
`cordis.patch.yml`, and (where applicable) browser bundle under `lib/`.
Bundles declare `dsh.bundle.patch` so they can be added to a profile's
`dsh.profile.bundles` layer, and (where they affect the browser) a
`dsh.client.platform: "web"` so the `@deepseek-ai/dsh-client-modules`
registry picks up their `lib/client.js`.

## Bundles

| Subdirectory | Purpose | Install |
|--------------|---------|---------|
| [`zhtw-traditional-chinese/`](./zhtw-traditional-chinese) | Adds 繁體中文 (zh-TW) to the Web GUI language picker; converts Simplified Chinese strings from all 27 DSH namespaces to Traditional on the fly | `dsh plugin --profile web add web add "github:wuzhiping/cordis-plugins#path:/zhtw-traditional-chinese"` |

Each subdirectory is also a standalone DSH install target — you can add
`file:./zhtw-traditional-chinese` while inside this repo, or use the GitHub
short reference above.

## What lives where

```
cordis-plugins/
├── README.md                   this file (monorepo overview)
├── LICENSE                     shared MIT
└── zhtw-traditional-chinese/   first bundle
    ├── package.json            dsh.bundle + dsh.client declarations
    ├── cordis.patch.yml        host composition patch
    ├── lib/
    │   └── client.js           window.__ModuleLoader__.load bundle
    ├── README.md               bundle-specific docs
    └── LICENSE                 (symlink or duplicate; both MIT)
```

## Adding a new bundle

1. Create a subdirectory with a `package.json` declaring
   `dsh.bundle.patch: "./cordis.patch.yml"`.
2. The `cordis.patch.yml` should add one or more host plugin rows whose
   `name` matches the bundle's package name (or any sub-package you also
   ship). The row's existence is what the
   `@deepseek-ai/dsh-client-modules` registry uses to discover the
   client module.
3. If the bundle has browser-side code, write `lib/client.js` as a CJS
   bundle wrapped in `window.__ModuleLoader__.load({id, factory})` and
   declare `dsh.client.platform: "web"` in `package.json`. The factory
   returns `{ inject, apply }` — the same shape that
   `cordis_define` accepts, but no `code.client`/`code.host` wrapper
   and no run-time approval.
4. Add a row to the table above linking to the new bundle's README.

## Installing this monorepo

A DSH install command points at one bundle, not the whole repo. The
GitHub short reference accepts a subdirectory path:

```sh
dsh plugin --profile web add github:wuzhiping/cordis-plugins/<bundle-name>
```

For a local clone:

```sh
git clone https://github.com/wuzhiping/cordis-plugins.git
cd cordis-plugins
dsh plugin --profile web add ./<bundle-name>
```

After any `dsh plugin add` or `remove`, restart the running DSH web
process for the change to take effect.

## License

MIT — see [`LICENSE`](./LICENSE).
