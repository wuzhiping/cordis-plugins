'use strict';

// =============================================================================
// 团队协同 · ntfy-teams —— 介面文案语言检查（繁體中文）
//
//   node test/zh-tw-check.js
//
// 宿主介面是 zh-TW（侧栏读作 外掛 / 自動化任務 / 元氣時鐘 / 今日重訊 / 設定），
// 所以本外掛的**使用者可見文案**必须是繁體。简体字混进去在编辑器里很难看出来，
// 但使用者一眼就会看到。
//
// 这个检查只扫「模板区」（@@CORE_BEGIN@@ / @@CORE_END@@ 之外的手写程式）里的
// **字串字面值**；注解不算（注解是给维护者看的），内嵌的 core 区也不算
// （core 的文案由 lib/core.js 自己负责，那里也有它自己的检查）。
//
// 这不是「完美」的语言判定 —— 它是一张清单，列出只在简体里出现、不会出现在
// 繁體里的字。字串里出现这些字就几乎一定是漏改。
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

const CLIENT = path.join(__dirname, '..', 'lib', 'client.js');

/** 只在简体中文里出现、繁體不会用到的字（或用法）。 */
const SIMPLIFIED_ONLY = [
  '则', '读', '题', '样', '见', '为', '发', '间', '么', '没', '东', '车', '书', '门',
  '问', '习', '线', '连', '认', '让', '对', '说', '还', '这', '内', '开', '实', '现',
  '产', '与', '于', '后', '关', '参', '数', '单', '击', '录', '应', '总', '页', '据',
  '权', '账', '号', '记', '载', '软', '复', '态', '选', '择', '删', '仅',
  '备', '场', '图', '风', '双', '网', '络', '输', '转', '换', '错', '误',
  '顶', '缓', '冲', '队', '务', '员', '环', '顾',
];

/**
 * 简繁同形字 —— **绝不能**放进上面的名单。
 *
 * 这些字在简体与繁體里是同一个码位，列进来会造成误报（实测踩过）：
 *   * `境`（U+5883）两边同形，只有偏旁不同（环 U+73AF ↔ 環 U+74B0）；
 *     之前把「環」和「境」当成一对都列进去，于是任何出现「環境」的文案都被误判。
 *   * `列` 同样两边同形。
 *   * `客`（U+5BA2）同样两边同形 —— 「客戶」「客戶端」「客人」在繁體裡就是這樣寫。
 *     之前把它列進简体专属名单，于是任何出现「客戶端」的文件都被误判
 *     （实测：README／HANDOFF 各有一处）。
 * 用测试把这件事钉住，避免以后有人「顺手补一个」又补错。
 */
const SHARED_CHARS = ['境', '列', '客'];

/** 有些字在繁體里也用，但出现在特定词里就是简体；用词来判断更准。 */
const SIMPLIFIED_WORDS = [
  '默认', '设置', '消息', '服务器', '用户名', '密码', '访问', '令牌', '连接', '保存',
  '认证', '凭据', '错误', '主题', '订阅', '发送', '记录', '文件', '目录', '代码',
  '函数', '变量', '网络', '输入', '读取', '载入', '历史', '实时', '内容', '测试',
  '开头的', '名称', '显示', '状态', '样式', '颜色', '打开', '关闭', '点击',
];

/** 读档并把 CRLF 正规化。 @param file - 路径。 @returns 内容。 */
function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * 取出模板区（内嵌 core 之外的段落）。
 * @param source - client.js 全文。
 * @returns {head:string, tail:string} 两段手写程式。
 */
function templateRegions(source) {
  const begin = source.indexOf('// @@CORE_BEGIN@@');
  const end = source.indexOf('// @@CORE_END@@');
  if (begin === -1 || end === -1 || end < begin) return null;
  const beginLineEnd = source.indexOf('\n', begin) + 1;
  const endLineStart = source.lastIndexOf('\n', end) + 1;
  return { head: source.slice(0, beginLineEnd), tail: source.slice(endLineStart) };
}

/**
 * 逐行找出字串字面值（跳过注解行）。
 * @param text - 模板区文字。
 * @returns {Array<{line:number, literal:string}>}
 */
