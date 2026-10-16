'use strict'

/**
 * host.js 的整合測試：把整個外掛掛在一個假的 cordis ctx 上，並用**記憶體裡的
 * 假 MinIO**（外加假的 BDD storage 端點）驅動每一條路由與每一個工具。
 *
 * 為什麼要假到這個程度：這條路徑上真正會壞的地方是「兩層之間的接縫」——
 * SigV4 標頭、path-style 的 key 編碼、MinIO 的 `+`/`%2B` 不一致、Content-MD5、
 * 路由的信任柵欄、工作區邊界。單獨測 s3-core 或 s3-client 都碰不到它們。
 *
 * 這個測試不打任何網路：`globalThis.fetch` 在 apply 之前被換掉。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')

const host = require('../src/index')

const STORAGE_URL = 'https://abc.feg.com.tw/BDD/API/AI/dsh/storage/s3'

/** MinIO 的 ListObjectsV2 用 url.QueryEscape 編碼（空間 → `+`，`+` → `%2B`）。 */
function minioEncode(value) {
  return encodeURIComponent(value).replace(/%20/g, '+')
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status: status || 200,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * 記憶體假 MinIO：只實作這個外掛用到的那幾個 S3 動作，但回應形狀照著真實
 * MinIO（含 encoding-type=url 的 `+` 行為、DeleteObjects 要 Content-MD5）。
 */
function createFakeMinio() {
  const buckets = new Map([
    ['dsh', new Map()],
    ['empty-bucket', new Map()],
  ])
  const state = { calls: [], storageCalls: 0, authHeaders: [] }

  function listXml(bucket, prefix, delimiter) {
    const store = buckets.get(bucket)
    const keys = [...store.keys()].sort()
    const contents = []
    const common = new Set()
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue
      if (delimiter) {
        const rest = key.slice(prefix.length)
        const index = rest.indexOf(delimiter)
        if (index >= 0) {
          common.add(prefix + rest.slice(0, index + delimiter.length))
          continue
        }
      }
      const entry = store.get(key)
      contents.push('<Contents><Key>' + xmlEscape(minioEncode(key)) + '</Key>'
        + '<LastModified>2026-10-16T12:00:00.000Z</LastModified>'
        + '<ETag>&quot;' + entry.etag + '&quot;</ETag>'
        + '<Size>' + entry.body.length + '</Size><StorageClass>STANDARD</StorageClass></Contents>')
    }
    return '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>'
      + '<Name>' + xmlEscape(bucket) + '</Name>'
      + '<Prefix>' + xmlEscape(minioEncode(prefix)) + '</Prefix>'
      + '<Delimiter>' + xmlEscape(minioEncode(delimiter || '')) + '</Delimiter>'
      + '<KeyCount>' + contents.length + '</KeyCount><MaxKeys>1000</MaxKeys>'
      + '<EncodingType>url</EncodingType><IsTruncated>false</IsTruncated>'
      + contents.join('')
      + [...common].map((entry) => '<CommonPrefixes><Prefix>' + xmlEscape(minioEncode(entry)) + '</Prefix></CommonPrefixes>').join('')
      + '</ListBucketResult>'
  }

  async function handle(url, init) {
    const method = String(init.method || 'GET').toUpperCase()
    const headers = init.headers || {}
    const body = init.body === undefined || init.body === null
      ? Buffer.alloc(0)
      : (Buffer.isBuffer(init.body) ? init.body : Buffer.from(String(init.body)))

    state.authHeaders.push(headers.Authorization || '')
    if (!/^AWS4-HMAC-SHA256 Credential=uid\//.test(headers.Authorization || '')) {
      return new Response('<Error><Code>SignatureDoesNotMatch</Code><Message>bad signature</Message></Error>', { status: 403 })
    }
    state.calls.push({ method, path: url.pathname, search: url.search, headers, body })

    const segments = url.pathname.split('/').slice(1).map((part) => {
      try { return decodeURIComponent(part) } catch { return part }
    })
    const bucket = segments[0] || ''
    const key = segments.slice(1).join('/')

    // ListBuckets
    if (bucket === '') {
      if (method !== 'GET') return new Response('', { status: 405 })
      return new Response('<?xml version="1.0"?><ListAllMyBucketsResult><Buckets>'
        + [...buckets.keys()].map((name) => '<Bucket><Name>' + xmlEscape(name) + '</Name>'
          + '<CreationDate>2026-10-16T12:17:00.421Z</CreationDate></Bucket>').join('')
        + '</Buckets></ListAllMyBucketsResult>', { status: 200 })
    }

    if (bucket !== '' && key === '') {
      if (method === 'PUT') {
        if (buckets.has(bucket)) return new Response('<Error><Code>BucketAlreadyOwnedByYou</Code></Error>', { status: 409 })
        buckets.set(bucket, new Map())
        return new Response('', { status: 200 })
      }
      if (method === 'DELETE') {
        if (!buckets.has(bucket)) return new Response('<Error><Code>NoSuchBucket</Code><Message>no bucket</Message></Error>', { status: 404 })
        if (buckets.get(bucket).size > 0) return new Response('<Error><Code>BucketNotEmpty</Code><Message>not empty</Message></Error>', { status: 409 })
        buckets.delete(bucket)
        // 204 是 null-body status：`new Response('')` 會直接拋 TypeError。
        return new Response(null, { status: 204 })
      }
      if (method === 'HEAD') {
        return new Response(null, { status: buckets.has(bucket) ? 200 : 404 })
      }
      if (method === 'GET') {
        if (!buckets.has(bucket)) return new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 })
        const prefix = url.searchParams.get('prefix') || ''
        const delimiter = url.searchParams.get('delimiter') || ''
        return new Response(listXml(bucket, prefix, delimiter), { status: 200 })
      }
      if (method === 'POST' && url.searchParams.has('delete')) {
        if (!buckets.has(bucket)) return new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 })
        if (!headers['Content-MD5'] && !headers['content-md5']) {
          return new Response('<Error><Code>InvalidRequest</Code><Message>Missing required header for this request: Content-Md5.</Message></Error>', { status: 400 })
        }
        const store = buckets.get(bucket)
        const keys = [...body.toString('utf8').matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) => match[1]
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'))
        // 模擬 MinIO 的「HTTP 200 + 逐 key region 錯誤」（真實發生過的那個形狀）
        if (state.makeBatchFail) {
          return new Response('<DeleteResult>' + keys.map((key) => '<Error><Key>' + xmlEscape(key) + '</Key>'
            + '<Code>AuthorizationHeaderMalformed</Code>'
            + '<Message>The authorization header is malformed; the region is wrong; expecting \'us-west-rack-2\'.</Message>'
            + '</Error>').join('') + '</DeleteResult>', { status: 200 })
        }
        const deleted = []
        for (const entry of keys) {
          if (store.delete(entry)) deleted.push(entry)
          else deleted.push(entry)
        }
        return new Response('<DeleteResult>' + deleted.map((entry) => '<Deleted><Key>' + xmlEscape(entry) + '</Key></Deleted>').join('') + '</DeleteResult>', { status: 200 })
      }
      return new Response('<Error><Code>MethodNotAllowed</Code></Error>', { status: 405 })
    }

    const store = buckets.get(bucket)
    if (!store) return new Response('<Error><Code>NoSuchBucket</Code><Message>no bucket</Message></Error>', { status: 404 })

    if (method === 'PUT' && headers['x-amz-copy-source']) {
      const raw = String(headers['x-amz-copy-source'])
      const source = decodeURIComponent(raw.replace(/^\//, ''))
      const slash = source.indexOf('/')
      const fromKey = source.slice(slash + 1)
      const entry = store.get(fromKey)
      if (!entry) return new Response('<Error><Code>NoSuchKey</Code><Message>no key</Message></Error>', { status: 404 })
      store.set(key, { ...entry })
      return new Response('<CopyObjectResult><ETag>&quot;' + entry.etag + '&quot;</ETag></CopyObjectResult>', { status: 200 })
    }
    if (method === 'PUT') {
      store.set(key, {
        body,
        etag: require('node:crypto').createHash('md5').update(body).digest('hex'),
        contentType: headers['Content-Type'] || 'application/octet-stream',
      })
      return new Response('', { status: 200, headers: { etag: '"' + require('node:crypto').createHash('md5').update(body).digest('hex') + '"' } })
    }
    if (method === 'GET' || method === 'HEAD') {
      const entry = store.get(key)
      if (!entry) return new Response('<Error><Code>NoSuchKey</Code><Message>no key</Message><Resource>' + xmlEscape(key) + '</Resource></Error>', { status: 404 })
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-type': entry.contentType, 'content-length': String(entry.body.length), etag: '"' + entry.etag + '"' },
        })
      }
      return new Response(entry.body, { status: 200, headers: { 'content-type': entry.contentType, 'content-length': String(entry.body.length) } })
    }
    if (method === 'DELETE') {
      store.delete(key)
      return new Response(null, { status: 204 })
    }
    return new Response('<Error><Code>MethodNotAllowed</Code></Error>', { status: 405 })
  }

  async function fetchImpl(url, init) {
    const parsed = new URL(String(url))
    if (parsed.hostname === 'abc.feg.com.tw') {
      state.storageCalls += 1
      assert.equal(String(url), STORAGE_URL)
      const payload = JSON.parse(init.body)
      assert.match(payload.apiKey, /^sk-[A-Za-z0-9+/=]+$/)
      return json({ S3_URL: 'http://minio.test:7000', UID: 'uid', PWD: 'pwd', BUCKET: 'dsh' })
    }
    if (parsed.hostname === 'minio.test') return handle(parsed, init)
    throw new Error('unexpected host: ' + parsed.hostname)
  }

  return { buckets, state, fetchImpl }
}

