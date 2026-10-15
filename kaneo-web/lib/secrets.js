'use strict';

// =============================================================================
// kaneo-web —— 遮蔽金钥（mask key）与凭证档解析
//
// 这一层是参考 ntfy-teams 做出来的：远端 BDD 储存端点要求用一把**遮蔽过的**
// 金钥去换资料，而金钥原文住在宿主的凭证档（`$DSH_HOME/.credentials.yaml`）里。
//
//     ts     = "@" + ISO 時間戳          // "@2026-10-15T07:39:06.000Z"
//     masked = "sk-" + base64(key + ts)
//
// 两个刻意的选择：
//
//   1. **原文永远不离开宿主**。遮蔽在这里算完才回给浏览器；把原文送到浏览器
//      只为了再遮蔽一次，反而让原文出现在 DevTools、记忆体与任何截图里。
//      这一条由测试钉住：回传物件的任何栏位都不得包含原文。
//   2. 算法与 ntfy-teams 的实作一字不差（同一份 MASK.md 的公式）。两个外挂
//      各自维护一份是不得已（外挂之间不互相 require），所以两边都有测试
//      把公式钉死，任何一边漂移都会红。
//
// 遮蔽**不是加密**：知道算法与时间戳的人可以还原。它在这里的用途是「不要
// 在网路上直送原文」，不是「保护原文不被看见」。
// =============================================================================

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 遮蔽值的前缀（与 MASK.md 一致）。 */
const MASK_PREFIX = 'sk-';

/**
 * 拿来遮蔽的金钥候选参照名（依优先序）。
 *
 * 这份清单是被实测逼出来的，不是猜的：这台机器真正在用的
 * `$DSH_HOME/.credentials.yaml` 里参照名是 `AIFE_API_KEY`；`FEG_API_KEY`
 * 在别的环境才存在。按序试，取第一个存在的参照，换环境就不必改程式。
 */
const MASK_KEY_REFS = ['AIFE_API_KEY', 'FEG_API_KEY', 'DEEPSEEK_API_KEY'];

/**
 * 把金钥遮蔽成 `sk-` + base64(key + "@" + ISO)。
 *
 * @param key - 原始金钥（非空字串）。
 * @param now - 产生遮蔽值的时刻（测试可钉住）。
 * @returns 遮蔽后的字串。
 * @throws 当 key 不是非空字串。
 */
function maskKey(key, now) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('maskKey: key 必须是非空字串');
  }
  const stamp = '@' + (now instanceof Date ? now : new Date()).toISOString();
  return MASK_PREFIX + Buffer.from(key + stamp, 'utf8').toString('base64');
}

/**
 * DSH 凭证档的路径。
 *
 * 顺序：`DSH_CREDENTIALS_PATH`（测试与特殊部署用覆写）→ `$DSH_HOME/.credentials.yaml`
 * → `~/.dsh/.credentials.yaml`。找不到任何存在的档案时回**第一个候选**，
 * 让呼叫端的错误讯息能指出它预期在哪里。
 *
 * @returns 绝对路径。
 */
function credentialsFilePath() {
  const override = process.env.DSH_CREDENTIALS_PATH;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, '.credentials.yaml');
}

/**
 * 从凭证档文字里取出 `refs.<name>`。
 *
 * 为什么自己写一个最小 parser 而不引入 YAML 套件：这个档案由 DSH 自己写，
 * 形状固定（`refs:` 底下两空格缩排的 `名称: 値`），而本外挂维持零执行期依赖。
 * 只认这一种形状，认不出来就回 null（上层会回一份带原因的失败）。
 *
 * @param text - 档案内容。
 * @param name - 参照名，例如 `AIFE_API_KEY`。
 * @returns 值；找不到回 null。
 */
function readCredentialRef(text, name) {
  if (typeof text !== 'string' || typeof name !== 'string' || name === '') return null;
  const lines = text.split(/\r?\n/);
  let inRefs = false;
  let refsIndent = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (/^refs:\s*$/.test(trimmed)) {
      inRefs = true;
      refsIndent = indent;
      continue;
    }
    if (!inRefs) continue;
    if (indent <= refsIndent) { inRefs = false; continue; }   // refs 区块结束

    const m = trimmed.match(/^([A-Za-z0-9_.\-]+):\s*(.*)$/);
    if (!m || m[1] !== name) continue;
    let value = m[2].trim();
    if (value === '') return null;
    if ((value.charAt(0) === '"' && value.charAt(value.length - 1) === '"')
      || (value.charAt(0) === "'" && value.charAt(value.length - 1) === "'")) {
      value = value.slice(1, -1);
    }
    return value === '' ? null : value;
  }
  return null;
}

