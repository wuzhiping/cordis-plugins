# no-browser-auth

> A DSH (DeepSeek Harness) profile bundle that turns **off** the Web
> transport's browser-session check, so the GUI opens from a plain local URL
> instead of the one-time launch-token URL.

DSH authenticates every browser request in two independent halves:

| Half | Owner | What it stops |
|------|-------|---------------|
| Host/Origin trust fence | `isTrustedApiRequest()` | Cross-site and DNS-rebinding requests to the local API (403) |
| Browser session | `BrowserAuth` | Anyone who has not exchanged the process launch token for a signed cookie (401) |

This bundle disables **only the second half**. The fence keeps rejecting
`sec-fetch-site: cross-site`, untrusted `Host`, and foreign `Origin` on `/api`,
so a random web page in the same browser still cannot drive your local
Harness.

## What changes

- `http://127.0.0.1:3080/` loads with no cookie and no `?token=…` query.
- Anonymous `POST /api/...` requests reach the gateway instead of a 401.
- The startup line still prints `…?token=…` (that URL is now inert — the token
  is simply ignored, nothing validates it any more).
- The 401 body `dsh web authentication required; reopen the URL printed by dsh
  web.` no longer appears.

## Install

This bundle lives in the [`cordis-plugins`](https://github.com/wuzhiping/cordis-plugins)
monorepo under `no-browser-auth/`.

```sh
# from the monorepo checkout
dsh plugin --profile web add ./no-browser-auth

# or by GitHub subdirectory
dsh plugin --profile web add github:wuzhiping/cordis-plugins/no-browser-auth
```

`dsh plugin` only edits `~/.dsh/profiles/web/` — it does not relaunch the
running host. **Restart the `dsh web` process** for the row to be composed.
(`dsh plugin` initializes the profile on first use, runs `pnpm add` inside it,
then appends every dependency whose manifest declares `dsh.bundle` to
`dsh.profile.bundles`.)

## Verify

Open `http://127.0.0.1:3080/` in a browser that has never seen the token URL,
or with cookies cleared entirely. The GUI should load.

From a shell, with no cookie:

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/          # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"probe","method":"probe","payload":{}}' \
  http://127.0.0.1:3080/api/probe                                        # 404, not 401
```

The fence is still there — both of these stay rejected:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -H 'sec-fetch-site: cross-site' http://127.0.0.1:3080/api/probe   # 403
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example.com'     http://127.0.0.1:3080/api/probe   # 403
```

The host log shows one line at boot:

```
no-browser-auth: browser-session verification disabled; the Host/Origin fence is unchanged
```

## Uninstall

```sh
dsh plugin --profile web remove no-browser-auth
```

Restart `dsh web`. Browser sessions are enforced again, and the launch-token
URL printed at startup is required once more.

## How it works

`package.json` declares `dsh.bundle.patch`; `cordis.patch.yml` appends one
root row whose `name` is this package:

```yaml
- insert:
    - id: no-browser-auth
      name: no-browser-auth
```

The loader resolves that name from the profile's `node_modules`, imports
`lib/index.js`, and mounts it. The plugin declares `inject: ['connection']`, so
Cordis parks it until the Client Connection transport is live (and re-applies
it if the transport is ever re-provided).

`HostConnectionService` is the only reader of `BrowserAuth`, and it reaches it
from exactly two methods:

```
HostConnectionService#requestRejection(request)   → fence (403) → browserAuth.isAuthenticated(request) ? ok : 401
HostConnectionService#authorizeIndex(request, res) → browserAuth.authorizeIndex(request, res)
```

Every consumer calls those two methods *through the live `connection`
service* — `@deepseek-ai/dsh-api-gateway` and the connection plugin's own
`/api` route use `requestRejection`, `@deepseek-ai/dsh-host-frontend-static`
uses `authorizeIndex`. So replacing `isAuthenticated` and `authorizeIndex` on
the live `connection.browserAuth` instance covers every entry point at once,
while `requestRejection`'s fence is left running.

The patch is registered with `ctx.effect()`, so stopping, removing, or
re-providing the plugin restores the original methods — no forked DSH package,
no edited sources. `node test/smoke.js` checks the whole contract (bypass
installed, fence preserved, restoration exact) without restarting a host.

## Security

This removes the only protection that distinguishes "the person who launched
`dsh web`" from "any local process or any web page that can reach the port".
What still protects you:

- the Host/Origin fence on `/api` (no cross-site, no untrusted authority, no
  foreign `Origin`);
- the bind address (`webServer.host`, `127.0.0.1` by default).

Because of that, **do not combine this bundle with a non-loopback bind**
(`--host 0.0.0.0`, a LAN address, a tunnel, a reverse proxy) unless something
in front of it authenticates. If you need remote access with the session check
intact, keep this bundle uninstalled and use the printed `?token=…` URL.

## Limitations

- It patches runtime objects, not a configuration knob. A future DSH release
  that stops routing these checks through `connection.browserAuth` makes the
  plugin a no-op — the boot line above then still prints, but the 401 behaviour
  returns. Verify with the curl probes after a DSH upgrade.
- A reload of the Client Connection row re-creates `browserAuth`; Cordis
  re-applies this plugin because of `inject`, so the bypass follows
  automatically.
- `?token=…` is ignored rather than redirected away, so a bookmarked
  token URL keeps the query string in the address bar. It is cosmetic.

## Development

No build step: `lib/index.js` is the shipped file, loaded directly by the host
loader.

```sh
node test/smoke.js
```

After editing, restart `dsh web` (the host imports the module once at boot).

A local-path install (`dsh plugin --profile web add ./no-browser-auth`) becomes a
`link:` dependency, i.e. a symlink in the profile's `node_modules` pointing back
at this directory — so `lib/index.js` edits are picked up by the next restart
with no reinstall. A git/registry install is a real copy: re-run
`dsh plugin --profile web add <spec>` (or bump `version`) so pnpm refreshes it.

## License

MIT — see the [LICENSE at the monorepo root](https://github.com/wuzhiping/cordis-plugins/blob/main/LICENSE).
