'use strict'
/**
 * 面板是否真的載入：從執行中的 GUI 抓 `__DSH_BOOT__`，確認有這個外掛的 client 半邊、
 * 那個 URL 回 200，而且內容可以解析。
 *
 * 這是 2026-10-17 那次「dsh-minio-s3: import failed → 整個頁籤消失」事故的檢查工具：
 * 症狀是 boot 條目不見、或條目在但 bundle 語法錯誤。需要 GUI 正在 127.0.0.1:3080。
 */
const vm = require('node:vm')

const BASE = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const PLUGIN_ID = 'dsh-minio-s3'
let failed = 0
const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra === undefined ? '' : ' — ' + JSON.stringify(extra)))
  if (!cond) failed += 1
}

;(async () => {
  let html = ''
  try {
    html = await (await fetch(`${BASE}/`)).text()
  } catch (error) {
    ok(`連得上 ${BASE}`, false, error.message)
    process.exitCode = 1
    return
  }
  ok(`連得上 ${BASE}`, true, `${html.length} bytes`)

  const marker = 'globalThis["__DSH_BOOT__"] = '
  const start = html.indexOf(marker)
  ok('頁面有 __DSH_BOOT__', start >= 0)
  if (start < 0) { process.exitCode = 1; return }

  const end = html.indexOf('</script>', start)
  const boot = JSON.parse(html.slice(start + marker.length, end).trim().replace(/;$/, ''))
  const entry = (boot.entries || []).find((item) => item.id === PLUGIN_ID)
  ok('boot 條目裡有這個外掛', Boolean(entry), entry ? entry.url : `entries=${boot.entries.length}`)
  if (!entry) { process.exitCode = 1; return }

  // entry.url 已經是 `plugins/??<id>/client.js&rev=…` 的相對形式
  const response = await fetch(`${BASE}/${entry.url}`)
  const body = await response.text()
  ok('client bundle 回 200', response.status === 200, { status: response.status, bytes: body.length })

  try {
    new vm.Script(body, { filename: 'served-client.js' })
    ok('client bundle 可以解析', true)
  } catch (error) {
    ok('client bundle 可以解析', false, error.message)
  }

  ok('bundle 是這個外掛的入口', body.includes('__ModuleLoader__') && body.includes(PLUGIN_ID))
  ok('bundle 含面板功能（multipart 上傳）', body.includes('uploadMultipart'))

  console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
  process.exitCode = failed === 0 ? 0 : 1
})().catch((error) => { console.log('FATAL', (error && error.stack) || error); process.exitCode = 1 })