/** 假 ctx + 假 req/res，足以驅動 host.apply 註冊的每一條路由與工具。 */
function mountHost(options) {
  const opts = options || {}
  const routes = new Map()
  const tools = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(callback) { return callback() },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    connection: { requestRejection: () => opts.rejection },
    sessions: {
      get(id) {
        if (opts.sessionCwd && (id === 's1' || id === opts.sessionId)) return { header: { cwd: opts.sessionCwd } }
        return null
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  host.apply(ctx)
  return { routes, tools }
}

/** 驅動一條路由（含 req 串流模擬），回傳 `{status, headers, body}`。 */
function call(route, options) {
  const opts = options || {}
  return new Promise((resolve, reject) => {
    const chunks = []
    const payload = opts.body === undefined
      ? []
      : [Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body), 'utf8')]
    const req = Readable.from(payload)
    req.method = opts.method || 'GET'
    req.url = opts.url
    req.headers = opts.headers || {}
    const res = {
      headersSent: false,
      statusCode: 200,
      headers: {},
      writeHead(status, headers) {
        this.statusCode = status
        this.headers = headers || {}
        this.headersSent = true
      },
      write(chunk) {
        chunks.push(Buffer.from(chunk))
        return true
      },
      once() {},
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk))
        resolve({ status: this.statusCode, headers: this.headers, body: Buffer.concat(chunks) })
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

function jsonBody(result) {
  return JSON.parse(result.body.toString('utf8'))
}

/** 每個測試：換掉 fetch、掛外掛、跑完還原。 */
function withHost(t, options, run) {
  const fake = createFakeMinio()
  const original = globalThis.fetch
  globalThis.fetch = fake.fetchImpl
  const mounted = mountHost(options)
  t.after(() => { globalThis.fetch = original })
  return run({ fake, ...mounted })
}

test('status：回連線狀態與桶清單，且不外洩端點與帳密', async (t) => {
  await withHost(t, {}, async ({ routes, fake }) => {
    const result = await call(routes.get(host.ROUTE.status), { url: host.ROUTE.status })
    const payload = jsonBody(result)
    assert.equal(result.status, 200)
    assert.equal(payload.ok, true)
    assert.equal(payload.configured, true)
    assert.equal(payload.version, host.version)
    assert.equal(payload.bucket, 'dsh')
    assert.deepEqual(payload.buckets.map((entry) => entry.name), ['dsh', 'empty-bucket'])
    const raw = JSON.stringify(payload)
    assert.ok(!raw.includes('minio.test'), '不可以回端點')
    assert.ok(!raw.includes('pwd'), '不可以回密碼')
    assert.ok(!raw.includes('uid'), '不可以回帳號')
    // 面板是會被截圖的：region 與連線來源預設不出現在回應裡。
    assert.equal(payload.region, undefined)
    assert.equal(payload.source, undefined)
    assert.equal(payload.ref, undefined)
    assert.equal(fake.state.storageCalls, 1)
  })
})

test('status?debug=1：明示除錯時才回 region、來源與憑證 ref', async (t) => {
  await withHost(t, {}, async ({ routes }) => {
    const result = await call(routes.get(host.ROUTE.status), { url: host.ROUTE.status + '?debug=1' })
    const payload = jsonBody(result)
    assert.equal(payload.ok, true)
    assert.equal(payload.region, 'us-east-1')
    assert.equal(payload.source, 'https://abc.feg.com.tw/BDD/API/AI/dsh/storage/s3')
    assert.equal(payload.ref, 'AIFE_API_KEY')
  })
})

test('status：連線失敗時不回原始訊息（路徑／端點），只給階段說法', async (t) => {
  const original = globalThis.fetch
  globalThis.fetch = async () => json({ S3_URL: 'http://minio.test:7000', UID: 'uid' }) // 少了 PWD
  const { routes } = mountHost({})
  t.after(() => { globalThis.fetch = original })
  const result = await call(routes.get(host.ROUTE.status), { url: host.ROUTE.status })
  const payload = jsonBody(result)
  assert.equal(result.status, 200)
  assert.equal(payload.ok, false)
  assert.equal(payload.configured, false)
  assert.equal(payload.error, '連線服務沒有可用的資料')
  assert.equal(payload.detail, undefined, '預設不回原始訊息')
  const raw = JSON.stringify(payload)
  assert.ok(!raw.includes('S3_UID'), '不回欄位清單')
  assert.ok(!raw.includes('abc.feg.com.tw'), '不回 storage 端點')

  const debug = jsonBody(await call(routes.get(host.ROUTE.status), { url: host.ROUTE.status + '?debug=1' }))
  assert.match(debug.detail, /PWD/)
})

test('信任柵欄：connection.requestRejection 有值時一律短路', async (t) => {
  await withHost(t, { rejection: 403 }, async ({ routes, fake }) => {
    const result = await call(routes.get(host.ROUTE.status), { url: host.ROUTE.status })
    assert.equal(result.status, 403)
    assert.equal(fake.state.storageCalls, 0)
    assert.equal(fake.state.calls.length, 0)
  })
})

test('物件生命週期：上傳 → 列表 → 下載 → 預覽 → 改名 → 刪除', async (t) => {
  await withHost(t, {}, async ({ routes, fake }) => {
    const object = routes.get(host.ROUTE.object)
    const objects = routes.get(host.ROUTE.objects)

    // 上傳（key 有空白、+ 與中文：一次測完 path 編碼與列表解碼）
    const key = 'logs/2026/a+b c 中文.txt'
    const upload = await call(object, {
      method: 'PUT',
      url: host.ROUTE.object + '?bucket=dsh&key=' + encodeURIComponent(key),
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: Buffer.from('hello minio\n第二行\n', 'utf8'),
    })
    assert.equal(upload.status, 200)
    assert.equal(jsonBody(upload).size, Buffer.byteLength('hello minio\n第二行\n'))
    assert.ok(fake.state.calls.every((entry) => /^AWS4-HMAC-SHA256 Credential=uid\//.test(entry.headers.Authorization)))

    // 同一層的資料夾標記
    await call(routes.get(host.ROUTE.folder), {
      method: 'POST',
      url: host.ROUTE.folder,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bucket: 'dsh', key: 'logs/' }),
    })

    // 一層列表（delimiter=/）
    const listed = await call(objects, { url: host.ROUTE.objects + '?bucket=dsh&prefix=logs/2026/' })
    const listing = jsonBody(listed)
    assert.equal(listed.status, 200)
    assert.deepEqual(listing.objects.map((entry) => entry.key), [key])
    assert.deepEqual(listing.objects.map((entry) => entry.name), ['a+b c 中文.txt'])

    const root = jsonBody(await call(objects, { url: host.ROUTE.objects + '?bucket=dsh&prefix=' }))
    assert.deepEqual(root.folders.map((entry) => entry.prefix), ['logs/'])

    // 下載（attachment）
    const download = await call(object, { url: host.ROUTE.object + '?bucket=dsh&key=' + encodeURIComponent(key) })
    assert.equal(download.status, 200)
    assert.equal(download.body.toString('utf8'), 'hello minio\n第二行\n')
    assert.match(download.headers['content-disposition'], /^attachment; filename\*=UTF-8''/)
    assert.equal(download.headers['content-type'], 'text/plain; charset=utf-8')

    // 預覽：`inline=1` 只放行點陣圖。這個物件是 text/plain，所以被降成
    // attachment + octet-stream（同源代理不能讓 HTML/SVG 進來跑腳本）。
    const inlineText = await call(object, { url: host.ROUTE.object + '?bucket=dsh&key=' + encodeURIComponent(key) + '&inline=1' })
    assert.equal(inlineText.status, 200)
    assert.match(inlineText.headers['content-disposition'], /^attachment;/)
    assert.equal(inlineText.headers['content-type'], 'application/octet-stream')
    assert.equal(inlineText.headers['x-content-type-options'], 'nosniff')

    // 點陣圖就走 inline（客戶端的圖片預覽靠這條）
    const pngKey = 'logs/pixel.png'
    await call(object, {
      method: 'PUT',
      url: host.ROUTE.object + '?bucket=dsh&key=' + encodeURIComponent(pngKey),
      headers: { 'content-type': 'image/png' },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    })
    const inlinePng = await call(object, { url: host.ROUTE.object + '?bucket=dsh&key=' + encodeURIComponent(pngKey) + '&inline=1' })
    assert.equal(inlinePng.headers['content-type'], 'image/png')
    assert.equal(inlinePng.headers['content-disposition'], undefined)
    assert.equal(inlinePng.headers['x-content-type-options'], 'nosniff')

    // SVG 帶得動 script，一律不 inline
    const svgKey = 'logs/evil.svg'
    await call(object, {
      method: 'PUT',
      url: host.ROUTE.object + '?bucket=dsh&key=' + encodeURIComponent(svgKey),
      headers: { 'content-type': 'image/svg+xml' },
      body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    })
    const inlineSvg = await call(object, { url: host.ROUTE.object + '?bucket=dsh&key=' + encodeURIComponent(svgKey) + '&inline=1' })
    assert.equal(inlineSvg.headers['content-type'], 'application/octet-stream')
    assert.match(inlineSvg.headers['content-disposition'], /^attachment;/)

    // 這兩個是為了測 inline 白名單才建的，收掉以免影響後面的斷言
    for (const extra of [pngKey, svgKey]) {
      await call(object, { method: 'DELETE', url: host.ROUTE.object + '?bucket=dsh&key=' + encodeURIComponent(extra) })
    }

    // HEAD 走上游的 HEAD（不會把整個物件拉下來）
    const head = await call(object, { method: 'HEAD', url: host.ROUTE.object + '?bucket=dsh&key=' + encodeURIComponent(key) })
    assert.equal(head.status, 200)
    assert.equal(head.headers['content-length'], String(Buffer.byteLength('hello minio\n第二行\n')))
    assert.equal(head.body.length, 0)
    assert.equal(
      fake.state.calls.filter((entry) => entry.method === 'HEAD' && entry.path.endsWith('%E4%B8%AD%E6%96%87.txt')).length,
      1,
      'HEAD 應該只發一次上游 HEAD',
    )

    // 改名（copy + delete）
    const renamed = await call(routes.get(host.ROUTE.copy), {
      method: 'POST',
      url: host.ROUTE.copy,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bucket: 'dsh', fromKey: key, toKey: 'logs/2026/renamed.txt' }),
    })
    assert.equal(renamed.status, 200)
    assert.equal(jsonBody(renamed).copied, true)
    // x-amz-copy-source 必須是「以 / 開頭的路徑」，且 key 依 URL 規則編碼
    const copyCall = fake.state.calls.find((entry) => entry.method === 'PUT' && entry.headers['x-amz-copy-source'])
    assert.equal(copyCall.headers['x-amz-copy-source'], '/dsh/logs/2026/a%2Bb%20c%20%E4%B8%AD%E6%96%87.txt')

    // /copy 只做伺服器端複製（S3 沒有 rename）；UI 的「改名」= copy + delete。
    const afterCopy = jsonBody(await call(objects, { url: host.ROUTE.objects + '?bucket=dsh&prefix=logs/2026/' }))
    assert.deepEqual(afterCopy.objects.map((entry) => entry.key), [key, 'logs/2026/renamed.txt'])

    const renameCompletion = await call(routes.get(host.ROUTE.del), {
      method: 'POST',
      url: host.ROUTE.del,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bucket: 'dsh', keys: [key] }),
    })
    assert.equal(renameCompletion.status, 200)
    const afterRename = jsonBody(await call(objects, { url: host.ROUTE.objects + '?bucket=dsh&prefix=logs/2026/' }))
    assert.deepEqual(afterRename.objects.map((entry) => entry.key), ['logs/2026/renamed.txt'])

    // 刪除單一物件 + 批次刪除（批次那條要求 Content-MD5）
    const single = await call(object, {
      method: 'DELETE',
      url: host.ROUTE.object + '?bucket=dsh&key=' + encodeURIComponent('logs/2026/renamed.txt'),
    })
    assert.equal(single.status, 200)
    const remaining = jsonBody(await call(objects, { url: host.ROUTE.objects + '?bucket=dsh&prefix=logs/' }))
    assert.deepEqual(remaining.objects.map((entry) => entry.key), ['logs/'])

    const batch = await call(routes.get(host.ROUTE.del), {
      method: 'POST',
      url: host.ROUTE.del,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bucket: 'dsh', keys: ['logs/'] }),
    })
    assert.equal(batch.status, 200)
    assert.deepEqual(jsonBody(batch).deleted, ['logs/'])
  })
})

