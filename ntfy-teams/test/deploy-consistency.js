'use strict';

// =============================================================================
// 團隊協同 · ntfy-teams —— 部署設定一致性（離線，不需要 DSH 在跑）
//
// 為什麼需要這支測試（實測踩過的坑，代價是「sidebar 菜單整個消失、零錯誤」）：
//
//   `harness.ps1` 用一份寫死的 `$plugins` 清單重算 profile。清單外的插件會被
//   從 profile 移除。而本插件的**宿主半邊**是靠 profile 的 `cordis.patch.yml`
//   裡一條 `insert:` 行掛載的（跟 jeeflow-panel 同一個機制，刻意不列在
//   `dsh.profile.bundles`，以免 duplicate loader entry id）。
//
//   所以：`harness.ps1` 不認得 ntfy-teams → 那一行被沖掉 → 宿主半邊不掛載
//   → **sidebar 沒有「團隊協同」，而且沒有任何錯誤訊息**。
//
// 這支測試把「兩份設定必須一致」變成可執行的斷言。
//
// 跑法：node test/deploy-consistency.js
// 環境：需要找得到 DSH_HOME；找不到時**跳過並明確說明**（不假裝通過）。
// =============================================================================

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ⚠️ 這支測試住在 `<repo>/ntfy-teams/test/`，所以 repo 根在**上兩層**。
// 第一版算成上一層，於是找不到 harness.ps1 —— 三條斷言全部誤報成「ntfy-teams
// 不在清單裡」。測試本身錯了會比沒有測試更糟（它會叫你去修一個沒壞的東西）。
const REPO_ROOT = path.join(__dirname, '..', '..');
const HARNESS_PS1 = path.join(REPO_ROOT, 'harness.ps1');

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
 * 找出 DSH_HOME。
 * @returns {string|null}
 */
function dshHome() {
  const env = process.env.DSH_HOME;
  if (env && fs.existsSync(env)) return env;
  const home = os.homedir();
  const cand = path.join(home, '.dsh');
  return fs.existsSync(cand) ? cand : null;
}

/**
 * 找出 profile 目錄。
 * @param home - DSH_HOME。
 * @returns {string|null}
 */
