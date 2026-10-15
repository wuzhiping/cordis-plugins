'use strict';

// =============================================================================
// kaneo-web 遮蔽金钥与凭证解析测试
//
//     node test/secrets.js
//
// 这一份钉住的是一条**安全界线**：远端储存端点要用遮蔽过的金钥去换资料，
// 而原文住在宿主的凭证档里；回给浏览器的东西里面**不得出现原文**。
//
// 另外它把遮蔽公式钉死：ntfy-teams 与本外挂各自维护一份实作（外挂之间不
// 互相 require），所以任何一边漂移都必须在这里变红。
//
//     ts     = "@" + ISO
//     masked = "sk-" + base64(key + ts)
// =============================================================================

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const secrets = require('../lib/secrets.js');

let passed = 0;
/** 跑一个测试并印出结果。 */
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (err) {
    console.error('  FAIL ' + name);
    console.error('       ' + (err && err.message ? err.message : String(err)));
    process.exitCode = 1;
  }
}

/** 造一个临时凭证档。 */
function tempCredentials(text) {
  const file = path.join(os.tmpdir(), 'kaneo-web-credentials-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.yaml');
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

const SAMPLE = [
  'version: 1',
  'refs:',
  '  DEEPSEEK_API_KEY: sk-deep',
  '  AIFE_API_KEY: "sk-aife-000"',
  '  FEG_API_KEY:',
  'records:',
  '  client-connection/browser-session:',
  '    kind: grant',
  '    payload:',
  '      secret: nope',
  ''
].join('\n');

/* ------------------------------------------------------------- 遮蔽公式 */

check('maskKey follows the MASK.md formula', function () {
  const now = new Date('2026-10-15T07:39:06.000Z');
  const expected = 'sk-' + Buffer.from('sk-aife-000@2026-10-15T07:39:06.000Z', 'utf8').toString('base64');
  assert.equal(secrets.maskKey('sk-aife-000', now), expected);
});

check('maskKey matches the ntfy-teams implementation byte for byte', function () {
  // ntfy-teams 的实作在 cordis-plugins/ntfy-teams/lib/index.js（__test.maskKey）。
  const sibling = path.join(__dirname, '..', '..', 'ntfy-teams', 'lib', 'index.js');
  if (!fs.existsSync(sibling)) {
    console.log('       (skipped: ntfy-teams not beside this package)');
    return;
  }
  // eslint-disable-next-line global-require
  const ntfy = require(sibling);
  const now = new Date('2026-01-02T03:04:05.678Z');
  assert.equal(secrets.maskKey('sk-abc', now), ntfy.__test.maskKey('sk-abc', now));
});

check('maskKey refuses an empty key', function () {
  assert.throws(function () { secrets.maskKey(''); }, TypeError);
  assert.throws(function () { secrets.maskKey(null); }, TypeError);
});

check('the masked value never contains the raw key', function () {
  const key = 'sk-super-secret-value';
  const masked = secrets.maskKey(key, new Date('2026-10-15T00:00:00.000Z'));
  assert.equal(masked.includes(key), false);
  assert.ok(masked.startsWith('sk-'));
  // 遮蔽不是加密：它是可逆的，所以这里只断言「不是原文直出」。
  assert.equal(Buffer.from(masked.slice(3), 'base64').toString('utf8').startsWith(key), true);
});

/* ----------------------------------------------------------- 凭证档解析 */

check('readCredentialRef reads a plain value', function () {
  assert.equal(secrets.readCredentialRef(SAMPLE, 'DEEPSEEK_API_KEY'), 'sk-deep');
});

check('readCredentialRef strips quotes', function () {
  assert.equal(secrets.readCredentialRef(SAMPLE, 'AIFE_API_KEY'), 'sk-aife-000');
});

check('readCredentialRef returns null for an empty or missing name', function () {
  assert.equal(secrets.readCredentialRef(SAMPLE, 'FEG_API_KEY'), null);
  assert.equal(secrets.readCredentialRef(SAMPLE, 'NOPE_KEY'), null);
  assert.equal(secrets.readCredentialRef(SAMPLE, ''), null);
});

check('readCredentialRef does not read outside refs:', function () {
  // `secret: nope` 在 records 里，不是 refs 里的参照。
  assert.equal(secrets.readCredentialRef(SAMPLE, 'secret'), null);
});

check('keyFromCredentialsFile picks the first existing candidate', function () {
  const file = tempCredentials(SAMPLE);
  const result = secrets.keyFromCredentialsFile({ file: file, refs: ['FEG_API_KEY', 'AIFE_API_KEY'] });
  assert.equal(result.ok, true);
  assert.equal(result.ref, 'AIFE_API_KEY');
  assert.equal(result.key, 'sk-aife-000');
  fs.unlinkSync(file);
});

check('keyFromCredentialsFile names every tried reference on failure', function () {
  const file = tempCredentials('version: 1\nrefs:\n  OTHER: x\n');
  const result = secrets.keyFromCredentialsFile({ file: file, refs: ['AIFE_API_KEY', 'FEG_API_KEY'] });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('AIFE_API_KEY'), result.error);
  assert.ok(result.error.includes('FEG_API_KEY'), result.error);
  fs.unlinkSync(file);
});

check('keyFromCredentialsFile reports a missing file instead of throwing', function () {
  const result = secrets.keyFromCredentialsFile({ file: path.join(os.tmpdir(), 'kaneo-web-nope.yaml') });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('讀不到憑證檔'), result.error);
});

