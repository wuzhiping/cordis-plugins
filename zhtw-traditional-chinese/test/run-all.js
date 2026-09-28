#!/usr/bin/env node
'use strict';
// Regression checks for this bundle. Run them after regenerating the tables, and
// after a DSH upgrade (which may add strings with characters the tables lack):
//
//   node test/run-all.js
//
// Checks, in order:
//   1. the bundle still parses and still registers itself with the loader
//   2. the conversion produces the expected Traditional form for known UI strings
//   3. every hand-curated idiom in test/curated-tables.json survived regeneration
//   4. no phrase is re-converted by another phrase (the single-pass invariant)
//   5. every Simplified character DSH's web bundles use has a mapping (needs the
//      OpenCC data; skipped with a warning when it is absent)

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { readTables, makeConverter, CLIENT } = require('./s2t');
const { collectCorpus } = require('./corpus');
const { readOpenCC, defaultOpenCCDir } = require('./opencc');

const CURATED = path.join(__dirname, 'curated-tables.json');

/** Strings whose conversion is the point of this bundle being installed. */
const EXPECTED = [
  // DSH's own shell strings
  ['新会话', '新工作階段'],
  ['新建会话', '新建工作階段'],
  ['打开侧边栏', '開啟側邊欄'],
  ['收起侧边栏', '收合側邊欄'],
  ['全局面板', '全域面板'],
  ['搜索会话名称', '搜尋工作階段名稱'],
  ['检视选项', '檢視選項'],
  ['选择新任务使用的 Agent 预设', '選擇新任務使用的 Agent 預設'],
  ['添加工作区', '新增工作區'],
  ['添加文件或调用指令', '新增檔案或呼叫指令'],
  ['插件', '外掛'],
  ['工作区', '工作區'],
  ['设置', '設定'],
  ['登录', '登入'],
  ['注销', '登出'],
  ['保存成功', '儲存成功'],
  ['加载失败', '載入失敗'],
  ['网络连接', '網路連線'],
  ['文件夹', '資料夾'],
  ['文件', '檔案'],
  ['用户设置', '使用者設定'],
  ['客户端', '用戶端'],
  ['服务器', '伺服器'],
  ['内存', '記憶體'],
  ['进程', '行程'],
  ['程序', '程式'],
  ['视频通话', '視訊通話'],
  ['剪贴板', '剪貼簿'],
  ['快捷键', '快速鍵'],
  ['快捷方式', '捷徑'],
  ['打印', '列印'],
  ['缓存', '快取'],
  ['日志', '日誌'],
  ['默认设置', '預設設定'],
  ['环境变量', '環境變數'],
  ['四舍五入', '四捨五入'],
  ['演示文稿', '簡報'],
  ['正则表达式', '正規表示式'],
];

let pass = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    pass += 1;
    console.log('  [ok]   ' + label);
  } catch (err) {
    failed += 1;
    console.log('  [FAIL] ' + label + ' :: ' + (err && err.message ? err.message : err));
  }
}

function main() {
  console.log('=== 1. the bundle ===');
  const src = fs.readFileSync(CLIENT, 'utf8');
  check('the loader wrapper is intact', () => {
    assert.ok(src.indexOf('window.__ModuleLoader__.load(') !== -1, 'no loader call');
    assert.ok(/id:\s*"zhtw-traditional-chinese"/.test(src), 'the module id changed');
    assert.ok(src.indexOf('inject: ["locale"]') !== -1, 'the plugin no longer injects locale');
  });
  const tables = readTables();
  const convert = makeConverter(tables);
  check('the tables parse and are not empty', () => {
    assert.ok(tables.phrases.length > 100, 'phrases: ' + tables.phrases.length);
    assert.ok(Object.keys(tables.chars).length > 1000, 'chars: ' + Object.keys(tables.chars).length);
  });
  check('no phrase has an empty or duplicated source', () => {
    const seen = new Set();
    for (const [from, to] of tables.phrases) {
      assert.ok(from.length >= 2, 'short phrase: ' + from);
      assert.ok(to.length >= 1, 'empty value for ' + from);
      assert.ok(!seen.has(from), 'duplicate phrase: ' + from);
      seen.add(from);
    }
  });

  console.log('');
  console.log('=== 2. known conversions ===');
  for (const [from, to] of EXPECTED) {
    check(JSON.stringify(from) + ' -> ' + JSON.stringify(to), () => {
      assert.strictEqual(convert(from), to);
    });
  }

  console.log('');
  console.log('=== 3. the hand-curated idioms survived ===');
  const curated = JSON.parse(fs.readFileSync(CURATED, 'utf8'));
  const shipped = new Map(tables.phrases);
  const lost = curated.phrases.filter(([from, to]) => shipped.get(from) !== to);
  check('all ' + curated.phrases.length + ' curated phrases are present and unchanged', () => {
    assert.deepStrictEqual(lost, [], 'changed or lost: ' + JSON.stringify(lost.slice(0, 5)));
  });
  const charLost = Object.keys(curated.chars).filter((ch) => tables.chars[ch] !== curated.chars[ch]);
  check('all ' + Object.keys(curated.chars).length + ' curated characters are present and unchanged', () => {
    assert.deepStrictEqual(charLost, [], 'changed or lost: ' + charLost.slice(0, 5).join(''));
  });

  console.log('');
  console.log('=== 4. single-pass invariant (a phrase never rewrites another phrase) ===');
  const chained = tables.phrases.filter(([from, to]) => convert(from) !== to);
  check('every phrase converts to itself', () => {
    assert.deepStrictEqual(
      chained.map((p) => p[0] + '->' + convert(p[0]) + ' (wanted ' + p[1] + ')').slice(0, 8),
      [],
    );
  });

  console.log('');
  console.log('=== 5. completeness against the DSH corpus ===');
  const openccDir = defaultOpenCCDir();
  const stChars = readOpenCC(path.join(openccDir, 'STCharacters.txt'));
  if (stChars.size === 0) {
    console.log('  [skip] OpenCC data not found at ' + openccDir);
    console.log('         (see test/opencc.js for the four files to fetch)');
  } else {
    const twVariants = readOpenCC(path.join(openccDir, 'TWVariants.txt'));
    const corpus = collectCorpus();
    const misses = [];
    for (const text of corpus.strings) {
      for (const ch of text) {
        const st = stChars.get(ch);
        if (st === undefined) continue;
        if ((twVariants.get(st) || st) === ch) continue;
        if (tables.chars[ch] === undefined) misses.push(ch);
      }
    }
    check('every Simplified character in ' + corpus.strings.length
      + ' DSH strings has a mapping', () => {
      assert.deepStrictEqual(Array.from(new Set(misses)).slice(0, 10), []);
    });
  }

  console.log('');
  console.log(pass + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exitCode = 1;
}

main();
