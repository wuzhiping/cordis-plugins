'use strict';

// =============================================================================
// 团队协同 · ntfy-teams —— build.js
//
//   node build.js
//
// 做一件事：把 lib/core.js（协议层）内嵌进 lib/client.js 的
// @@CORE_BEGIN@@ … @@CORE_END@@ 区块，让 lib/client.js 成为**自足**的浏览器档。
// 重复执行是幂等的（只会替换那个区块）。
//
// 为什么必须内嵌：
//   dsh-client-modules 只把一个 client 档案送上浏览器 —— 它解析 package.json 的
//   exports["./client"]，就这一个路径，没有「额外档案」栏位，第三方档案也不会被
//   组合进 combo script。所以隔壁的 lib/core.js 永远不会被执行
//   （实测：GET /plugins/ntfy-teams/core.js → 404；served bundle 里没有 core 的程式码）。
//   而档案顺序也不可依赖，因为 combo script 把每个档案包成 lazy body ——
//   只有「同一个档案」才能保证先注册、后 materialize。
//
// 改写流程：
//   1. 改 lib/core.js（协议、解析、认证、store）或 lib/client.js 的标记区块之外；
//   2. node build.js
//   3. node --check lib/client.js && node test/core-node.js && node test/client-offline.js
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, 'lib');
const CLIENT_PATH = path.join(LIB, 'client.js');
const CORE_PATH = path.join(LIB, 'core.js');

const BEGIN = '// @@CORE_BEGIN@@';
const END = '// @@CORE_END@@';
const CORE_HEAD = '// ===== inlined from lib/core.js';
const CORE_TAIL = '// ===== end of inlined lib/core.js =====';

/** 读一个档案并把 CRLF 正规化成 LF，避免两档混排换行。 */
function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/** 建置失败：印出原因并设置非零 exit code。 */
function fail(message) {
  console.error('build: ' + message);
  process.exitCode = 1;
}

const client = read(CLIENT_PATH);
const core = read(CORE_PATH);

const beginIndex = client.indexOf(BEGIN);
if (beginIndex === -1) {
  fail('在 lib/client.js 找不到 ' + BEGIN + ' 标记');
  return;
}
if (client.indexOf(BEGIN, beginIndex + BEGIN.length) !== -1) {
  fail('lib/client.js 里有多个 ' + BEGIN + ' 标记');
  return;
}

const endIndex = client.indexOf(END, beginIndex);
if (endIndex === -1) {
  fail('在 lib/client.js 找不到 ' + END + ' 标记');
  return;
}
if (client.indexOf(END, endIndex + END.length) !== -1) {
  fail('lib/client.js 里有多个 ' + END + ' 标记');
  return;
}

// 替换区间：从 BEGIN 那一行之后，到 END 那一行之前。
const beginLineEnd = client.indexOf('\n', beginIndex);
const endLineStart = client.lastIndexOf('\n', endIndex);
if (beginLineEnd === -1 || endLineStart === -1 || endLineStart < beginLineEnd) {
  fail('标记不是各自独占一行，无法安全替换');
  return;
}

const head = client.slice(0, beginLineEnd + 1);
const tail = client.slice(endLineStart + 1);

// 内嵌区块。core.js 本身已经是一个自足 IIFE，其变数都是 function-scoped，
// 只要在最后呼叫它的 moduleRoot()，把 API 接到 factory 的 local `core` 变数。
//
// 内嵌前必须拿掉 core.js 的「Node 专属出口」：factory 自己有一个 local `module`
// （`{ exports: {} }`），所以内嵌后 `typeof module` 是 'object'，`module.exports`
// 又是真值 —— 该分支会被执行，而 factory 的 `module` 没有 moduleRoot，
// 于是 `module.exports.moduleRoot = …` 直接抛错（实测：整个 factory 炸掉）。
// 用「字串位置」而不是正则来切，避免注释里的反引号与多行内容把 regez 搞歪。
const EXPORT_HEADER = '导出';
const MODULE_GUARD = 'if (typeof module';