/* --------------------------------------------------- 遮蔽结果（不吐原文） */

(async function () {
  // 遮蔽结果的检查（async：可能走 credentials 服务）。
  const fileForMask = tempCredentials(SAMPLE);
  const masked = await secrets.maskedCredential(null, { file: fileForMask, refs: ['AIFE_API_KEY'], now: new Date(0) });
  fs.unlinkSync(fileForMask);

  check('maskedCredential output never carries the raw key', function () {
    assert.equal(masked.ok, true);
    assert.equal(masked.ref, 'AIFE_API_KEY');
    assert.equal(JSON.stringify(masked).includes('sk-aife-000'), false,
      '遮蔽结果里不该出现原文：' + JSON.stringify(masked));
    assert.ok(masked.maskKey.startsWith('sk-'));
  });

  const serviceCalls = [];
  const serviceCtx = {
    get(name) {
      if (name !== 'credentials') return undefined;
      return {
        resolve(ref) {
          serviceCalls.push(ref);
          return Promise.resolve(ref === 'AIFE_API_KEY'
            ? { value: 'sk-from-service', source: 'store' }
            : undefined);
        }
      };
    }
  };
  const fromService = await secrets.maskedCredential(serviceCtx, { now: new Date(0) });

  check('maskedCredential prefers the credentials service when it has a value', function () {
    assert.equal(fromService.ok, true);
    assert.equal(fromService.ref, 'AIFE_API_KEY');
    assert.equal(fromService.source, 'store');
    assert.equal(JSON.stringify(fromService).includes('sk-from-service'), false);
    assert.equal(serviceCalls.length >= 1, true);
  });

  const fileForFallback = tempCredentials(SAMPLE);
  const fromFile = await secrets.maskedCredential(
    { get() { return { resolve() { return Promise.resolve(undefined); } }; } },
    { file: fileForFallback, refs: ['AIFE_API_KEY'], now: new Date(0) }
  );
  fs.unlinkSync(fileForFallback);

  check('maskedCredential falls back to the file when the service has nothing', function () {
    assert.equal(fromFile.ok, true);
    assert.equal(fromFile.ref, 'AIFE_API_KEY');
  });

  /* ------------------------------------------------- 远端回应的形状收束 */

  check('normalizeRestorePayload finds keys at the top level', function () {
    const result = secrets.normalizeRestorePayload({ apiKey: 'K-1', name: 'Jinbe' });
    assert.deepEqual(JSON.parse(JSON.stringify(result.candidates)), [{ path: 'apiKey', value: 'K-1' }]);
    assert.equal(result.fields.name, 'Jinbe');
  });

  check('normalizeRestorePayload looks into data / settings / value / result', function () {
    const nested = secrets.normalizeRestorePayload({ data: { settings: { token: 'K-2' } } });
    assert.equal(nested.candidates.length, 1);
    assert.equal(nested.candidates[0].value, 'K-2');
    assert.equal(nested.candidates[0].path, 'data.settings.token');
  });

  check('normalizeRestorePayload collects several candidate field names in order', function () {
    const result = secrets.normalizeRestorePayload({ apiKey: 'K-1', token: 'K-2', secret: 'K-3' });
    assert.deepEqual(result.candidates.map((c) => c.value), ['K-1', 'K-2', 'K-3']);
  });

  check('normalizeRestorePayload reports an empty 200 as no candidates', function () {
    const result = secrets.normalizeRestorePayload({});
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(JSON.parse(JSON.stringify(result.raw)), {});
  });

  check('normalizeRestorePayload survives non-object payloads', function () {
    assert.deepEqual(secrets.normalizeRestorePayload(null).candidates, []);
    assert.deepEqual(secrets.normalizeRestorePayload('nope').candidates, []);
  });

  /* ------------------------------------ 真实端点的回应形状（实测 2026-10-15） */

  // 实测 `POST …/storage/kaneo` 回的是**大写加底线**的栏位名。第一版用大小写
  // 敏感的清单，于是「明明有值却一个候选都收不到」—— 这一条把它钉住。
  const REAL_REPLY = {
    REDIRECT_URL: '/dashboard',
    API_KEY: '389de7025bba3268fdfd994e13b1d0f7c74b08b8db3af15636eead5ef2a9a82b'
  };

  check('the real uppercase field names are recognized', function () {
    const result = secrets.normalizeRestorePayload(REAL_REPLY);
    assert.equal(result.candidates.length, 1, JSON.stringify(result));
    assert.equal(result.candidates[0].path, 'API_KEY', '报告的路径要用回应里真正的名字');
    assert.equal(result.candidates[0].value, REAL_REPLY.API_KEY);
  });

  check('REDIRECT_URL becomes fields.redirect', function () {
    const result = secrets.normalizeRestorePayload(REAL_REPLY);
    assert.equal(result.fields.redirect, '/dashboard');
  });

  check('an off-site REDIRECT_URL is dropped', function () {
    assert.equal(secrets.normalizeRestorePayload({ REDIRECT_URL: 'https://evil.example' }).fields.redirect, undefined);
    assert.equal(secrets.normalizeRestorePayload({ REDIRECT_URL: '//evil.example' }).fields.redirect, undefined);
    assert.equal(secrets.normalizeRestorePayload({ redirectUrl: '/p/demo' }).fields.redirect, '/p/demo');
  });

  console.log('');
  console.log(process.exitCode === 1 ? 'failed' : 'all ' + passed + ' checks passed');
})().catch(function (err) {
  console.error(err);
  process.exitCode = 1;
});