/**
 * 从凭证档读出第一个存在的候选金钥（读**档案**这条路）。
 *
 * 这条路是后备：优先走宿主的 `ctx.credentials` 服务，它认得环境变数与
 * 各种 provider 的分层。档案只在服务不可用时才用。
 *
 * @param options - `{ refs, file }`，测试用。
 * @returns `{ ok, key, ref, source }` 或 `{ ok:false, error, tried, file }`。
 */
function keyFromCredentialsFile(options) {
  const opts = options || {};
  const refs = Array.isArray(opts.refs) && opts.refs.length > 0 ? opts.refs : MASK_KEY_REFS;
  const file = typeof opts.file === 'string' && opts.file !== '' ? opts.file : credentialsFilePath();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return {
      ok: false,
      file: file,
      tried: refs,
      error: '讀不到憑證檔（' + file + '）：' + (err && err.message ? err.message : String(err))
    };
  }
  for (let i = 0; i < refs.length; i += 1) {
    const key = readCredentialRef(text, refs[i]);
    if (key) return { ok: true, key: key, ref: refs[i], source: file };
  }
  return {
    ok: false,
    file: file,
    tried: refs,
    error: '憑證檔裡找不到可用的金鑰（試過 ' + refs.join('、') + '）——檔案：' + file
  };
}

/**
 * 取得一把可用来遮蔽的金钥：先问宿主凭证服务，再退回读档案。
 *
 * @param ctx - Cordis 上下文（可为 null，测试用）。
 * @param options - `{ refs, file }`，测试用。
 * @returns Promise<{ ok, key, ref, source } | { ok:false, error, tried, file }>。
 */
async function resolveMaskSource(ctx, options) {
  const opts = options || {};
  const refs = Array.isArray(opts.refs) && opts.refs.length > 0 ? opts.refs : MASK_KEY_REFS;

  const credentials = ctx !== null && ctx !== undefined && typeof ctx.get === 'function'
    ? ctx.get('credentials')
    : null;
  if (credentials !== null && credentials !== undefined && typeof credentials.resolve === 'function') {
    for (let i = 0; i < refs.length; i += 1) {
      try {
        const resolved = await credentials.resolve(refs[i]);
        const value = resolved !== null && resolved !== undefined && typeof resolved.value === 'string'
          ? resolved.value
          : '';
        if (value !== '') {
          return { ok: true, key: value, ref: refs[i], source: resolved.source || 'credentials' };
        }
      } catch (err) {
        // 这个参照名不成立就换下一个；全部失败才回下面的错误。
      }
    }
    // 服务在，但一个参照都解析不出值 —— 仍然给档案一次机会（可能 provider 没覆盖到）。
  }
  return keyFromCredentialsFile({ refs: refs, file: opts.file });
}

/**
 * 遮蔽用的金钥来源与遮蔽结果，收成一个物件给路由回传。
 *
 * ⚠️ 回传值里**没有原文**，只有遮蔽后的字串与来源说明。
 *
 * @param ctx - Cordis 上下文。
 * @param options - `{ refs, file, now }`。
 * @returns Promise<{ ok, maskKey, ref, source } | { ok:false, error, tried }>。
 */
async function maskedCredential(ctx, options) {
  const opts = options || {};
  const source = await resolveMaskSource(ctx, opts);
  if (!source.ok) {
    return { ok: false, error: source.error, tried: source.tried, file: source.file };
  }
  try {
    return {
      ok: true,
      maskKey: maskKey(source.key, opts.now),
      ref: source.ref,
      source: source.source
    };
  } catch (err) {
    return {
      ok: false,
      error: '遮蔽失敗（' + source.ref + '）：' + (err && err.message ? err.message : String(err))
    };
  }
}

/* ------------------------------------------------------- 远端回应的形状收束 */

/**
 * 从一个物件里挑出第一个非空字串（或数字）栏位。
 *
 * ⚠️ **大小写不敏感**，而且比对时忽略 `_`／`-`／`.`：真实端点回的栏位是
 * `API_KEY` 这种大写加底线的写法，而程式里习惯写 `apiKey`。实测踩过 ——
 * 第一版用大小写敏感的清单，结果真实回应明明有值却一个候选都收不到。
 *
 * @param source - 回应物件。
 * @param names - 候选栏位名（依优先序）。
 * @returns 字串；找不到回 ''。
 */