test('export：要 POST + 專用標頭才回得出憑證與設定，且平常不出現在別的回應裡', async (t) => {
  await withHost(t, {}, async ({ routes, fake }) => {
    const EXPORT_HEADER = { 'x-dsh-minio-s3': 'export', 'content-type': 'application/json' }
    const exported = await call(routes.get(host.ROUTE.exportConfig), {
      method: 'POST',
      url: host.ROUTE.exportConfig,
      headers: EXPORT_HEADER,
    })
    const payload = jsonBody(exported)
    assert.equal(exported.status, 200)
    assert.equal(payload.ok, true)
    assert.deepEqual(
      {
        provider: payload.provider,
        endpoint: payload.endpoint,
        accessKey: payload.accessKey,
        secretKey: payload.secretKey,
        region: payload.region,
        bucket: payload.bucket,
        usePathStyle: payload.usePathStyle,
      },
      {
        provider: 'minio',
        endpoint: 'http://minio.test:7000',
        accessKey: 'uid',
        secretKey: 'pwd',
        region: 'us-east-1',
        bucket: 'dsh',
        usePathStyle: true,
      },
    )
    assert.deepEqual(payload.buckets, ['dsh', 'empty-bucket'])
    assert.match(payload.exportedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(exported.headers['cache-control'], 'no-store')
    assert.ok(fake.state.calls.length > 0)

    // 沒有專用標頭：不給（「簡單請求」帶不出自訂標頭，跨站就得多一次預檢）
    const noHeader = await call(routes.get(host.ROUTE.exportConfig), { method: 'POST', url: host.ROUTE.exportConfig })
    assert.equal(noHeader.status, 400)
    assert.ok(!noHeader.body.toString('utf8').includes('pwd'))

    // GET 不給（避免被預取或快取帶走金鑰）
    const viaGet = await call(routes.get(host.ROUTE.exportConfig), { url: host.ROUTE.exportConfig, headers: EXPORT_HEADER })
    assert.equal(viaGet.status, 405)

    // 其他瀏覽器可見的回應仍不含金鑰
    const status = jsonBody(await call(routes.get(host.ROUTE.status), { url: host.ROUTE.status }))
    assert.ok(!JSON.stringify(status).includes('pwd'))
  })

  // 維運斷路器
  process.env.DSH_MINIO_S3_NO_EXPORT = '1'
  t.after(() => { delete process.env.DSH_MINIO_S3_NO_EXPORT })
  await withHost(t, {}, async ({ routes }) => {
    const blocked = await call(routes.get(host.ROUTE.exportConfig), {
      method: 'POST',
      url: host.ROUTE.exportConfig,
      headers: { 'x-dsh-minio-s3': 'export' },
    })
    assert.equal(blocked.status, 403)
    assert.ok(!blocked.body.toString('utf8').includes('pwd'))
  })
})

test('presign：回一條帶簽章的 URL，且不經過宿主代理', async (t) => {  await withHost(t, {}, async ({ routes }) => {
    const result = await call(routes.get(host.ROUTE.presign), {
      url: host.ROUTE.presign + '?bucket=dsh&key=a.txt&expires=600',
    })
    const payload = jsonBody(result)
    assert.equal(result.status, 200)
    assert.match(payload.url, /^http:\/\/minio\.test:7000\/dsh\/a\.txt\?X-Amz-Algorithm=AWS4-HMAC-SHA256/)
    assert.match(payload.url, /X-Amz-Signature=[0-9a-f]{64}/)
    assert.equal(payload.expires, 600)
  })
})

test('桶：建立、列舉、刪除（非空桶回 409）', async (t) => {
  await withHost(t, {}, async ({ routes }) => {
    const buckets = routes.get(host.ROUTE.buckets)
    const created = await call(buckets, { method: 'PUT', url: host.ROUTE.buckets + '?bucket=brand-new' })
    assert.equal(created.status, 200)
    assert.equal(jsonBody(created).created, true)

    const listed = jsonBody(await call(buckets, { url: host.ROUTE.buckets }))
    assert.deepEqual(listed.buckets.map((entry) => entry.name), ['dsh', 'empty-bucket', 'brand-new'])

    const removed = await call(buckets, { method: 'DELETE', url: host.ROUTE.buckets + '?bucket=brand-new' })
    assert.equal(removed.status, 200)

    // 有物件的桶不可刪（409 而不是 500）
    await call(routes.get(host.ROUTE.object), {
      method: 'PUT',
      url: host.ROUTE.object + '?bucket=dsh&key=keep.txt',
      body: Buffer.from('x'),
    })
    const busy = await call(buckets, { method: 'DELETE', url: host.ROUTE.buckets + '?bucket=dsh' })
    assert.equal(busy.status, 409)
    assert.equal(jsonBody(busy).code, 'BucketNotEmpty')
  })
})

test('batch delete：逐 key 失敗時宿主自己退回單物件刪除（不能回「假成功」）', async (t) => {
  await withHost(t, {}, async ({ routes, fake }) => {
    const object = routes.get(host.ROUTE.object)
    const keys = ['retry/a.txt', 'retry/b.txt']
    for (const key of keys) {
      await call(object, {
        method: 'PUT',
        url: host.ROUTE.object + '?bucket=dsh&key=' + encodeURIComponent(key),
        body: Buffer.from('x'),
      })
    }

    // 讓批次刪除回「HTTP 200 + 逐 key AuthorizationHeaderMalformed」，但單物件刪除正常。
    fake.state.makeBatchFail = true
    t.after(() => { fake.state.makeBatchFail = false })

    const result = await call(routes.get(host.ROUTE.del), {
      method: 'POST',
      url: host.ROUTE.del,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bucket: 'dsh', keys }),
    })
    const payload = jsonBody(result)
    assert.equal(result.status, 200)
    assert.equal(payload.errors.length, 0, '退路成功後不該再回錯誤')
    assert.deepEqual([...payload.deleted].sort(), [...keys].sort())
    assert.equal(payload.retried, 2, '應該逐一重試兩個 key')

    const after = jsonBody(await call(routes.get(host.ROUTE.objects), {
      url: host.ROUTE.objects + '?bucket=dsh&prefix=retry/',
    }))
    assert.deepEqual(after.objects, [], '物件真的刪掉了')
  })
})

