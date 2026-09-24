// tools/s2t/convert.js
//
// 简体 → 繁体 批处理，两条表叠加:
//   1. cordis-plugins/zhtw-traditional-chinese 里的 S2T_PHRASES / S2T_CHARS
//      —— 负责"台湾惯用词"和多义字(后→後、设置→設定、拖动→拖曳、界面→介面、计划→計畫…);
//   2. tools/s2t/winmap.json —— Windows LCMapString 生成的字级全量表，补齐 (1) 缺的字
//      (数→數、触→觸、达→達、点→點、题→題、线→線、评→評、价→價 …)。
//
// 用法:
//   node tools/s2t/convert.js --report   <file...>   # 干跑: 统计 + 列出"没被转换"的汉字供复核
//   node tools/s2t/convert.js --write    <file...>   # 原地转换
//   node tools/s2t/convert.js --emit-table <file...> # 打印"只覆盖这些文件所需"的最小词表(给动态插件用)
//
// 只在简体源上跑 (先把 winmap 生成了再 --write)。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ZHTW = path.join(ROOT, '..', 'zhtw-traditional-chinese', 'lib', 'client.js');
const WINMAP = path.join(__dirname, 'winmap.json');

function literal(src, marker, terminator) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error('marker not found: ' + marker);
  const from = at + marker.length;
  const end = src.indexOf(terminator, from);
  if (end < 0) throw new Error('terminator not found for ' + marker);
  return src.slice(from, end + 1);
}

const zsrc = fs.readFileSync(ZHTW, 'utf8');
const PHRASES = eval('(' + literal(zsrc, 'var S2T_PHRASES = ', '];') + ')');
const CHARS = eval('(' + literal(zsrc, 'var S2T_CHARS = ', '};') + ')');
const WIN = fs.existsSync(WINMAP) ? JSON.parse(fs.readFileSync(WINMAP, 'utf8')) : {};

const CJK = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const NUL = String.fromCharCode(0);

// 整词保护:先进占位符、转换完再还原。字表是按单字来的，会把"里程碑"的里也变成裡。
const GUARD = [['里程碑', '里程碑']];

function protect(text) {
  let s = String(text);
  const held = [];
  for (const pair of GUARD) {
    if (s.indexOf(pair[0]) !== -1) {
      const key = NUL + held.length + NUL;
      held.push(pair[1]);
      s = s.split(pair[0]).join(key);
    }
  }
  return { s: s, held: held };
}

function restore(text, held) {
  let s = String(text);
  for (let i = 0; i < held.length; i += 1) s = s.split(NUL + i + NUL).join(held[i]);
  return s;
}

// 主转换之后的手工修正:两张表都覆盖不到的"惯用/歧义"点。
// 左列是"已转换文本里实际出现的形式"，右列才是 TW 惯用写法。
// 逐条都有理由，别随手加:
//   么→麼   LCMapString 不认 么，必须成词替换(怎么/什么/這么/那么)
//   于→於   介词用法(tw 一律 於);「在于/基于/低于」成词替换更安全
//   周→週   指"星期/一星期"时才用 週：周三/周五/本周/下周/两周/周报
//   采→採   采用
//   舍→捨   取舍
//   交互→互動  tw 习惯用"互動"
//   復數/復核 → 複數/複核  "复"的两读：復(again) vs 複(multiple/re-check)
//   占位符→佔位符
//   加載→載入  "加载"是大陆词，tw 用"載入"
//   標注→標註
//   裡程碑→里程碑  字表按单字把 里→裡，但"里程碑"里的 里 不变(overt-conversion 修正)
const POLISH = [
  ['怎么', '怎麼'], ['什么', '什麼'], ['這么', '這麼'], ['那么', '那麼'],
  ['采用', '採用'], ['在于', '在於'], ['基于', '基於'], ['低于', '低於'],
  ['周三', '週三'], ['周五', '週五'], ['本周', '本週'], ['下周', '下週'],
  ['兩周', '兩週'], ['周報', '週報'], ['周末', '週末'], ['每周', '每週'],
  ['周期', '週期'],
  ['取舍', '取捨'], ['交互', '互動'],
  ['復數', '複數'], ['復核', '複核'],
  ['占位符', '佔位符'], ['裡程碑', '里程碑'], ['標注', '標註'],
  ['范圍', '範圍'], ['偏松', '偏鬆'],
  // 繁体里"并"分两读：並(而且) / 併(合併)。字表统一给了"並"，合并类词要单独改回来。
  ['合並', '合併'],
  // "余"在繁体里也可写作"余"(余/姓)，但"其余"一律用"餘"。
  ['其余', '其餘'],
  ['加載場景詳情', '載入場景詳情'],
];

function polish(text) {
  let s = String(text);
  for (const pair of POLISH) {
    if (s.indexOf(pair[0]) !== -1) s = s.split(pair[0]).join(pair[1]);
  }
  return s;
}

