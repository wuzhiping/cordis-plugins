# Custom-plugin surface translation brief — Chinese → Vietnamese

Some bundles installed in this DSH profile never call `ctx.locale`; their UI copy
is hardcoded Chinese (Traditional or Simplified, often mixed). The vi-VN locale
bundle translates those surfaces at render time through a scoped dictionary, so
every string below must be translated by hand.

Read `GLOSSARY.md` first — the same terminology and tone apply. Then translate
your packet `translations/custom-chunk-NN.json` into
`translations/custom-vi-NN.json`:

```json
{ "<exact zh key>": "<Vietnamese>" }
```

## Entry kinds

Each entry is `{ "zh": …, "kind": "exact" | "fragment" | "dynamic", "plugins": [...] }`.

- **exact** — the string is a whole text node, button label, title, placeholder
  or `aria-label`. Translate it as a standalone UI string.
- **fragment** — the plugin builds the visible sentence by concatenation, e.g.
  `count + " 個主題未連線"` or `"共 " + count + " 項"`. The **leading/trailing
  spaces and punctuation in the key are part of the layout**: keep exactly the
  same leading/trailing whitespace and punctuation in the value. Translate only
  the words so the fragment reads naturally with a number in front of / behind
  it. Example: `" 個主題未連線"` → `" chủ đề chưa kết nối"` (renders
  `4 chủ đề chưa kết nối`).
- **dynamic** — a template; `{x}` marks an interpolated value. Keep each `{x}`
  placeholder exactly once, in a position that reads naturally in Vietnamese:
  `"上傳失敗{x}：{x}"` → `"Tải lên thất bại{x}: {x}"`. Do not reorder or rename
  them, and do not drop any.

## Rules

1. **Exact key set**: one output key per input `zh`, byte-for-byte identical
   (including emoji, leading/trailing spaces, internal `\n`, `·`, `—`, `❯`).
   No extra keys, none missing.
2. **No Chinese characters in values** — if a proper name is Chinese (e.g.
  `"#Jinbe"` stays, `"MinIO"` stays, `"API Key"` stays) keep only non-Chinese
  tokens; translate the Chinese words around them.
3. Keep **emoji and decorative symbols** (`🌃`, `☀️`, `⬆︎`, `⚠️`, `✦`, `✿`,
   `└`, `↑`, `✓`, `…`) in place.
4. Keep technical tokens: `API`, `API Key`, `MCP`, `MinIO`, `S3`, `DSH`, `URL`,
   `JSON`, `X-Frame-Options`, `SameSite=Lax`, `iframe`, `topic`, `agent`,
   `workspace`, `docs`, file paths/commands, keyboard keys, `{x}`.
5. **Tone**: Vietnamese UI, neutral, user-facing; buttons short, sentence case,
   no trailing period unless the source has one. Address the user as `bạn`.
   cute-clock copy is playful/encouraging — keep that voice, don't flatten it.
6. UI space is tight — prefer the shortest natural wording for labels/buttons.
7. Output must be valid UTF-8 JSON (no comments, no trailing commas); escape
   `\n` and quotes properly.

## Context per plugin

| plugin | surface |
|---|---|
| `cute-clock` | the clock card / panel: greeting, slogan, usage block ("💰 用量"), date header, buttons |
| `ntfy-teams` | team notification panel: subscriptions, connection status, composer, markdown viewer |
| `fdep-api-request-bundle` | "MCP網關" panel: API id input, docs/params/execute steps, history, result viewer |
| `kaneo-web` | "管線看板" panel: setup card (API Key, URL), iframe loading/fallback hints |
| `dsh-minio-s3` | "MinIO" tab: bucket/object browser, upload/progress, presign/copy/delete dialogs |
| `dsh-file-share` | "檔案分享" tab: file list, download/share actions, preview dialog |

Extra context: `plugins` field names the bundle(s) using the string; `kind`
tells you whether it is standalone or a fragment. When a fragment's translation
would be grammatical only with a preceding number, phrase it that way (the
number is always right before it).

Validate before finishing: JSON parses, key set equals the packet's `zh` set,
placeholder counts match, no CJK in values, leading/trailing spaces preserved for
`fragment` entries.