test('錯誤對映：缺 key 400、不存在的物件 404 且帶 S3 code', async (t) => {
  await withHost(t, {}, async ({ routes }) => {
    const object = routes.get(host.ROUTE.object)
    const bad = await call(object, { url: host.ROUTE.object + '?bucket=dsh' })
    assert.equal(bad.status, 400)
    assert.match(jsonBody(bad).error, /key 不可為空/)

    const escape = await call(object, { url: host.ROUTE.object + '?bucket=dsh&key=' + encodeURIComponent('../secret') })
    assert.equal(escape.status, 400)

    const missing = await call(object, { url: host.ROUTE.object + '?bucket=dsh&key=nope.txt' })
    assert.equal(missing.status, 404)
    const payload = jsonBody(missing)
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'NoSuchKey')
  })
})

test('工作區邊界：upload-path / download-path 只在會話 cwd 內，且擋掉逃逸', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'minio-s3-cwd-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'minio-s3-out-'))
  fs.writeFileSync(path.join(cwd, 'seed.txt'), 'seed-content')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
  t.after(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  await withHost(t, { sessionCwd: cwd, sessionId: 's1' }, async ({ routes }) => {
    const upload = routes.get(host.ROUTE.uploadPath)
    const download = routes.get(host.ROUTE.downloadPath)

    // 上傳工作區檔案 → 物件（key 省略時用檔名）
    const up = await call(upload, {
      method: 'POST',
      url: host.ROUTE.uploadPath,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', bucket: 'dsh', prefix: 'from-ws/', path: 'seed.txt' }),
    })
    assert.equal(up.status, 200)
    assert.equal(jsonBody(up).key, 'from-ws/seed.txt')
    assert.equal(jsonBody(up).source, 12)

    // 下載物件 → 工作區（自動建立父目錄）
    const down = await call(download, {
      method: 'POST',
      url: host.ROUTE.downloadPath,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', bucket: 'dsh', key: 'from-ws/seed.txt', path: 'nested/back.txt' }),
    })
    assert.equal(down.status, 200)
    assert.equal(fs.readFileSync(path.join(cwd, 'nested', 'back.txt'), 'utf8'), 'seed-content')

    // 逃逸：相對路徑往上跳
    const escape = await call(upload, {
      method: 'POST',
      url: host.ROUTE.uploadPath,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', bucket: 'dsh', key: 'x.txt', path: '../outside.txt' }),
    })
    assert.equal(escape.status, 400)

    // 逃逸：絕對路徑
    const absolute = await call(upload, {
      method: 'POST',
      url: host.ROUTE.uploadPath,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', bucket: 'dsh', key: 'x.txt', path: path.join(outside, 'secret.txt') }),
    })
    assert.equal(absolute.status, 400)

    // 未知會話
    const nobody = await call(upload, {
      method: 'POST',
      url: host.ROUTE.uploadPath,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'nope', bucket: 'dsh', key: 'x.txt', path: 'seed.txt' }),
    })
    assert.equal(nobody.status, 404)
  })
})

