'use strict';

// =============================================================================
// 團隊協同 · ntfy-teams —— 打包完整性（離線）
//
// 為什麼需要這支測試（實測踩過，代價極大）：
//
//   `package.json` 的 `files` 是一份**白名單** —— 沒列到的檔案不會進 npm／git
//   tarball。第一版把 `lib/` 底下的檔案一個一個列舉，漏掉了 `lib/config-store.js`：
//
//     lib/index.js  →  `require('./config-store.js')`
//     harness.ps1   →  `dsh plugin add github:…#path:/ntfy-teams`（讀 tarball）
//
//   於是**遠端安裝的套件少了那個檔案**，宿主半邊在 `require` 階段就拋
//   `Cannot find module './config-store.js'` → 插件整個掛不上 → sidebar 沒有
//   「團隊協同」，**而且畫面上沒有任何錯誤**。
//
//   最惡毒的地方：本機開發時檔案都在，所有測試都是綠的 —— 這個 bug
//   **只在遠端安裝時出現**。所以一定要有這支測試。
//
// 這支測試同時驗「宿主半邊的 require 都解析得到」「client bundle 真的有內容」
// 「patch 檔有 insert 行」。
//
// 跑法：node test/package-integrity.js
// =============================================================================

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// ⚠️ 這支測試住在 `<repo>/ntfy-teams/test/`，所以套件根在上一層。
const PLUGIN_DIR = path.join(__dirname, '..');
const LIB_DIR = path.join(PLUGIN_DIR, 'lib');

let passed = 0;
let failed = 0;

/**
 * 跑一個測試；失敗只記錄，不中斷。
 * @param name - 測試名稱。
 * @param fn - 測試函式。
 */
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (e) {
    failed += 1;
    console.log('  FAIL ' + name);
    console.log('       ' + (e && e.message ? e.message : String(e)));
  }
}

/**
 * 把 `files` 條目展開成實際會被打包的相對路徑集合。
 *
 * npm 的規則：條目可以是檔案或目錄（目錄代表「整個子樹」）。這裡只需要判斷
 * 「某個相對路徑在不在白名單內」，所以把目錄展開即可。
 *
 * @param files - package.json 的 files 陣列。
 * @returns {Set<string>} 相對路徑（以 / 分隔）。
 */
function packedFiles(files) {
  const set = new Set();
  (files || []).forEach((entry) => {
    const rel = String(entry).replace(/^\.\//, '').replace(/\\/g, '/');
    set.add(rel);
    const abs = path.join(PLUGIN_DIR, rel);
    if (!fs.existsSync(abs)) return;
    if (fs.statSync(abs).isDirectory()) {
      (function walk(dir) {
        fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
          const p = path.join(dir, e.name);
          const r = path.relative(PLUGIN_DIR, p).replace(/\\/g, '/');
          if (e.isDirectory()) walk(p);
          else set.add(r);
        });
      }(abs));
    }
  });
  return set;
}

/**
 * 抓出一個 CommonJS 檔案裡所有相對 require/import 的目標。
 * @param src - 原始碼。
 * @returns {string[]} 例如 ['./config-store.js']。
 */
function relativeRequires(src) {
  const found = new Set();
  const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) found.add(m[1]);
  return Array.from(found);
}