/** 从 core 原始码里切掉 Node 专属出口区块；切不掉回 null。 */
function stripNodeExports(source) {
  const headerAt = source.indexOf(EXPORT_HEADER);
  const guardAt = source.indexOf(MODULE_GUARD);
  if (guardAt === -1) return null;

  // 从 guard「正上方紧邻的那段注解」开始切，而不是往前找更早的 '/*'。
  // 踩过的坑：往前找最近的大区块注解会一路退到「导出」小节的开头，
  // 把 root.moduleRoot 的定义也一起切掉 —— 产物看起来没问题，但 factory 找不到
  // moduleRoot（实测：Cannot read properties of undefined (reading 'moduleRoot')）。
  let blockStart = guardAt;
  const commentLines = [];
  for (const line of source.slice(0, guardAt).split('\n').slice(-12).reverse()) {
    const t = line.trim();
    if (t.startsWith('//') || t === '') {
      commentLines.unshift(line);
      // 遇到大区块注解的开头就停（不要再往上吃）
      if (t.startsWith('/*') || t.startsWith('/**')) break;
      continue;
    }
    if (t.endsWith('*/')) { commentLines.unshift(line); break; }
    break;
  }
  const joined = commentLines.join('\n');
  if (joined.trim() !== '') {
    const at = source.lastIndexOf(joined, guardAt);
    if (at !== -1) blockStart = at;
  }

  // 结束：从 guard 开始逐行往下找「缩排两层、只含一个 }」的那一行 —— 那就是这个 if 的收尾。
  // 不能用 indexOf('\n  }') 随便找第一个：档案里其他缩排的 } 会先被命中，
  // 结果会把后面的函数切一半（实测过：buildApi() 被切断，产物语法错误）。
  const lines = source.slice(guardAt).split('\n');
  let consumed = 0;
  let closeAt = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s{0,4}\}\s*$/.test(lines[i])) {
      closeAt = guardAt + consumed + lines[i].length;
      break;
    }
    consumed += lines[i].length + 1;
  }
  if (closeAt === -1) return null;

  return (
    source.slice(0, blockStart) +
    '/* build: Node 专属出口已移除（浏览器不会走到，且会与 factory 的 local `module` 冲突）。*/\n' +
    source.slice(closeAt + 1)
  );
}

const coreForBrowser = stripNodeExports(core);
if (coreForBrowser === null) {
  fail(
    'lib/core.js 里找不到「Node 专属出口」区块，无法安全内嵌。\n' +
    '       请确认 lib/core.js 仍有一段 `if (typeof module …) { module.exports = … }`；\n' +
    '       内嵌时它会和 factory 的 local `module` 冲突，必须移除。',
  );
  return;
}

// coreForBrowser 的注解里本来就提到 module.exports（说明用），所以「残留」检查必须
// 忽略注解 —— 真正的判断放在下面 stripComments() 定义之后。

const body = [
  CORE_HEAD + '（由 build.js 产生，请勿手改；原始码在 lib/core.js）===== */',
  '    // 先把 root 定好：下面是内嵌区块，它会用到 root。',
  '    var root = typeof globalThis !== \'undefined\' ? globalThis : this;',
  coreForBrowser
    .replace(/\r\n/g, '\n')
    .replace(/^/gm, '    ')
    .replace(/[ \t]+$/gm, ''),
  '    // 启动内嵌的协议层：拿回 API（同时让 window.__ntfyTeamsCore 可观察）。',
  '    var core = root.moduleRoot();',
  CORE_TAIL,
  '',
].join('\n');

const next = head + body + tail;

/**
 * 去掉 // 与 /* *\/ 注解（会跳过字串与样板字串里的内容），
 * 让「残留 module.exports」这类检查只看真正的程式码。
 * @param src - 原始 JavaScript 文字。
 * @returns 去掉注解后的文字（换行保留，方便定位）。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let mode = 'code';
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (mode === 'code') {
      if (ch === '/' && next === '/') { mode = 'line'; i += 2; continue; }
      if (ch === '/' && next === '*') { mode = 'block'; i += 2; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { mode = ch; out += ch; i += 1; continue; }
      out += ch; i += 1; continue;
    }
    if (mode === 'line') {
      if (ch === '\n') { mode = 'code'; out += ch; }
      i += 1; continue;
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') { mode = 'code'; i += 2; continue; }
      if (ch === '\n') out += ch;
      i += 1; continue;
    }
    // 字串 / 样板字串
    if (ch === '\\') { out += ch + (next === undefined ? '' : next); i += 2; continue; }
    if (ch === mode) { mode = 'code'; out += ch; i += 1; continue; }
    out += ch; i += 1; continue;
  }
  return out;
}

/** 计算某个字串在文字里出现几次。 */
function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

if (countOf(stripComments(coreForBrowser), 'module.exports') !== 0) {
  fail('lib/core.js 内嵌后仍残留 module.exports（非注解处），会在浏览器端抛错');
  return;
}

// 产物自检：整份 client.js 里真正会被执行的 module.exports，应该只有 factory 自己那一个
// （即模板里的数目）。多出来的就是内嵌区块漏带进来的。
if (countOf(stripComments(next), 'module.exports') !== countOf(stripComments(client), 'module.exports')) {
  fail('产物里 module.exports 的数目不对，拒绝写出');
  return;
}

// 产物自检（fail-closed）：语法必须先过关才准写档，否则宁愿保留旧档并报错。
try {
  new (require('node:vm').Script)(next, { filename: CLIENT_PATH });
} catch (err) {
  fail('产物语法不合法，拒绝写出：' + (err && err.message ? err.message : String(err)));
  return;
}

if (next === client) {
  console.log('build: 无变化（lib/client.js 已经是最新的）');
  return;
}

fs.writeFileSync(CLIENT_PATH, next, 'utf8');

console.log('build: 已内嵌 lib/core.js → lib/client.js');
console.log('       core   ' + Buffer.byteLength(core, 'utf8') + ' bytes');
console.log('       client ' + Buffer.byteLength(next, 'utf8') + ' bytes');
console.log('');
console.log('下一步：');
console.log('  node --check lib/client.js');
console.log('  node test/core-node.js && node test/client-offline.js');
