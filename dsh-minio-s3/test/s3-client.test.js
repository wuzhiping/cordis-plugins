'use strict'

/**
 * s3-client 的行為測試：region 的探測／學習／重試、payload 上限、錯誤形狀。
 *
 * 這一組的每一個案例都對應一次**真實踩到的失敗**，不是假想的邊界：
 *
 *  - MinIO 對一般簽章請求寬容（region 填 us-east-1 也收），但 presign 與
 *    `POST ?delete` 嚴格驗 region；
 *  - `POST ?delete` 的 region 錯誤是 **HTTP 200 + 逐 key `<Error>`**，
 *    不是頂層 4xx，所以頂層重試看不到它；
 *  - 學到的 region 若只留在單一 client 上，下一個請求就忘了。
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const core = require('../src/core')
const { S3Client, S3Error, isS3Error } = require('../src/s3')

const REGION_ERROR = '<?xml version="1.0"?><Error><Code>AuthorizationHeaderMalformed</Code>'
  + '<Message>The authorization header is malformed; the region is wrong; expecting \'us-west-rack-2\'.</Message>'
  + '<Region>us-west-rack-2</Region></Error>'

function client(fetchImpl, options) {
  return new S3Client({
    endpoint: 'http://minio.test:7000',
    accessKey: 'uid',
    secretKey: 'pwd',
    fetchImpl,
    ...(options || {}),
  })
}

test('regionHintInText 抓出伺服器期待的 region', () => {
  assert.equal(core.regionHintInText("… expecting 'us-west-rack-2'."), 'us-west-rack-2')
  assert.equal(core.regionHintInText('no hint here'), '')
})

test('probeRegion：未簽章請求的 403 裡帶 <Region> 就學起來', async () => {
  const seen = []
  const s3 = client(async (url, init) => {
    seen.push({ url, method: init.method, auth: init.headers })
    assert.equal(init.headers, undefined, '探測必須是未簽章請求')
    return new Response(REGION_ERROR, { status: 403 })
  })
  assert.equal(await s3.probeRegion(), 'us-west-rack-2')
  assert.equal(s3.region, 'us-east-1', 'probeRegion 只回報，不自己改狀態')
  assert.equal(seen[0].url, 'http://minio.test:7000/')
})

test('probeRegion：2xx 或沒有 Region 提示時回 null（AWS S3 的情形）', async () => {
  assert.equal(await client(async () => new Response('<ok/>', { status: 200 })).probeRegion(), null)
  assert.equal(
    await client(async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })).probeRegion(),
    null,
  )
  assert.equal(await client(async () => { throw new Error('ECONNREFUSED') }).probeRegion(), null)
})

test('setRegion 通知觀察者；同值不通知', () => {
  const seen = []
  const s3 = client(async () => new Response(''), { onRegion: (region) => seen.push(region) })
  assert.equal(s3.setRegion('us-west-rack-2'), true)
  assert.equal(s3.setRegion('us-west-rack-2'), false)
  assert.equal(s3.setRegion(''), false)
  assert.deepEqual(seen, ['us-west-rack-2'])
  assert.equal(s3.region, 'us-west-rack-2')
})

test('send：頂層 region 錯誤時學起來並重試一次', async () => {
  const seen = []
  const s3 = client(async (url, init) => {
    seen.push(init.headers.Authorization)
    if (seen.length === 1) return new Response(REGION_ERROR, { status: 400 })
    return new Response('<ok/>', { status: 200 })
  })
  const response = await s3.send({ method: 'GET', url: s3.objectUrl('', ''), operation: 'ListBuckets' })
  assert.equal(response.status, 200)
  assert.equal(seen.length, 2)
  assert.match(seen[0], /\/us-east-1\/s3\/aws4_request/)
  assert.match(seen[1], /\/us-west-rack-2\/s3\/aws4_request/)
  assert.equal(s3.region, 'us-west-rack-2')
})

test('deleteObjects：region 錯誤藏在 200 的逐 key <Error> 裡也要重試', async () => {
  let attempts = 0
  const s3 = client(async (url, init) => {
    attempts += 1
    assert.ok(init.headers['Content-MD5'], 'POST ?delete 必須帶 Content-MD5')
    assert.match(String(url), /\?delete=$/)
    if (attempts === 1) {
      return new Response('<DeleteResult>'
        + '<Error><Key>a.txt</Key><Code>AuthorizationHeaderMalformed</Code>'
        + '<Message>The authorization header is malformed; the region is wrong; expecting \'us-west-rack-2\'.</Message></Error>'
        + '</DeleteResult>', { status: 200 })
    }
    return new Response('<DeleteResult><Deleted><Key>a.txt</Key></Deleted></DeleteResult>', { status: 200 })
  })

  const result = await s3.deleteObjects('dsh', ['a.txt'])
  assert.equal(attempts, 2)
  assert.deepEqual(result.deleted, ['a.txt'])
  assert.deepEqual(result.errors, [])
  assert.equal(s3.region, 'us-west-rack-2')
})

test('deleteObjects：key 用原字串 XML 轉義（不是 URL 編碼）', async () => {
  let sent = ''
  const s3 = client(async (url, init) => {
    sent = init.body.toString('utf8')
    return new Response('<DeleteResult><Deleted><Key>a b&amp;c.txt</Key></Deleted></DeleteResult>', { status: 200 })
  })
  await s3.deleteObjects('dsh', ['a b&c.txt', 'quote"file.txt'])
  assert.match(sent, /<Key>a b&amp;c\.txt<\/Key>/)
  assert.match(sent, /<Key>quote&quot;file\.txt<\/Key>/)
})

test('deleteObjects：沒有 region 提示時不重試；空清單直接回空', async () => {
  let attempts = 0
  const s3 = client(async () => {
    attempts += 1
    return new Response('<DeleteResult><Error><Key>a</Key><Code>AccessDenied</Code><Message>nope</Message></Error></DeleteResult>', { status: 200 })
  })
  const result = await s3.deleteObjects('dsh', ['a'])
  assert.equal(attempts, 1)
  assert.equal(result.errors.length, 1)
  assert.deepEqual(await s3.deleteObjects('dsh', []), { deleted: [], errors: [] })
})

test('presignObject 用目前的 region（學到之後才對）', () => {
  const s3 = client(async () => new Response(''))
  assert.match(s3.presignObject({ bucket: 'dsh', key: 'a.txt' }), /us-east-1%2Fs3%2Faws4_request/)
  s3.setRegion('us-west-rack-2')
  assert.match(s3.presignObject({ bucket: 'dsh', key: 'a.txt' }), /us-west-rack-2%2Fs3%2Faws4_request/)
})

test('objectUrl / withQuery：path-style，key 的 / 保留、中文與 + 都編碼', () => {
  const s3 = client(async () => new Response(''))
  assert.equal(s3.objectUrl('', ''), 'http://minio.test:7000/')
  assert.equal(s3.objectUrl('dsh', ''), 'http://minio.test:7000/dsh')
  assert.equal(
    s3.objectUrl('dsh', 'logs/2026/a+b c 中文.txt'),
    'http://minio.test:7000/dsh/logs/2026/a%2Bb%20c%20%E4%B8%AD%E6%96%87.txt',
  )
  assert.equal(
    s3.withQuery(s3.objectUrl('dsh', ''), [['delete', ''], ['prefix', 'a/b']]),
    'http://minio.test:7000/dsh?delete=&prefix=a%2Fb',
  )
})

test('send：時間預算只管到「收到標頭」，慢速 body 不會被切斷', async () => {
  const s3 = client(async () => {
    // 標頭立刻回來，body 慢慢滴 —— 總時長遠超過 50ms 的預算。
    const stream = new ReadableStream({
      start(controller) {
        let sent = 0
        const tick = () => {
          if (sent < 5) {
            sent += 1
            controller.enqueue(new Uint8Array([sent]))
            setTimeout(tick, 30)
          } else {
            controller.close()
          }
        }
        setTimeout(tick, 30)
      },
    })
    return new Response(stream, { status: 200 })
  }, { timeoutMs: 50 })

  const response = await s3.send({ method: 'GET', url: s3.objectUrl('dsh', 'slow.bin'), operation: 'GetObject' })
  const body = Buffer.from(await response.arrayBuffer())
  assert.equal(body.length, 5, '整個 body 都應該收完（舊寫法會在 50ms 時 abort 串流）')
})

test('send：連標頭都等不到時才算逾時，而且是可辨識的 RequestTimeout', async () => {
  // 假 fetch 必須尊重 signal，否則 abort 永遠不會讓它 reject（真實 fetch 會）。
  const s3 = client((url, init) => new Promise((resolve, reject) => {
    if (init.signal.aborted) { reject(new Error('aborted')); return }
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  }), { timeoutMs: 40 })
  await assert.rejects(() => s3.listBuckets(), (error) => {
    assert.equal(error.code, 'RequestTimeout')
    assert.match(error.message, /逾時/)
    return true
  })
})

test('putObject：大 body 不套用「等標頭」預算（上傳階段無法與連線階段分開）', async () => {
  const big = Buffer.alloc(9 * 1024 * 1024, 7) // 9MB > LARGE_BODY_BYTES
  // 假 fetch 花 60ms 才回標頭，且尊重 abort（真實 fetch 就是這樣）。
  const slowFetch = (url, init) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response('', { status: 200, headers: { etag: '"x"' } })), 60)
    const onAbort = () => { clearTimeout(timer); reject(new Error('aborted')) }
    if (init.signal.aborted) { onAbort(); return }
    init.signal.addEventListener('abort', onAbort, { once: true })
  })

  const s3 = client(slowFetch, { timeoutMs: 20 }) // 客戶端預設 20ms
  const put = await s3.putObject({ bucket: 'dsh', key: 'big.bin', body: big })
  assert.equal(put.size, big.length, '大 body 應該覆寫成「不計時」而成功')

  await assert.rejects(
    () => s3.putObject({ bucket: 'dsh', key: 'small.bin', body: Buffer.from('tiny') }),
    (error) => error.code === 'RequestTimeout',
    '小 body 仍套預設預算',
  )
})

test('getObject：超過 maxBytes 直接擋（不把宿主記憶體吃掉）', async () => {
  const s3 = client(async () => new Response(Buffer.alloc(64, 1), { status: 200, headers: { 'content-length': '64' } }))
  await assert.rejects(() => s3.getObject({ bucket: 'dsh', key: 'big.bin', maxBytes: 8 }), (error) => {
    assert.equal(error.code, 'ObjectTooLarge')
    return true
  })
  const small = await s3.getObject({ bucket: 'dsh', key: 'big.bin', maxBytes: 128 })
  assert.equal(small.body.length, 64)
})

test('S3Error：訊息帶上 S3 的 Code，欄位可供上層判斷', async () => {
  const s3 = client(async () => new Response(
    '<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message><RequestId>R1</RequestId></Error>',
    { status: 404 },
  ))
  await assert.rejects(() => s3.getObject({ bucket: 'dsh', key: 'nope.txt' }), (error) => {
    assert.equal(isS3Error(error), true)
    assert.equal(error.code, 'NoSuchKey')
    assert.equal(error.status, 404)
    assert.equal(error.requestId, 'R1')
    assert.match(error.message, /^\[GetObject\] NoSuchKey: /)
    return true
  })
})

test('send：網路層失敗包成 NetworkError（不是讓 fetch 的例外裸奔）', async () => {
  const s3 = client(async () => { throw new Error('ECONNREFUSED') })
  await assert.rejects(() => s3.listBuckets(), (error) => {
    assert.equal(error instanceof S3Error, true)
    assert.equal(error.code, 'NetworkError')
    return true
  })
})

test('endpoint 必須是 http(s) URL', () => {
  assert.throws(() => client(async () => new Response(''), { endpoint: undefined }), /endpoint/)
  assert.throws(() => new S3Client({ endpoint: '10.17.26.8:7000', fetchImpl: async () => new Response('') }), /endpoint/)
})