function stringLiterals(text) {
  const out = [];
  const re = /'(?:[^'\\]|\\.)*'/g;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    const matches = line.match(re);
    if (!matches) continue;
    for (const literal of matches) out.push({ line: i + 1, literal });
  }
  return out;
}

const source = read(CLIENT);
const regions = templateRegions(source);
if (regions === null) {
  console.error('zh-tw-check: 找不到 @@CORE_BEGIN@@ / @@CORE_END@@ 记号');
  process.exitCode = 1;
  return;
}

const literals = stringLiterals(regions.head + regions.tail);
const problems = [];

// 名单完整性：简繁同形字不该出现在「简体专属」名单里（否则必然误报）。
const mislisted = SHARED_CHARS.filter((ch) => SIMPLIFIED_ONLY.indexOf(ch) !== -1);
if (mislisted.length > 0) {
  console.error('zh-tw-check: 简繁同形字误入 SIMPLIFIED_ONLY：' + mislisted.join('、'));
  process.exitCode = 1;
  return;
}

for (const entry of literals) {
  const body = entry.literal;

  // 1) 简体专属字
  const badChars = SIMPLIFIED_ONLY.filter((ch) => body.indexOf(ch) !== -1);
  if (badChars.length > 0) {
    problems.push(entry.line + ': ' + body + '   ← 含简体字：' + badChars.join('、'));
    continue;
  }

  // 2) 简体用词（字本身繁體也有，但整词是简体写法）
  const badWords = SIMPLIFIED_WORDS.filter((w) => body.indexOf(w) !== -1);
  if (badWords.length > 0) {
    problems.push(entry.line + ': ' + body + '   ← 含简体词：' + badWords.join('、'));
  }
}

// ---- 文件也要掃，但**只用可靠的字表，而且不讓它弄失敗** ----
//
// 為什麼不共用 `SIMPLIFIED_WORDS`：那份詞表是為**介面字串**設計的，
// 拿來掃技術文件會產生大量誤報（實測 14 筆裡只有 1 筆真的）：
//   * 「確保存在」被 `保存` 誤中（子串巧合）；
//   * 「令牌」被判成簡體 —— 它是繁體技術用語，只是繁體慣用「權杖」；
//   * 「文件」被判成簡體 —— 繁體也用，只是慣用「檔案」。
//
// 一個一直響的檢查比沒有檢查更糟，它會訓練人忽略它。
// 所以文件這邊：**只掃簡體專屬字**（字表可靠），而且只警告、不改 exit code ——
// 寧可漏報也不要因為誤報擋住建置。
const DOCS = ['README.md', 'HANDOFF.md'];
const docWarnings = [];
DOCS.forEach((doc) => {
  const full = path.join(__dirname, '..', doc);
  if (!fs.existsSync(full)) return;
  read(full).split('\n').forEach((line, idx) => {
    const bad = SIMPLIFIED_ONLY.filter((ch) => line.indexOf(ch) !== -1);
    if (bad.length > 0) {
      docWarnings.push(doc + ':' + (idx + 1) + ': 简体字 ' + bad.join('、')
        + '  →  ' + line.trim().slice(0, 56));
    }
  });
});

console.log('');
console.log('ntfy-teams · 介面文案语言检查（繁體中文）');
console.log('  扫描字串字面值：' + literals.length + ' 个');
console.log('  扫描文件：' + DOCS.filter((d) => fs.existsSync(path.join(__dirname, '..', d))).join('、')
  + '（只掃簡體專屬字，僅警告）');

if (docWarnings.length > 0) {
  console.log('');
  console.log('  WARN  文件裡發現 ' + docWarnings.length + ' 处簡體字（不影響結果）：');
  docWarnings.forEach((w) => console.log('        ' + w));
}

if (problems.length === 0) {
  console.log('');
  console.log('  PASS  使用者可见文案没有简体字');
  console.log('');
  process.exitCode = 0;
} else {
  console.log('');
  console.log('  FAIL  发现 ' + problems.length + ' 处疑似简体文案：');
  problems.forEach((p) => console.log('        ' + p));
  console.log('');
  process.exitCode = 1;
}