function pickField(source, names) {
  if (source === null || typeof source !== 'object') return '';
  const flattened = {};
  for (const key of Object.keys(source)) {
    const flat = key.toLowerCase().replace(/[_.-]/g, '');
    if (flattened[flat] === undefined) flattened[flat] = source[key];
  }
  for (let i = 0; i < names.length; i += 1) {
    const value = flattened[names[i].toLowerCase().replace(/[_.-]/g, '')];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number') return String(value);
  }
  return '';
}

/**
 * 把远端储存端点的回应收成「可以拿来当 API Key 的候选值」。
 *
 * 为什么是「候选」而不是一个值：这个端点的回应形状没有文件，实测用无效金钥
 * 只拿到 `{}`。所以逐层往内找（顶层 → data → settings → value → result），
 * 并且一次收**多个**可能的栏位名 —— 名字对不上时把原始回应一起回传，
 * 使用者第一次按就能看到真实形状，而不是卡在「不知道为什么不理我」。
 *
 * @param payload - 解析后的回应。
 * @returns `{ candidates, fields, raw }`；candidates 是 `[{ path, value }]`。
 */
function normalizeRestorePayload(payload) {
  // 逐层往内收集：顶层 → data → settings → value → result，以及 data.settings
  // 这种两层组合。真实形状未知时，多试一层的成本远低于「明明有资料却说找不到」。
  const layers = [{ path: '', node: payload }];
  const nested = ['data', 'settings', 'value', 'result'];
  for (let i = 0; i < nested.length; i += 1) {
    const inner = payload !== null && typeof payload === 'object' ? payload[nested[i]] : undefined;
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
      layers.push({ path: nested[i], node: inner });
      for (let j = 0; j < nested.length; j += 1) {
        const deeper = inner[nested[j]];
        if (deeper !== null && typeof deeper === 'object' && !Array.isArray(deeper)) {
          layers.push({ path: nested[i] + '.' + nested[j], node: deeper });
        }
      }
    }
  }

  const candidates = [];
  const fields = {};
  const seen = new Set();

  /** 记一个候选（同一个值只记一次）。 */
  function push(path, value) {
    if (typeof value !== 'string' || value === '') return;
    if (seen.has(value)) return;
    seen.add(value);
    candidates.push({ path: path, value: value });
  }

  // API Key 的候选栏位名（依优先序）。pickField 会把名字与比对用的清单一起
  // 正规化（小写、去掉 _ - .），所以 `API_KEY`、`apiKey`、`Api-Key` 都算命中。
  const KEY_NAMES = ['apiKey', 'api_key', 'apikey', 'key', 'token', 'accessToken',
    'access_token', 'secret', 'apiKeyValue', 'value'];
  for (let i = 0; i < layers.length; i += 1) {
    const layer = layers[i];
    const node = layer.node;
    if (node === null || typeof node !== 'object') continue;
    const prefix = layer.path === '' ? '' : layer.path + '.';
    // 用正规化后的键回推原始键名，报告的 path 才是回应里真正出现的名字。
    for (const key of Object.keys(node)) {
      const flat = key.toLowerCase().replace(/[_.-]/g, '');
      const matched = KEY_NAMES.some((name) => name.toLowerCase().replace(/[_.-]/g, '') === flat);
      if (matched) push(prefix + key, node[key]);
    }
  }

  // 顺便把显示用的栏位收起来（不放进候选）。
  const NAME_NAMES = ['name', 'displayName', 'identity', 'nickname', 'nick', 'title'];
  const USER_NAMES = ['uid', 'user', 'username', 'account', 'userName', 'email'];
  const REDIRECT_NAMES = ['redirect', 'redirectUrl', 'redirect_url', 'path'];
  for (let i = 0; i < layers.length; i += 1) {
    const layer = layers[i];
    const node = layer.node;
    if (node === null || typeof node !== 'object') continue;
    if (fields.name === undefined) {
      const value = pickField(node, NAME_NAMES);
      if (value !== '') fields.name = value;
    }
    if (fields.user === undefined) {
      const value = pickField(node, USER_NAMES);
      if (value !== '') fields.user = value;
    }
    if (fields.redirect === undefined) {
      const value = pickField(node, REDIRECT_NAMES);
      // 只接受站内绝对路径（`/` 开头、无 `//`）—— 远端不给就自己退回预设。
      if (value !== '' && value.charAt(0) === '/' && value.charAt(1) !== '/') fields.redirect = value;
    }
  }

  return { candidates: candidates, fields: fields, raw: payload };
}

module.exports = {
  MASK_PREFIX,
  MASK_KEY_REFS,
  maskKey,
  credentialsFilePath,
  readCredentialRef,
  keyFromCredentialsFile,
  resolveMaskSource,
  maskedCredential,
  pickField,
  normalizeRestorePayload
};
