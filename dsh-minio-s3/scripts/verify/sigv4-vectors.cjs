'use strict'
const PLUGIN = require('node:path').join(__dirname, '..', '..')
// Verify our SigV4 against AWS's published test vectors, then against MinIO.
const core = require(require('node:path').join(PLUGIN, 'src/core.js'))

const AK = 'AKIAIOSFODNN7EXAMPLE'
const SK = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
const NOW = new Date('2013-05-24T00:00:00.000Z')

function show(name, got, want) {
  console.log((got === want ? 'PASS ' : 'FAIL ') + name)
  if (got !== want) {
    console.log('  got :', got)
    console.log('  want:', want)
  }
}

// 1) GET object with Range
const get = core.signRequest({
  method: 'GET',
  url: 'https://examplebucket.s3.amazonaws.com/test.txt',
  headers: { Range: 'bytes=0-9' },
  accessKey: AK,
  secretKey: SK,
  region: 'us-east-1',
  now: NOW,
})
show('GET object signature', get.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
console.log('--- canonical request ---')
console.log(JSON.stringify(get.canonicalRequest))

// 2) PUT object with storage class
const put = core.signRequest({
  method: 'PUT',
  url: 'https://examplebucket.s3.amazonaws.com/test%24file.text',
  headers: { 'x-amz-storage-class': 'REDUCED_REDUNDANCY', Date: 'Fri, 24 May 2013 00:00:00 GMT' },
  body: 'Welcome to Amazon S3.',
  accessKey: AK,
  secretKey: SK,
  region: 'us-east-1',
  now: NOW,
})
show('PUT object signature', put.signature, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd')

// 3) presign
const pre = core.presignUrl({
  url: 'https://examplebucket.s3.amazonaws.com/test.txt',
  method: 'GET',
  accessKey: AK,
  secretKey: SK,
  region: 'us-east-1',
  expires: 86400,
  now: NOW,
})
const sig = /X-Amz-Signature=([0-9a-f]+)/.exec(pre)
show('presign signature', sig ? sig[1] : '(none)', 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404')
console.log('presign url:', pre)