function profileDir(home) {
  const name = process.env.DSH_PROFILE || 'web';
  const dir = path.join(home, 'profiles', name);
  return fs.existsSync(dir) ? dir : null;
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
  const lines = text.split(/\r?\n/);
  const ids = [];
  let inInsert = false;
  let insertIndent = -1;
  lines.forEach((line) => {
    if (/^\s*#/.test(line)) return;                       // 註解不算
    const trimmed = line.trim();
    if (trimmed === '') return;
    const indent = line.length - line.trimStart().length;

    const isInsertKey = /^-\s*insert:\s*$/.test(trimmed);
    if (isInsertKey) {
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
 * 從 harness.ps1 的 `$plugins` 陣列抓出所有 Name（略過註解行）。
 * @param text - harness.ps1 的內容。
 * @returns {string[]}
 */
function harnessPluginNames(text) {
  const start = text.indexOf('$plugins = @(');
  if (start === -1) return [];
  const end = text.indexOf('\n)', start);
  const block = text.slice(start, end === -1 ? text.length : end);
  const names = [];
  block.split(/\r?\n/).forEach((line) => {
    if (/^\s*#/.test(line)) return;                       // 註解掉的插件不算
    const m = line.match(/Name\s*=\s*"([^"]+)"/);
    if (m) names.push(m[1]);
  });
  return names;
}

function main() {
  console.log('== 部署設定一致性：harness.ps1 ↔ profile 的 cordis.patch.yml');
  console.log('');

  // 1) harness.ps1 本身：清單要讀得到、且語法看起來對
  check('harness.ps1 存在且讀得到', () => {
    assert.ok(fs.existsSync(HARNESS_PS1), '找不到 ' + HARNESS_PS1);
    assert.ok(fs.readFileSync(HARNESS_PS1, 'utf8').length > 0, 'harness.ps1 是空的');
  });

  const harnessText = fs.existsSync(HARNESS_PS1) ? fs.readFileSync(HARNESS_PS1, 'utf8') : '';
  let names = [];
  check('harness.ps1 的 $plugins 清單解析得出插件', () => {
    names = harnessPluginNames(harnessText);
    assert.ok(names.length > 0, '解析不到任何 Name（清單格式變了嗎？）');
  });

  // 2) ★ 核心斷言：ntfy-teams 必須在清單裡
  //
  // 這是最直接的一條：不在清單裡，harness.ps1 一跑就會把它從 profile 移除。
  check('★ ntfy-teams 在 harness.ps1 的 $plugins 清單裡', () => {
    assert.ok(names.indexOf('ntfy-teams') !== -1,
      'ntfy-teams 不在 $plugins 裡 —— harness.ps1 一跑就會把它從 profile 移除，'
      + 'sidebar 的「團隊協同」會消失（而且沒有任何錯誤）。實際清單：'
      + JSON.stringify(names));
  });

  // 3) 套件的 patch 檔本身要提供 insert 行
  //
  //    本插件走「標準」註冊（列在 profile 的 dsh.profile.bundles），這種情況下
  //    DSH 會自動套用套件自己的 cordis.patch.yml，那條 insert 就是**宿主半邊的
  //    掛載點**。少了它，bundle 載入了但宿主半邊不掛，sidebar 一樣不會出現。
  check('ntfy-teams/cordis.patch.yml 提供 ntfy-teams 的 insert 行', () => {
    const p = path.join(REPO_ROOT, 'ntfy-teams', 'cordis.patch.yml');
    assert.ok(fs.existsSync(p), '找不到 ' + p);
    const ids = insertIds(fs.readFileSync(p, 'utf8'));
    assert.ok(ids.indexOf('ntfy-teams') !== -1,
      '套件的 patch 沒有 ntfy-teams 的 insert 行，實際：' + JSON.stringify(ids));
  });

  // 4) profile 端：與 harness.ps1 清單一致
  const home = dshHome();
  if (!home) {
    skip('profile 的 insert 行都有對應的 harness 清單項', '找不到 DSH_HOME');
  } else {
    const pd = profileDir(home);
    if (!pd) {
      skip('profile 的 insert 行都有對應的 harness 清單項',
        '找不到 profile 目錄（' + path.join(home, 'profiles', process.env.DSH_PROFILE || 'web') + '）');
    } else {
      const patchPath = path.join(pd, 'cordis.patch.yml');
      check('profile 的 cordis.patch.yml 存在且合法', () => {
        assert.ok(fs.existsSync(patchPath), '找不到 ' + patchPath);
        const txt = fs.readFileSync(patchPath, 'utf8');
        assert.ok(txt.trim().length > 0, 'patch 是空的');
        // 頂層必須是 YAML 陣列（DSH 的 patch 層格式）
        assert.ok(/^\s*\[|\s*-\s/.test(txt), 'patch 看起來不是 YAML 陣列');
      });

      const patchText = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '';
      const ids = insertIds(patchText);

      // ★ 兩種註冊方式**互斥**，不能混用。
      //
      //   方式 A（本插件用的、「清單式」）：
      //       套件列在 harness.ps1 的 $plugins 裡 → `dsh plugin add` 把它寫進 profile
      //       的 dependencies + `dsh.profile.bundles`，並自動套用套件自己的
      //       cordis.patch.yml。**profile 的 patch 不該再為它加 insert** ——
      //       同一個 loader id 出現兩次會讓 Loader 丟 `duplicate loader entry id`。
      //       （zhtw / cute-clock / scene-template / no-browser-auth 都是這條。）
      //
      //   方式 B（jeeflow-panel 用的、「手寫式」）：
      //       只寫 profile 的 patch insert，**刻意不列進 bundles**；它也不在
      //       harness.ps1 的 $plugins 裡，所以 harness 重算時不會去動它。
      //
      //   實測踩過：我用 A 裝好之後又手寫了一條 B 的 insert → 兩者並存。
      check('★ harness.ps1 管的插件都不在 profile 的 patch insert 裡（避免雙重註冊）', () => {
        const listed = harnessPluginNames(harnessText);
        const overlap = listed.filter((n) => ids.indexOf(n) !== -1);
        assert.strictEqual(overlap.length, 0,
          '這些插件同時由 harness.ps1 清單（→ bundles）與 profile 的 patch insert 註冊，'
          + '會造成 duplicate loader entry id：' + JSON.stringify(overlap)
          + '（profile insert：' + JSON.stringify(ids) + '）');
      });

      check('profile 的 dependencies 有 ntfy-teams（name 才解析得到）', () => {
        const pj = path.join(pd, 'package.json');
        if (!fs.existsSync(pj)) { skipped.push('無 package.json'); return; }
        const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'));
        const deps = (pkg && pkg.dependencies) || {};
        assert.ok(Object.prototype.hasOwnProperty.call(deps, 'ntfy-teams'),
          'profile 的 dependencies 沒有 ntfy-teams，實際：' + JSON.stringify(Object.keys(deps)));
      });

      check('★ ntfy-teams 列在 dsh.profile.bundles 裡（否則不會被載入）', () => {
        const pj = path.join(pd, 'package.json');
        if (!fs.existsSync(pj)) { skipped.push('無 package.json'); return; }
        const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'));
        const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
        assert.ok(bundles.indexOf('ntfy-teams') !== -1,
          'ntfy-teams 不在 dsh.profile.bundles 裡 —— 它不會被載入，sidebar 也不會出現。'
          + '實際：' + JSON.stringify(bundles));
      });
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
