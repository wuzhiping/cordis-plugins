/**
 * Build `client/bundle.js` from `client/index.js`.
 *
 * 靜態 bundle 協定：`window.__ModuleLoader__.load({ id, factory })` 註冊 lazy
 * CommonJS factory，`react` 是 platform module。本腳本注入
 * `var React = require("react")` 與 module/exports 鷹架，包裹動態外掛原始碼
 * （client/index.js 自包含，沒有外部 helper）。執行：npm run build:client
 *
 * **先驗證、再落地**：寫檔前一定先解析一次產物。外掛的 CSS 寫在 JS 的 template
 * literal 裡，裡面的註解只要出現一個反引號就會提前結束字串，產物變成語法錯誤 ——
 * 而瀏覽器只會說「import failed」，整個面板掛掉（2026-10-17 真的踩過）。寧可這次
 * 建置失敗、保留上一份可用的 bundle，也不要寫出一個壞的。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const sourcePath = join(here, '..', 'client', 'index.js')
const bundlePath = join(here, '..', 'client', 'bundle.js')
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
const source = readFileSync(sourcePath, 'utf8')

const banner = `/* Generated from client/index.js by scripts/build-client.mjs — do not edit by hand.
 * Regenerate with: npm run build:client
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
    var React = require("react")
`

const footer = `
    return module.exports
  }
})
`

const indent = (code) => code
  .split('\n')
  .map((line) => (line.length === 0 ? line : '    ' + line))
  .join('\n')

const output = banner + indent(source) + footer

// 產物必須能解析，否則不要覆蓋舊的（舊的至少能讓面板開起來）
try {
  new vm.Script(output, { filename: 'client/bundle.js' })
} catch (error) {
  console.error(`build failed: client/index.js 產生出來的 bundle 有語法錯誤，已保留舊的 client/bundle.js`)
  console.error(`  ${error.message}`)
  console.error('  提示：CSS 是在 template literal 裡 —— 註解／字串裡不能出現反引號。')
  process.exitCode = 1
  process.exit(1)
}

// 順手檢查原始碼的反引號是成對的（上面若僥倖通過，這一條會說明原因）
const backticks = (source.match(/`/g) || []).length
if (backticks % 2 !== 0) {
  console.error(`build failed: client/index.js 的反引號數量是奇數（${backticks}）→ template literal 沒收好`)
  process.exitCode = 1
  process.exit(1)
}

writeFileSync(bundlePath, output, 'utf8')
console.log(`built ${bundlePath} (${source.length} source bytes)`)

