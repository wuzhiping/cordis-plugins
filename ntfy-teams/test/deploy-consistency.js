'use strict';

// =============================================================================
// 團隊協同 · ntfy-teams —— 部署設定一致性（離線，不需要 DSH 在跑）
//
// 為什麼需要這支測試（實測踩過，代價是「sidebar 菜單整個消失、零錯誤」）：
//
//   本插件的**宿主半邊**是靠套件自己的 `cordis.patch.yml` 裡一條 `insert:` 行
//   掛載的（跟 jeeflow-panel 同一個機制）。而 profile 對一個插件有**兩種互斥的
//   註冊方式**，混用會讓 Loader 丟 `duplicate loader entry id`：
//
//     方式 A「清單式」：列在 `dsh.profile.bundles`（+ dependencies）。
//        套件自己的 cordis.patch.yml 會被自動套用；**profile 的 patch 不該**
//        再為它加 insert。（zhtw / cute-clock / scene-template / 本插件都是這條。）
//     方式 B「手寫式」：只寫 profile 的 patch `insert:`，**刻意不列進 bundles**。
//        （jeeflow-panel 是這條；它的註解就警告過 duplicate loader entry id。）
//
//   實測踩過兩次：
//     1. 我用 A 裝好之後又手寫了一條 B 的 insert → 同一個 loader id 出現兩次；
//     2. 插件從 profile 被移除時，宿主半邊不掛、sidebar 靜默地少一項，
//        **沒有任何錯誤訊息**，非常難查。
//
// 這支測試把這些「兩份設定必須一致」變成可執行的斷言。
//
// 跑法：node test/deploy-consistency.js
// 環境：需要找得到 DSH_HOME；找不到時**明確 skip 並說明**（不假裝通過）。
// =============================================================================

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ⚠️ 這支測試住在 `<repo>/ntfy-teams/test/`，所以 repo 根在**上兩層**。
// 第一版算成上一層，於是找不到套件檔案 —— 三條斷言全部誤報。
// 測試本身錯了比沒有測試更糟：它會叫你去修一個沒壞的東西。
const REPO_ROOT = path.join(__dirname, '..', '..');
const PLUGIN_DIR = path.join(REPO_ROOT, 'ntfy-teams');
const PLUGIN_NAME = 'ntfy-teams';

let passed = 0;
let failed = 0;
const skipped = [];

/**
 * 跑一個測試；失敗只記錄，不中斷（讓後面的一起跑完）。
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
 * 跳過一個測試（環境不具備時）。
 * @param name - 測試名稱。
 * @param why - 原因。
 */
function skip(name, why) {
  skipped.push(name + ' —— ' + why);
  console.log('  skip ' + name + '（' + why + '）');
}

/**
 * 從 patch YAML 裡抓出所有 `insert:` 區塊的 id。
 *
 * 刻意用**行掃描**而不是 YAML 解析：這支測試不該依賴任何 YAML 套件
 * （離線、零依賴是這個 repo 測試的既定風格），而 insert 的形狀很固定。
 *
 * @param text - cordis.patch.yml 的內容。
 * @returns {string[]} id 清單。
 */