function mapChar(ch) {
  if (CHARS[ch] !== undefined) return CHARS[ch];
  if (WIN[ch] !== undefined) return WIN[ch];
  return ch;
}

function convert(text) {
  const guarded = protect(text);
  let s = guarded.s;
  for (const pair of PHRASES) {
    if (s.indexOf(pair[0]) !== -1) s = s.split(pair[0]).join(pair[1]);
  }
  let out = '';
  for (const ch of s) out += CJK.test(ch) ? mapChar(ch) : ch;
  return restore(polish(out), guarded.held);
}

function cjkChars(text) {
  const set = new Set();
  for (const ch of text) if (CJK.test(ch)) set.add(ch);
  return set;
}

function files(argv) {
  return argv.filter((a) => !a.startsWith('--')).map((p) => path.resolve(ROOT, p));
}

const mode = process.argv[2];
const targets = files(process.argv.slice(2));
if (!mode || targets.length === 0) {
  console.log('usage: node tools/s2t/convert.js --report|--write|--emit-table <file...>');
  process.exit(1);
}

if (mode === '--report') {
  for (const file of targets) {
    const src = fs.readFileSync(file, 'utf8');
    const dst = convert(src);
    const changed = src !== dst;
    // 真正的复核项:转换后仍然"可被表改写"的字 —— 正常情况下应该为空。
    // 判据跑在"整词保护"后的文本上,否则"里程碑"里的里会被误报。
    const left = [];
    for (const ch of cjkChars(protect(dst).s)) {
      if (mapChar(ch) !== ch) left.push(ch + '→' + mapChar(ch));
    }
    const hit = PHRASES.filter((p) => src.indexOf(p[0]) !== -1).length;
    let diffLines = 0;
    const a = src.split('\n');
    const b = dst.split('\n');
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diffLines += 1;
    console.log('--- ' + path.relative(ROOT, file));
    console.log('    changed = ' + changed + '; 行级改动 = ' + diffLines + '/' + a.length + '; 命中词条 = ' + hit);
    console.log('    转换后仍可被表改写的字 (' + left.length + '): ' + left.sort().join(' '));
  }
} else if (mode === '--write') {
  for (const file of targets) {
    const src = fs.readFileSync(file, 'utf8');
    const dst = convert(src);
    if (src === dst) {
      console.log('skip (no change): ' + path.relative(ROOT, file));
      continue;
    }
    fs.writeFileSync(file, dst, 'utf8');
    console.log('written: ' + path.relative(ROOT, file));
  }
} else if (mode === '--polish') {
  // 只跑 POLISH 表:用在"已经全量转换过、但后来发现个别惯用写法要修"的文件上。
  for (const file of targets) {
    const src = fs.readFileSync(file, 'utf8');
    const dst = polish(src);
    const hits = POLISH.filter((p) => src.indexOf(p[0]) !== -1).map((p) => p[0] + '→' + p[1]);
    if (src === dst) {
      console.log('skip (no change): ' + path.relative(ROOT, file));
      continue;
    }
    fs.writeFileSync(file, dst, 'utf8');
    console.log('polished: ' + path.relative(ROOT, file) + '  [' + hits.join(', ') + ']');
  }
} else if (mode === '--emit-table') {
  const text = targets.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const usedPhrases = PHRASES.filter((p) => text.indexOf(p[0]) !== -1);
  const usedChars = [];
  for (const ch of [...cjkChars(text)].sort()) {
    const t = mapChar(ch);
    if (t !== ch) usedChars.push(ch + ':' + t);
  }
  const lines = [];
  lines.push('// --- 简体 → 繁体(TW 惯用):只含本插件用到的字/词 ---');
  lines.push('const S2T_PHRASES = [');
  for (let i = 0; i < usedPhrases.length; i += 4) {
    lines.push('  ' + usedPhrases.slice(i, i + 4).map((p) => '[' + JSON.stringify(p[0]) + ',' + JSON.stringify(p[1]) + ']').join(', ') + ',');
  }
  lines.push('];');
  lines.push('const S2T_CHARS = {');
  for (let i = 0; i < usedChars.length; i += 12) {
    lines.push('  ' + usedChars.slice(i, i + 12).map((p) => '"' + p.split(':')[0] + '":"' + p.split(':')[1] + '"').join(',') + ',');
  }
  lines.push('};');
  lines.push('function s2t(text) {');
  lines.push('  let s = String(text);');
  lines.push('  for (const pair of S2T_PHRASES) {');
  lines.push('    if (s.indexOf(pair[0]) !== -1) s = s.split(pair[0]).join(pair[1]);');
  lines.push('  }');
  lines.push('  let out = "";');
  lines.push('  for (const ch of s) out += (S2T_CHARS[ch] !== undefined ? S2T_CHARS[ch] : ch);');
  lines.push('  return out;');
  lines.push('}');
  console.log(lines.join('\n'));
  console.log('// 词条 ' + usedPhrases.length + ' 个; 字 ' + usedChars.length + ' 个');
} else {
  console.log('unknown mode: ' + mode);
  process.exit(1);
}