test('resolveInWorkspace：symlink 指到工作區外也要擋下來', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'minio-s3-link-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'minio-s3-target-'))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
  t.after(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  const link = path.join(cwd, 'link')
  try {
    fs.symlinkSync(outside, link, 'junction')
  } catch {
    // 沒有權限建立 symlink 的環境：這個案例就跳過（詞法檢查仍由上面的測試覆蓋）
    return
  }

  const inside = host.resolveInWorkspace(cwd, 'link/x.txt')
  assert.equal(inside.ok, false)
  assert.equal(inside.status, 403)
})

test('resolveInWorkspace：斷掉的符號連結也要擋（否則寫入會順著它跑到工作區外）', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'minio-s3-dangling-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'minio-s3-dangle-target-'))
  t.after(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  const victim = path.join(outside, 'pwn.txt')
  const dangling = path.join(cwd, 'esc')
  try {
    fs.symlinkSync(victim, dangling, 'file')
  } catch {
    return // 沒有建立 symlink 的權限
  }
  assert.equal(fs.existsSync(dangling), false, '前提：這是一個斷掉的連結')

  const resolved = host.resolveInWorkspace(cwd, 'esc')
  assert.equal(resolved.ok, false)
  assert.equal(resolved.status, 403)

  // 目錄也一樣：指向工作區外的目錄連結，即使目標還不存在
  const danglingDir = path.join(cwd, 'escdir')
  fs.symlinkSync(path.join(outside, 'sub'), danglingDir, 'dir')
  const resolvedDir = host.resolveInWorkspace(cwd, 'escdir/leak.txt')
  assert.equal(resolvedDir.ok, false)
  assert.equal(resolvedDir.status, 403)
})