function main() {
  console.log('== 打包完整性：遠端安裝時檔案會不會少 ==');
  console.log('');

  const pkgPath = path.join(PLUGIN_DIR, 'package.json');
  let pkg = null;
  check('package.json 可解析', () => {
    assert.ok(fs.existsSync(pkgPath), '找不到 ' + pkgPath);
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    assert.strictEqual(pkg.name, 'ntfy-teams', '套件名不對：' + pkg.name);
  });
  if (!pkg) {
    console.log('');
    console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
    console.log('结果：FAILED');
    process.exit(1);
  }

  const packed = packedFiles(pkg.files);

  check('files 白名單不是空的', () => {
    assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0,
      'package.json 沒有 files 白名單（npm 會用預設規則，行為難以預測）');
  });

  // 入口檔案一定要在。
  check('main（' + pkg.main + '）在白名單內', () => {
    assert.ok(packed.has(pkg.main), pkg.main + ' 不在 files 白名單裡 —— 宿主找不到入口');
  });

  // exports 指的檔案也一定要在（DSH 用 ./client 去抓瀏覽器 bundle）。
  check('exports 的每個目標都在白名單內', () => {
    const missing = [];
    Object.keys(pkg.exports || {}).forEach((key) => {
      const target = String(pkg.exports[key]).replace(/^\.\//, '');
      if (!packed.has(target)) missing.push(key + ' → ' + target);
    });
    assert.strictEqual(missing.length, 0,
      'exports 指向的檔案不在 files 白名單裡（遠端安裝會少檔）：' + JSON.stringify(missing));
  });

  // ★ 核心斷言：宿主半邊的每一個相對 require 都要解析得到、且被打包。
  //
  // 這一條就是擋住 `lib/config-store.js` 那個 bug 的。
  check('★ 宿主半邊（lib/index.js）的每個相對 require 都在白名單內', () => {
    const src = fs.readFileSync(path.join(LIB_DIR, 'index.js'), 'utf8');
    const reqs = relativeRequires(src);
    assert.ok(reqs.length > 0, 'lib/index.js 沒有任何相對 require？是不是讀錯檔案了');
    const problems = [];
    reqs.forEach((r) => {
      const abs = path.resolve(LIB_DIR, r);
      const rel = path.relative(PLUGIN_DIR, abs).replace(/\\/g, '/');
      if (!fs.existsSync(abs)) problems.push(r + '（連本機都沒有）');
      else if (!packed.has(rel)) problems.push(r + '（→ ' + rel + ' 不在 files 白名單）');
    });
    assert.strictEqual(problems.length, 0,
      'lib/index.js 需要的檔案不會被打包 —— 遠端安裝時宿主半邊會在 require 階段拋錯、'
      + '插件整個掛不上（而且畫面上沒有任何錯誤）。問題：' + JSON.stringify(problems));
  });

  // 每一個 lib/*.js 也都該檢查（不只入口）。
  check('★ lib/ 底下每個檔案的相對 require 都在白名單內', () => {
    const problems = [];
    fs.readdirSync(LIB_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.js$/.test(e.name))
      .forEach((e) => {
        const src = fs.readFileSync(path.join(LIB_DIR, e.name), 'utf8');
        relativeRequires(src).forEach((r) => {
          const abs = path.resolve(LIB_DIR, r);
          const rel = path.relative(PLUGIN_DIR, abs).replace(/\\/g, '/');
          if (!fs.existsSync(abs)) problems.push(e.name + ' → ' + r + '（本機就沒有）');
          else if (!packed.has(rel)) problems.push(e.name + ' → ' + rel + '（不在白名單）');
        });
      });
    assert.strictEqual(problems.length, 0,
      'lib/ 內部互相 require 的檔案有沒被打包的：' + JSON.stringify(problems));
  });

  // 瀏覽器 bundle 要真的有內容 —— 空的 client.js 會讓 sidebar 圖示不出現。
  check('★ lib/client.js 存在且有實質內容（瀏覽器 bundle）', () => {
    const p = path.join(LIB_DIR, 'client.js');
    assert.ok(fs.existsSync(p), '找不到 lib/client.js');
    const size = fs.statSync(p).size;
    assert.ok(size > 10000,
      'lib/client.js 只有 ' + size + ' bytes —— 看起來沒 build 過（先跑 node build.js）');
    const src = fs.readFileSync(p, 'utf8');
    assert.ok(src.indexOf('__ModuleLoader__') !== -1,
      'lib/client.js 沒有 __ModuleLoader__ —— 不是 DSH 的 client bundle');
  });

  // 宿主半邊與瀏覽器 bundle 的標記。
  check('lib/index.js 匯出 name / inject / apply', () => {
    const m = require(path.join(LIB_DIR, 'index.js'));
    assert.strictEqual(m.name, 'ntfy-teams', 'name 不對：' + m.name);
    assert.ok(Array.isArray(m.inject), 'inject 不是陣列');
    assert.strictEqual(typeof m.apply, 'function', 'apply 不是函式');
  });

  check('cordis.patch.yml 提供 ntfy-teams 的 insert 行', () => {
    const p = path.join(PLUGIN_DIR, 'cordis.patch.yml');
    assert.ok(fs.existsSync(p), '找不到 cordis.patch.yml');
    assert.ok(packed.has('cordis.patch.yml'), 'cordis.patch.yml 不在 files 白名單裡');
    const txt = fs.readFileSync(p, 'utf8');
    assert.ok(/insert:/.test(txt), 'patch 沒有 insert 區塊');
    assert.ok(/id:\s*ntfy-teams/.test(txt), 'patch 沒有 ntfy-teams 的 id');
  });

  check('package.json 宣告 dsh.bundle.patch 與 dsh.client.platform=web', () => {
    assert.ok(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch,
      '沒有 dsh.bundle.patch');
    assert.ok(pkg.dsh.client && pkg.dsh.client.platform === 'web',
      '沒有 dsh.client.platform=web（瀏覽器 bundle 不會被載入）');
  });

  console.log('');
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  console.log('结果：' + (failed === 0 ? 'PASS（全程無網路）' : 'FAILED'));
  process.exit(failed === 0 ? 0 : 1);
}

main();
