'use strict'

/**
 * s3-core 的離線測試。
 *
 * 最重要的三個案例是 AWS 官方文件裡的 SigV4 測試向量 —— 簽章演算法寫錯時，
 * 本地的一切看起來都正常（canonical request 讀起來完全合理），錯的只有最後
 * 那個 hex。這三個向量釘住 canonical request 的**形狀**（尤其是標頭區塊後面
 * 那個空行），那是這個檔案唯一容易寫錯又難察覺的地方。
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const core = require('../src/core')

const AK = 'AKIAIOSFODNN7EXAMPLE'
const SK = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
const NOW = new Date('2013-05-24T00:00:00.000Z')

test('SigV4：GET object 向量（AWS 文件）', () => {
  const signed = core.signRequest({
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    headers: { Range: 'bytes=0-9' },
    accessKey: AK,
    secretKey: SK,
    region: 'us-east-1',
    now: NOW,
  })
  assert.equal(signed.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
  assert.equal(core.sha256Hex(signed.canonicalRequest), '7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972')
  assert.match(signed.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/)
  assert.equal(signed.headers['x-amz-date'], '20130524T000000Z')
  assert.equal(signed.headers['x-amz-content-sha256'], core.EMPTY_SHA256)
})

test('SigV4：PUT object 向量（body hash 進 canonical request）', () => {
  const signed = core.signRequest({
    method: 'PUT',
    url: 'https://examplebucket.s3.amazonaws.com/test%24file.text',
    headers: { 'x-amz-storage-class': 'REDUCED_REDUNDANCY', Date: 'Fri, 24 May 2013 00:00:00 GMT' },
    body: 'Welcome to Amazon S3.',
    accessKey: AK,
    secretKey: SK,
    region: 'us-east-1',
    now: NOW,
  })
  assert.equal(signed.signature, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd')
  assert.notEqual(signed.payloadHash, core.EMPTY_SHA256)
})

test('SigV4：presign 向量（UNSIGNED-PAYLOAD）', () => {
  const url = core.presignUrl({
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    method: 'GET',
    accessKey: AK,
    secretKey: SK,
    region: 'us-east-1',
    expires: 86400,
    now: NOW,
  })
  assert.equal(
    url,
    'https://examplebucket.s3.amazonaws.com/test.txt'
    + '?X-Amz-Algorithm=AWS4-HMAC-SHA256'
    + '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request'
    + '&X-Amz-Date=20130524T000000Z'
    + '&X-Amz-Expires=86400'
    + '&X-Amz-SignedHeaders=host'
    + '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
  )
})

test('canonical query：依編碼後的 key 排序，值也要編碼', () => {
  const query = core.canonicalQuery([
    ['list-type', '2'],
    ['prefix', 'a b/c'],
    ['delimiter', '/'],
    ['encoding-type', 'url'],
  ])
  assert.equal(query, 'delimiter=%2F&encoding-type=url&list-type=2&prefix=a%20b%2Fc')
})

test('uriEncode 補編碼 !\'()* 並保留 ~', () => {
  assert.equal(core.uriEncode("a!b'c(d)e*f~g"), 'a%21b%27c%28d%29e%2Af~g')
  assert.equal(core.uriEncodePath('logs/2026/中文.txt'), 'logs/2026/%E4%B8%AD%E6%96%87.txt')
})

test('ListBuckets 解析', () => {
  const xml = '<?xml version="1.0"?><ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
    + '<Buckets><Bucket><Name>dsh</Name><CreationDate>2026-10-16T12:17:00.421Z</CreationDate></Bucket>'
    + '<Bucket><Name>nas</Name><CreationDate>2024-12-04T07:44:44.592Z</CreationDate></Bucket></Buckets>'
    + '</ListAllMyBucketsResult>'
  assert.deepEqual(core.parseListBuckets(xml), [
    { name: 'dsh', creationDate: '2026-10-16T12:17:00.421Z' },
    { name: 'nas', creationDate: '2024-12-04T07:44:44.592Z' },
  ])
})

test('ListObjectsV2 解析：解 MinIO 的 url 編碼（空白是 +，+ 是 %2B）', () => {
  // 這是實測 MinIO 會回的形狀：key「a+b c 中文.txt」→「a%2Bb+c+%E4%B8%AD%E6%96%87.txt」。
  const xml = '<?xml version="1.0"?><ListBucketResult>'
    + '<Name>dsh</Name><Prefix>logs/</Prefix><Delimiter>%2F</Delimiter><KeyCount>2</KeyCount>'
    + '<MaxKeys>1000</MaxKeys><IsTruncated>true</IsTruncated>'
    + '<NextContinuationToken>1ueGcxLPRx1Tr%2F4%3D</NextContinuationToken>'
    + '<Contents><Key>logs%2Fa%2Bb+c+%E4%B8%AD%E6%96%87.txt</Key><LastModified>2026-10-16T12:22:22.000Z</LastModified>'
    + '<ETag>&quot;e69efd75e6b509644b98ce639e55462a&quot;</ETag><Size>22</Size><StorageClass>STANDARD</StorageClass></Contents>'
    + '<Contents><Key>logs%2Fempty%2F</Key><Size>0</Size></Contents>'
    + '<CommonPrefixes><Prefix>logs%2Fempty%2F</Prefix></CommonPrefixes>'
    + '</ListBucketResult>'
  const parsed = core.parseListObjectsV2(xml)
  assert.equal(parsed.prefix, 'logs/')
  assert.equal(parsed.delimiter, '/')
  assert.equal(parsed.isTruncated, true)
  assert.equal(parsed.nextContinuationToken, '1ueGcxLPRx1Tr/4=')
  assert.equal(parsed.keyCount, 2)
  assert.deepEqual(parsed.contents.map((entry) => entry.key), ['logs/a+b c 中文.txt', 'logs/empty/'])
  assert.equal(parsed.contents[0].etag, 'e69efd75e6b509644b98ce639e55462a')
  assert.equal(parsed.contents[0].size, 22)
  assert.deepEqual(parsed.commonPrefixes, ['logs/empty/'])
})

test('DeleteResult 解析', () => {
  const xml = '<DeleteResult><Deleted><Key>a.txt</Key></Deleted>'
    + '<Error><Key>b.txt</Key><Code>AccessDenied</Code><Message>denied</Message></Error></DeleteResult>'
  const parsed = core.parseDeleteResult(xml)
  assert.deepEqual(parsed.deleted, ['a.txt'])
  assert.deepEqual(parsed.errors, [{ key: 'b.txt', code: 'AccessDenied', message: 'denied' }])
})

test('parseS3Error 取 Code/Message/Region', () => {
  const xml = '<?xml version="1.0"?><Error><Code>AuthorizationHeaderMalformed</Code>'
    + '<Message>The authorization header is malformed.</Message><Region>us-west-rack-2</Region>'
    + '<RequestId>ABC</RequestId></Error>'
  const info = core.parseS3Error(xml, 400)
  assert.equal(info.code, 'AuthorizationHeaderMalformed')
  assert.equal(info.region, 'us-west-rack-2')
  assert.equal(info.requestId, 'ABC')
  assert.equal(info.status, 400)
})

test('XML 實體解碼（含數字實體）', () => {
  assert.equal(core.xmlText('<a><Key>a&amp;b&lt;c&gt;&#39;&#x4E2D;</Key></a>', 'Key'), "a&b<c>'中")
})

test('checkTarget 擋掉會改變路徑結構的 bucket/key', () => {
  assert.equal(core.checkTarget('dsh', 'a/b.txt').ok, true)
  assert.equal(core.checkTarget('dsh', 'a+b c 中文.txt').ok, true)
  assert.deepEqual(core.checkTarget('', 'a'), { ok: false, error: 'bucket 不可為空' })
  assert.equal(core.checkTarget('..', 'a').ok, false)
  assert.equal(core.checkTarget('dsh', '/etc/passwd').ok, false)
  assert.equal(core.checkTarget('dsh', 'a/../../b').ok, false)
  assert.equal(core.checkTarget('dsh', 'a//b').ok, false)
  assert.equal(core.checkTarget('dsh', 'a\\b').ok, false)
  assert.equal(core.checkTarget('dsh', 'a\u0000b').ok, false)
  assert.equal(core.checkTarget('dsh', 'a'.repeat(1025)).ok, false)
  assert.equal(core.checkTarget('dsh', '', { allowEmptyKey: true }).ok, true)
})

test('key 路徑工具', () => {
  assert.equal(core.normalizePrefix('/logs/2026'), 'logs/2026/')
  assert.equal(core.normalizePrefix('logs'), 'logs/')
  assert.equal(core.normalizePrefix(''), '')
  assert.equal(core.normalizePrefix('\\logs\\a'), 'logs/a/')
  assert.equal(core.joinKey('logs/', 'a.txt'), 'logs/a.txt')
  assert.equal(core.baseName('logs/2026/a.txt'), 'a.txt')
  assert.equal(core.baseName('logs/empty/'), 'empty')
  assert.equal(core.parentPrefix('logs/2026/a.txt'), 'logs/2026/')
  assert.equal(core.parentPrefix('a.txt'), '')
  assert.equal(core.isFolderKey('a/'), true)
  assert.equal(core.isFolderKey('a'), false)
})

test('amzStamp：去掉毫秒與標點', () => {
  const stamp = core.amzStamp(new Date('2026-10-16T20:15:22.123Z'))
  assert.deepEqual(stamp, { stamp: '20261016T201522Z', date: '20261016' })
})
