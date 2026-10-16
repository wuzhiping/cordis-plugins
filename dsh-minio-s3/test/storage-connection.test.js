'use strict'

/**
 * connection 的離線測試：遮蔽公式、憑證檔解析、BDD storage 回應的容錯、
 * 快取行為。全部用假的 fetch / 假的憑證檔，不打網路。
 *
 * 「欄位名容錯」那幾個案例不是想像出來的：同一個 storage 記錄在 2026-10-16
 * 兩次查詢之間從 `S3_UID/S3_PWD/S3_BUCK`（空）變成 `UID/PWD/BUCKET`（"dsh"），
 * 所以兩種形狀都要能解析，且要留下「收到哪些欄位」的線索。
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const connection = require('../src/storage')

const CREDENTIALS = [
  'version: 1',
  'refs:',
  '  AIFE_API_KEY: sk-ExampleKeyReplaceMe001',
  '  FEG_API_KEY: "sk-QuotedValue0000000001"',
  'records:',
  '  something:',
  '    kind: grant',
  '',
].join('\n')

const readFile = () => CREDENTIALS

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status: status || 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('maskKey：71 字元，sk- + base64(key + @ISO)', () => {
  const masked = connection.maskKey('sk-ExampleKeyReplaceMe001', new Date('2026-01-01T00:00:00.000Z'))
  assert.equal(masked.length, 71)
  assert.ok(masked.startsWith('sk-'))
  const inner = Buffer.from(masked.slice(3), 'base64').toString('utf8')
  assert.equal(inner, 'sk-ExampleKeyReplaceMe001@2026-01-01T00:00:00.000Z')
})

test('readCredentialRef：只讀 refs 區塊、去引號', () => {
  assert.equal(connection.readCredentialRef(CREDENTIALS, 'AIFE_API_KEY'), 'sk-ExampleKeyReplaceMe001')
  assert.equal(connection.readCredentialRef(CREDENTIALS, 'FEG_API_KEY'), 'sk-QuotedValue0000000001')
  assert.equal(connection.readCredentialRef(CREDENTIALS, 'MISSING'), null)
  // records 區塊裡的鍵不可以被當成 refs 讀出來
  assert.equal(connection.readCredentialRef(CREDENTIALS, 'kind'), null)
})

test('readMaskedCredential：依序 fallback 並回報用了哪個 ref', () => {
  const result = connection.readMaskedCredential({
    env: {},
    now: new Date('2026-01-01T00:00:00.000Z'),
    readFile: () => CREDENTIALS,
    refs: ['NOPE', 'FEG_API_KEY'],
  })
  assert.equal(result.ok, true)
  assert.equal(result.ref, 'FEG_API_KEY')
  assert.equal(Buffer.from(result.masked.slice(3), 'base64').toString('utf8').startsWith('sk-QuotedValue'), true)

  const missing = connection.readMaskedCredential({ env: {}, readFile: () => CREDENTIALS, refs: ['NOPE'] })
  assert.equal(missing.ok, false)
  assert.equal(missing.stage, 'credential')

  const unreadable = connection.readMaskedCredential({
    env: {},
    refs: ['AIFE_API_KEY'],
    readFile: () => { throw new Error('ENOENT') },
  })
  assert.equal(unreadable.ok, false)
  assert.equal(unreadable.stage, 'credential')
  assert.match(unreadable.error, /憑證檔/)
})

test('extractStoredConnection：吃 S3_* 與無前綴兩種欄位名', () => {
  const long = connection.extractStoredConnection({
    S3_URL: 'http://10.17.26.8:7000', S3_UID: 'admin', S3_PWD: '12345678', S3_BUCK: '',
  })
  assert.deepEqual(long, {
    ok: true, endpoint: 'http://10.17.26.8:7000', accessKey: 'admin', secretKey: '12345678', defaultBucket: '',
  })

  const short = connection.extractStoredConnection({
    S3_URL: 'http://10.17.26.8:7000', UID: 'admin', PWD: '12345678', BUCKET: 'dsh',
  })
  assert.equal(short.ok, true)
  assert.equal(short.defaultBucket, 'dsh')

  // 沒有 scheme 的端點要補 http://
  assert.equal(
    connection.extractStoredConnection({ S3_URL: '10.17.26.8:7000', UID: 'a', PWD: 'b' }).endpoint,
    'http://10.17.26.8:7000',
  )

  const empty = connection.extractStoredConnection({})
  assert.equal(empty.ok, false)
  assert.equal(empty.empty, true)
  assert.match(empty.error, /沒有欄位/)

  const partial = connection.extractStoredConnection({ S3_URL: 'http://x', FOO: 1 })
  assert.match(partial.error, /S3_URL、FOO/)
})

test('requireStorageUrl：拒收非 abc.feg.com.tw 或非 https', () => {
  assert.equal(connection.requireStorageUrl(connection.DEFAULT_STORAGE_URL), connection.DEFAULT_STORAGE_URL)
  assert.throws(() => connection.requireStorageUrl('https://evil.example/BDD/API/AI/dsh/storage/s3'), /拒絕/)
  assert.throws(() => connection.requireStorageUrl('http://abc.feg.com.tw/x'), /https/)
  assert.throws(() => connection.requireStorageUrl('not-a-url'), /不是 URL/)
})

test('fetchStoredConnection：成功、500、非 JSON、缺欄位', async () => {
  const makeFetch = (responder) => async (url, init) => {
    assert.equal(url, connection.DEFAULT_STORAGE_URL)
    const body = JSON.parse(init.body)
    assert.match(body.apiKey, /^sk-[A-Za-z0-9+/=]+$/)
    return responder(body)
  }

  const ok = await connection.fetchStoredConnection({
    env: {}, readFile, refs: ['AIFE_API_KEY'],
    fetchImpl: makeFetch(() => jsonResponse({ S3_URL: 'http://minio:9000', UID: 'u', PWD: 'p', BUCKET: 'b' })),
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.endpoint, 'http://minio:9000')
  assert.equal(ok.ref, 'AIFE_API_KEY')

  const server = await connection.fetchStoredConnection({
    env: {}, readFile, fetchImpl: makeFetch(() => jsonResponse({ error: 'apikey invalid' }, 500)),
  })
  assert.equal(server.ok, false)
  assert.equal(server.stage, 'request')
  assert.equal(server.status, 500)

  const notJson = await connection.fetchStoredConnection({
    env: {}, readFile, fetchImpl: makeFetch(() => new Response('<html>', { status: 200 })),
  })
  assert.equal(notJson.stage, 'response')

  const emptyBody = await connection.fetchStoredConnection({
    env: {}, readFile, fetchImpl: makeFetch(() => jsonResponse({})),
  })
  assert.equal(emptyBody.ok, false)
  assert.equal(emptyBody.empty, true)

  const network = await connection.fetchStoredConnection({
    env: {}, readFile, fetchImpl: async () => { throw new Error('ECONNREFUSED') },
  })
  assert.equal(network.stage, 'request')
  assert.equal(network.status, 0)
})

test('fetchStoredConnection：storage URL 指到別的主機時直接擋掉（mask 不外流）', async () => {
  let called = false
  const result = await connection.fetchStoredConnection({
    env: {}, readFile,
    storageUrl: 'https://example.com/BDD/API/AI/dsh/storage/s3',
    fetchImpl: async () => { called = true; return jsonResponse({}) },
  })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'config')
  assert.equal(called, false, '不得對非 abc.feg.com.tw 發出任何請求')
})

test('ConnectionProvider：快取命中只查一次，force 會重查，失敗不快取', async () => {
  let storageCalls = 0
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url))
    if (parsed.hostname === 'abc.feg.com.tw') {
      storageCalls += 1
      return jsonResponse({ S3_URL: 'http://minio.test:7000', UID: 'u', PWD: 'p', BUCKET: 'dsh' })
    }
    // region 探測：這個假端點不吐 <Region>，所以會退回預設 region。
    return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })
  }

  const provider = new connection.ConnectionProvider({ env: {}, readFile, fetchImpl, ttlMs: 60000 })
  const first = await provider.get()
  const second = await provider.get()
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(storageCalls, 1, '第二次應該命中快取')

  await provider.get({ force: true })
  assert.equal(storageCalls, 2)

  provider.invalidate()
  assert.equal(provider.peek(), null)
  await provider.get()
  assert.equal(storageCalls, 3)

  // 失敗不進快取：下一次仍會重試
  let attempts = 0
  const failing = new connection.ConnectionProvider({
    env: {}, readFile, ttlMs: 60000,
    fetchImpl: async () => { attempts += 1; throw new Error('down') },
  })
  assert.equal((await failing.get()).ok, false)
  assert.equal((await failing.get()).ok, false)
  assert.equal(attempts, 2)
})

test('ConnectionProvider：region 只探測一次，學到之後跨 get() 保留', async () => {
  const json = (payload) => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  let probes = 0
  let s3Calls = 0
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url))
    if (parsed.hostname === 'abc.feg.com.tw') {
      return json({ S3_URL: 'http://minio.test:7000', UID: 'u', PWD: 'p', BUCKET: 'dsh' })
    }
    assert.equal(parsed.hostname, 'minio.test')
    // 探測與 ListBuckets 打的是同一個路徑，差別只在有沒有簽章標頭。
    if (init.headers === undefined) {
      probes += 1
      return new Response("<Error><Code>AccessDenied</Code><Message>Access Denied.</Message><Region>us-west-rack-2</Region></Error>", { status: 403 })
    }
    s3Calls += 1
    return new Response('<ListAllMyBucketsResult><Buckets/></ListAllMyBucketsResult>', { status: 200 })
  }

  const provider = new connection.ConnectionProvider({ env: {}, readFile, fetchImpl, ttlMs: 60000 })
  const first = await provider.get()
  const second = await provider.get()
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(probes, 1, '第二次不該再探測')
  assert.equal(first.client.region, 'us-west-rack-2')
  assert.equal(second.client.region, 'us-west-rack-2', '新 client 要沿用學到的 region')
  assert.equal(provider.region, 'us-west-rack-2')

  // 這個 region 會被真正用在簽章上
  await second.client.listBuckets()
  assert.equal(s3Calls, 1)
})

test('extractStoredConnection：擋掉 metadata 位址與非 http(s) 端點（SSRF 邊界）', () => {
  const base = { UID: 'u', PWD: 'p' }
  // 雲端 metadata：宿主會對端點發簽章請求，這裡不能變成可任意指定目的地
  assert.equal(connection.extractStoredConnection({ ...base, S3_URL: 'http://169.254.169.254/' }).ok, false)
  assert.equal(connection.extractStoredConnection({ ...base, S3_URL: '169.254.1.2:9000' }).ok, false)
  assert.equal(connection.extractStoredConnection({ ...base, S3_URL: 'http://metadata.google.internal/' }).ok, false)
  assert.equal(connection.extractStoredConnection({ ...base, S3_URL: 'ftp://minio.test/' }).ok, false)
  // 一般內網位址照收
  assert.equal(connection.extractStoredConnection({ ...base, S3_URL: 'http://10.17.26.8:7000' }).ok, true)

  // 明示白名單時只放行名單內的主機
  const restricted = { allowedHosts: ['minio.internal'] }
  assert.equal(connection.extractStoredConnection({ ...base, S3_URL: 'http://10.17.26.8:7000' }, restricted).ok, false)
  assert.equal(connection.extractStoredConnection({ ...base, S3_URL: 'http://minio.internal:7000' }, restricted).ok, true)
})

test('credentialsFilePath：DSH_CREDENTIALS_PATH 優先', () => {
  assert.equal(connection.credentialsFilePath({ DSH_CREDENTIALS_PATH: 'C:/tmp/c.yaml' }), 'C:/tmp/c.yaml')
  assert.match(connection.credentialsFilePath({ DSH_HOME: 'C:/dsh' }), /\.credentials\.yaml$/)
})
