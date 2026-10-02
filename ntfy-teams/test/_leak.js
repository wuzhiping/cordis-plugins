'use strict';
// 臨時（可删）：只取 NTFY_TEAMS_CSS 那一段，找出沒有前綴的選擇器。
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
const start = src.indexOf('var NTFY_TEAMS_CSS = [');
const endMark = src.indexOf('].concat(AVATAR_CSS)', start);
if (start === -1 || endMark === -1) { console.log('  找不到 CSS 陣列'); process.exit(1); }
const block = src.slice(start, endMark);

// 這個區塊裡每一行都是 '...' 形式；把字串內容接起來就是 CSS
const literals = block.match(/'(?:[^'\\]|\\.)*'/g) || [];
const css = literals.map((s) => s.slice(1, -1)).join('');

// 粗略切規則：遇到 { 之前是選擇器，} 結束
const rules = [];
let depth = 0;
let buf = '';
let inAt = false;
for (const ch of css) {
  buf += ch;
  if (ch === '{') { depth += 1; if (depth === 1) inAt = /@/.test(buf.trim().split('{')[0]); }
  if (ch === '}') {
    depth -= 1;
    if (depth === 0) { rules.push(buf.trim()); buf = ''; inAt = false; }
  }
}

const suspicious = [];
rules.forEach((r) => {
  const i = r.indexOf('{');
  if (i === -1) return;
  const sel = r.slice(0, i).trim();
  if (!sel || /^@/.test(sel)) return;      // @media / @keyframes 由裡面遞迴處理
  sel.split(',').forEach((one) => {
    const s = one.trim();
    if (!s) return;
    if (s.indexOf('.ntfy-teams-') === -1) suspicious.push(s);
  });
});

console.log('  規則總數: ' + rules.length);
console.log('');
if (suspicious.length === 0) {
  console.log('  ✅ 所有選擇器都含 .ntfy-teams- 前綴');
} else {
  const uniq = Array.from(new Set(suspicious));
  console.log('  ⚠ 有 ' + uniq.length + ' 個選擇器不含前綴（可能外洩）：');
  uniq.forEach((s) => console.log('    ' + s));
}

// 另外檢查：有沒有以「元素名」開頭、後面才接 .ntfy-teams-（那也算有前綴，安全）
// 真正危險的是「完全不含前綴」。
console.log('');
console.log('  ── 含前綴但用「後代選擇器」從很外層往下找的（也可能誤中，但機率低）──');
const descendant = [];
rules.forEach((r) => {
  const i = r.indexOf('{');
  if (i === -1) return;
  const sel = r.slice(0, i).trim();
  if (!sel || /^@/.test(sel)) return;
  // 例如 body .ntfy-teams-xxx 或 [class*=...] 這種
  if (/^(html|body|:root|\*)\b/.test(sel)) descendant.push(sel);
});
if (descendant.length === 0) console.log('    無');
else descendant.forEach((s) => console.log('    ' + s));