test('shapeListing：空資料夾標記不會同時出現在 folders 與 objects', () => {
  const listing = {
    commonPrefixes: ['a/'],
    contents: [{ key: 'a/', size: 0, etag: '', lastModified: '', storageClass: '' }],
    isTruncated: false,
    nextContinuationToken: '',
    keyCount: 1,
  }
  const shaped = host.shapeListing('dsh', '', listing)
  assert.deepEqual(shaped.folders, [{ prefix: 'a/', name: 'a' }])
  assert.deepEqual(shaped.objects, [])

  const withReal = host.shapeListing('dsh', '', {
    ...listing,
    contents: [
      { key: 'a/', size: 0, etag: '', lastModified: '', storageClass: '' },
      { key: 'a/b.txt', size: 3, etag: 'e', lastModified: 'now', storageClass: 'STANDARD' },
    ],
  })
  assert.deepEqual(withReal.objects.map((entry) => entry.name), ['b.txt'])
  assert.deepEqual(withReal.folders.map((entry) => entry.name), ['a'])
})

test('agent 工具：五個都註冊，且能對同一份假 MinIO 讀寫管理', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'minio-s3-tools-'))
  fs.writeFileSync(path.join(cwd, 'local.txt'), 'from workspace')
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))

  await withHost(t, { sessionCwd: cwd, sessionId: 's1' }, async ({ tools }) => {
    assert.deepEqual([...tools.keys()].sort(), [
      'minio_bucket', 'minio_delete', 'minio_list', 'minio_read', 'minio_write',
    ])
    for (const definition of tools.values()) {
      assert.equal(definition.output.schema.type, 'object')
      assert.equal(typeof definition.execute, 'function')
      assert.equal(typeof definition.output.render, 'function')
    }

    const exec = { agent: { id: 's1' } }

    // list buckets
    const buckets = await tools.get('minio_list').execute({}, exec)
    assert.deepEqual(buckets.buckets.map((entry) => entry.name), ['dsh', 'empty-bucket'])

    // write inline + read back
    const written = await tools.get('minio_write').execute({ bucket: 'dsh', key: 'tools/hello.txt', content: '你好 minio' }, exec)
    assert.equal(written.bytes, Buffer.byteLength('你好 minio'))

    const read = await tools.get('minio_read').execute({ bucket: 'dsh', key: 'tools/hello.txt' }, exec)
    assert.equal(read.content, '你好 minio')
    assert.equal(read.encoding, 'text')

    const asBase64 = await tools.get('minio_read').execute({ bucket: 'dsh', key: 'tools/hello.txt', encoding: 'base64' }, exec)
    assert.equal(Buffer.from(asBase64.content, 'base64').toString('utf8'), '你好 minio')

    // upload from the session workspace
    const uploaded = await tools.get('minio_write').execute({ bucket: 'dsh', key: 'tools/local.txt', fromPath: 'local.txt' }, exec)
    assert.equal(uploaded.source, 'local.txt')

    // list one level
    const listed = await tools.get('minio_list').execute({ bucket: 'dsh', prefix: 'tools/' }, exec)
    assert.deepEqual(listed.objects.map((entry) => entry.key), ['tools/hello.txt', 'tools/local.txt'])

    // pull an object into the workspace and read it there
    const pulled = await tools.get('minio_read').execute({ bucket: 'dsh', key: 'tools/hello.txt', toPath: 'pulled/hello.txt' }, exec)
    assert.equal(pulled.bytes, Buffer.byteLength('你好 minio'))
    assert.equal(fs.readFileSync(path.join(cwd, 'pulled', 'hello.txt'), 'utf8'), '你好 minio')

    // folder marker via key ending in /
    const folder = await tools.get('minio_write').execute({ bucket: 'dsh', key: 'tools/sub/' }, exec)
    assert.equal(folder.source, 'folder-marker')

    // errors are thrown as readable messages, not silent successes
    await assert.rejects(() => tools.get('minio_write').execute({ bucket: 'dsh', key: 'x.txt' }, exec), /content 或 fromPath/)
    await assert.rejects(() => tools.get('minio_read').execute({ bucket: 'dsh', key: 'missing.txt' }, exec), /NoSuchKey/)
    await assert.rejects(() => tools.get('minio_read').execute({ bucket: 'dsh', key: 'x.txt', toPath: '../escape.txt' }, exec), /\.\./)

    // delete
    const removed = await tools.get('minio_delete').execute({ bucket: 'dsh', keys: ['tools/hello.txt', 'tools/local.txt', 'tools/sub/'] }, exec)
    assert.equal(removed.deleted.length, 3)

    // bucket management
    const created = await tools.get('minio_bucket').execute({ action: 'create', bucket: 'made-by-tool' }, exec)
    assert.equal(created.created, true)
    const deleted = await tools.get('minio_bucket').execute({ action: 'delete', bucket: 'made-by-tool' }, exec)
    assert.equal(deleted.deleted, true)
  })
})
