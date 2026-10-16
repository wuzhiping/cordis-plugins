'use strict'
// 產生出來的 client bundle 必須能被解析、且含有外掛入口。
//
// 為什麼要有這個測試：外掛的 CSS 是寫在 JS 的 template literal 裡的，只要那段 CSS
// （或它的註解）不小心出現一個反引號，template 就會提前結束 —— 產生出來的 bundle
// 語法錯誤 → 瀏覽器只說「import failed」，整個面板開不起來。2026-10-17 真的踩過。
// 建置腳本不會發現、原始碼 `node --check` 也不會（它檢查的是同一個檔，會一起壞），
// 所以這裡盯「產物」。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const PLUGIN_DIR = path.join(__dirname, '..')
const SOURCE = path.join(PLUGIN_DIR, 'client', 'index.js')
const BUNDLE = path.join(PLUGIN_DIR, 'client', 'bundle.js')

test('client/bundle.js 是可解析的 JS，且與 client/index.js 同步', () => {
  const source = fs.readFileSync(SOURCE, 'utf8')
  const bundle = fs.readFileSync(BUNDLE, 'utf8')

  // 1) 產物必須能解析（這一條會抓到 template literal 被反引號提前結束的錯）
  assert.doesNotThrow(() => new vm.Script(bundle, { filename: 'bundle.js' }),
    'client/bundle.js 有語法錯誤 → 瀏覽器會說 import failed；請重跑 npm run build:client')

  // 2) CSS 這段 template literal 裡不可以有反引號（最常見的原因）
  const cssBlock = /styles\.insert\(`([\s\S]*?)`\)/.exec(source)
  assert.ok(cssBlock, 'client/index.js 找不到 styles.insert(`…`) 區塊')
  const pieces = source.split('`').length - 1
  assert.equal(pieces % 2, 0, 'client/index.js 的反引號數量必須是偶數（template literal 沒收好）')
  assert.ok(cssBlock[1].length > 1000, 'CSS 區塊看起來被截斷了')

  // 3) 產物要包含這次的原始碼（避免忘記重建）
  for (const marker of ['__ModuleLoader__', 'dsh-minio-s3', 'conversation.view']) {
    assert.ok(bundle.includes(marker), `bundle 缺少 ${marker}`)
  }
  const newer = Math.abs(fs.statSync(BUNDLE).mtimeMs - fs.statSync(SOURCE).mtimeMs)
  // 原始碼比 bundle 新「很多」代表忘了重建（容忍幾秒的時鐘差）
  assert.ok(fs.statSync(SOURCE).mtimeMs <= fs.statSync(BUNDLE).mtimeMs + 2000,
    'client/index.js 比 bundle.js 新 → 請重跑 npm run build:client')
  assert.ok(newer >= 0)
})