function insertIds(text) {
  const ids = [];
  let inInsert = false;
  let insertIndent = -1;
  text.split(/\r?\n/).forEach((line) => {
    if (/^\s*#/.test(line)) return;                       // 註解不算
    const trimmed = line.trim();
    if (trimmed === '') return;
    const indent = line.length - line.trimStart().length;

    if (/^-\s*insert:\s*$/.test(trimmed)) {
      inInsert = true;
      insertIndent = indent;
      return;
    }
    if (inInsert) {
      // insert 區塊結束：出現同層或更淺的新條目
      if (indent <= insertIndent && /^-\s/.test(trimmed)) { inInsert = false; return; }
      const m = trimmed.match(/^-\s*id:\s*(\S+)\s*$/);
      if (m) ids.push(m[1]);
    }
  });
  return ids;
}

/**
 * 找出 DSH_HOME。
 * @returns {string|null}
 */
function dshHome() {
  const env = process.env.DSH_HOME;
  if (env && fs.existsSync(env)) return env;
  const cand = path.join(os.homedir(), '.dsh');
  return fs.existsSync(cand) ? cand : null;
}

/**
 * 找出 profile 目錄。
 * @param home - DSH_HOME。
 * @returns {string|null}
 */
function profileDir(home) {
  const dir = path.join(home, 'profiles', process.env.DSH_PROFILE || 'web');
  return fs.existsSync(dir) ? dir : null;
}

function main() {
  console.log('== 團隊協同 ntfy-teams：部署註冊一致性');
  console.log('');

  // ---- 套件本身 ----------------------------------------------------------

  check('套件與 cordis.patch.yml 都在', () => {
    assert.ok(fs.existsSync(path.join(PLUGIN_DIR, 'package.json')),
      '找不到 ' + path.join(PLUGIN_DIR, 'package.json'));
    assert.ok(fs.existsSync(path.join(PLUGIN_DIR, 'cordis.patch.yml')),
      '找不到 ' + path.join(PLUGIN_DIR, 'cordis.patch.yml'));
  });

  check('package.json 宣告了 bundle patch 與 web client', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.name, PLUGIN_NAME, '套件名不對：' + pkg.name);
    assert.ok(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch,
      'package.json 沒有 dsh.bundle.patch —— 套件的 cordis.patch.yml 不會被套用');
    assert.ok(pkg.dsh.client && pkg.dsh.client.platform === 'web',
      'package.json 沒有宣告 dsh.client.platform=web');
  });

  // 套件的 patch 提供宿主半邊的掛載點。少了它，bundle 載入了但宿主半邊不掛，
  // sidebar 一樣不會出現。
  check('套件的 cordis.patch.yml 提供 ntfy-teams 的 insert 行', () => {
    const ids = insertIds(fs.readFileSync(path.join(PLUGIN_DIR, 'cordis.patch.yml'), 'utf8'));
    assert.ok(ids.indexOf(PLUGIN_NAME) !== -1,
      '套件的 patch 沒有 ' + PLUGIN_NAME + ' 的 insert 行，實際：' + JSON.stringify(ids));
  });

  // ---- profile ------------------------------------------------------------

  const home = dshHome();
  if (!home) {
    skip('profile 的註冊檢查', '找不到 DSH_HOME');
  } else {
    const pd = profileDir(home);
    if (!pd) {
      skip('profile 的註冊檢查',
        '找不到 profile 目錄（' + path.join(home, 'profiles', process.env.DSH_PROFILE || 'web') + '）');
    } else {
      const pkgPath = path.join(pd, 'package.json');
      const patchPath = path.join(pd, 'cordis.patch.yml');

      check('profile 的 cordis.patch.yml 存在且像 YAML 陣列', () => {
        assert.ok(fs.existsSync(patchPath), '找不到 ' + patchPath);
        const txt = fs.readFileSync(patchPath, 'utf8');
        assert.ok(txt.trim().length > 0, 'patch 是空的');
        assert.ok(/^\s*\[|\s*-\s/.test(txt), 'patch 看起來不是 YAML 陣列');
      });

      let pkg = null;
      check('profile 的 package.json 可解析', () => {
        assert.ok(fs.existsSync(pkgPath), '找不到 ' + pkgPath);
        pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        assert.ok(pkg && typeof pkg === 'object', 'package.json 不是物件');
      });

      if (pkg) {
        const deps = pkg.dependencies || {};
        const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
        const patchIds = fs.existsSync(patchPath) ? insertIds(fs.readFileSync(patchPath, 'utf8')) : [];

        // 這是「插件真的會被載入」的憑證。
        check('★ ntfy-teams 在 profile 的 dependencies 裡（name 才解析得到）', () => {
          assert.ok(Object.prototype.hasOwnProperty.call(deps, PLUGIN_NAME),
            'profile 的 dependencies 沒有 ' + PLUGIN_NAME
            + '，實際：' + JSON.stringify(Object.keys(deps)));
        });

        check('★ ntfy-teams 在 dsh.profile.bundles 裡（否則不會被載入）', () => {
          assert.ok(bundles.indexOf(PLUGIN_NAME) !== -1,
            PLUGIN_NAME + ' 不在 dsh.profile.bundles 裡 —— 它不會被載入，'
            + 'sidebar 也不會出現。實際：' + JSON.stringify(bundles));
        });

        // ★ 這條擋的就是我實際踩到的那個坑。
        check('★ ntfy-teams 不同時出現在 bundles 與 patch insert（避免 duplicate loader id）', () => {
          const inBundles = bundles.indexOf(PLUGIN_NAME) !== -1;
          const inInsert = patchIds.indexOf(PLUGIN_NAME) !== -1;
          assert.ok(!(inBundles && inInsert),
            PLUGIN_NAME + ' 同時由 dsh.profile.bundles 與 profile 的 patch insert 註冊 ——'
            + ' 同一個 loader id 出現兩次，Loader 會丟 `duplicate loader entry id`。'
            + '本插件走「清單式」（bundles），套件自己的 cordis.patch.yml 會被自動套用，'
            + '所以 profile 的 insert 必須移除。'
            + '（bundles=' + inBundles + ' insert=' + inInsert + '）');
        });

        // 反向：任何**同時**在 bundles 裡的插件都不該再有 patch insert。
        // 這條不點名 jeeflow-panel —— 它是故意走「手寫式」的（在 dependencies
        // 但不在 bundles），所以不該被報成錯誤。
        check('★ 其他列在 bundles 的插件也沒有 patch insert（同一個坑的一般化）', () => {
          const overlap = bundles.filter((n) => patchIds.indexOf(n) !== -1);
          assert.strictEqual(overlap.length, 0,
            '這些插件同時由 bundles 與 patch insert 註冊，會 duplicate loader entry id：'
            + JSON.stringify(overlap) + '（patch insert：' + JSON.stringify(patchIds) + '）');
        });
      }
    }
  }

  console.log('');
  if (skipped.length) {
    console.log('跳過 ' + skipped.length + ' 項：');
    skipped.forEach((s) => console.log('  · ' + s));
    console.log('');
  }
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  console.log('结果：' + (failed === 0 ? 'PASS（全程無網路）' : 'FAILED'));
  process.exit(failed === 0 ? 0 : 1);
}

main();
