/* =============================================================================
 * ntfy-teams · core.js 实测（打真实服务器 https://msn.feg.cn）
 *
 *   node test/core-live.js
 *
 * 覆盖验收标准的第 3、4 条：
 *   3. 在 pub_ 主题上发布唯一消息 → fetchTopicMessages 读回 → subscribeTopic 在订阅
 *      打开期间收到新发布的消息；
 *   4. 非 pub_ 主题、无凭据 → 401 且 authRequired:true，并且**证明请求没带 Authorization**。
 *
 * 所有请求都被本脚本包了一层 fetch 记录器，输出里能看到实际 URL 与请求头名字。
 * ========================================================================== */
'use strict';

var assert = require('assert');
var core = require('../lib/core.js');

var SERVER = 'https://msn.feg.cn';
var PUB_TOPIC = 'pub_dshteamtest';
var PRIVATE_TOPIC = 'dshteamtest';

var passed = 0;
var failed = 0;

function group(title) {
  console.log('\n== ' + title);
}

/** 每个步骤独立 try/catch：某一步失败也继续跑后面的。 */
async function step(name, fn) {
  try {
    var detail = await fn();
    passed++;
    console.log('  ok   ' + name + (detail ? '  [' + detail + ']' : ''));
  } catch (error) {
    failed++;
    console.log('  FAIL ' + name);
    console.log('       ' + (error && error.message ? error.message : String(error)));
  }
}

function waitFor(predicate, timeoutMs, label) {
  return new Promise(function (resolve, reject) {
    var started = Date.now();
    (function tick() {
      var value;
      try {
        value = predicate();
      } catch (e) {
        return reject(e);
      }
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error('等待超时 ' + timeoutMs + 'ms：' + label));
      }
      setTimeout(tick, 100);
    })();
  });
}

/* -------------------------------------------- fetch 记录器（证明请求头） */

var fetchCalls = [];
var realFetch = globalThis.fetch;

globalThis.fetch = function (input, init) {
  var headers = init && init.headers ? init.headers : {};
  var names = [];
  try {
    names = Object.keys(headers).map(function (key) { return key.toLowerCase(); });
  } catch (e) {
    names = [];
  }
  fetchCalls.push({
    url: typeof input === 'string' ? input : String(input && input.url ? input.url : input),
    headerNames: names,
    hasAuthorization: names.indexOf('authorization') !== -1
  });
  return realFetch.call(globalThis, input, init);
};

/* ---------------------------------------------------------------- main */

async function main() {
  var suffix = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  var historyProbe = 'probe ' + suffix + ' history';
  var liveProbe = 'probe ' + suffix + ' live';

  console.log('服务器：' + SERVER);
  console.log('公共主题：' + PUB_TOPIC + '（无需鉴权） · 探针后缀：' + suffix);

  group('连通性');
  await step('testConnection(msn.feg.cn) → ok:true / status:200 / error:null', async function () {
    var result = await core.testConnection('msn.feg.cn');
    assert.strictEqual(result.ok, true, '实际：' + JSON.stringify(result));
    assert.strictEqual(result.status, 200, '实际 status=' + result.status);
    assert.strictEqual(result.error, null);
    return 'status=' + result.status;
  });

  group('发布 → 历史回读（验收 3a）');
  var publishedId = null;

  await step('publishMessage(pub_…) → ok:true，返回 message.id', async function () {
    var result = await core.publishMessage(SERVER, PUB_TOPIC, {
      message: historyProbe,
      cred: { mode: 'none' }
    });
    assert.strictEqual(result.ok, true, '实际：' + JSON.stringify(result));
    assert.strictEqual(result.status, 200, '实际 status=' + result.status);
    assert.ok(result.message && result.message.id, '应返回 message.id');
    publishedId = result.message.id;
    assert.ok(result.message.time > 1700000000, 'time 应为 unix 秒，实际 ' + result.message.time);
    return 'id=' + result.message.id + ' time=' + result.message.time;
  });

  await step('fetchTopicMessages(pub_…) → status:200，且历史里能读回该消息', async function () {
    var result = await core.fetchTopicMessages(SERVER, PUB_TOPIC, { cred: { mode: 'none' }, limit: 200 });
    assert.strictEqual(result.status, 200, JSON.stringify({ status: result.status, error: result.error }));
    assert.strictEqual(result.error, null);
    assert.strictEqual(result.authRequired, false);
    assert.ok(result.messages.length > 0, '历史不应为空');
    var hit = result.messages.filter(function (msg) { return msg.id === publishedId; })[0];
    assert.ok(hit, '历史里应包含刚发布的 id=' + publishedId + '（共 ' + result.messages.length + ' 条）');
    assert.strictEqual(hit.message, historyProbe);
    assert.strictEqual(hit.topic, PUB_TOPIC);
    return '共 ' + result.messages.length + ' 条，命中 ' + hit.id;
  });

  group('SSE 实时订阅（验收 3b）');
  await step('subscribeTopic：订阅打开期间发布 → onMessage 送达', async function () {
    var received = [];
    var statuses = [];
    var errors = [];
    var closedCount = 0;

    var subscription = core.subscribeTopic(SERVER, PUB_TOPIC, {
      cred: { mode: 'none' },
      onMessage: function (msg) { received.push(msg); },
      onStatus: function (status) {
        statuses.push(status.phase);
        if (status.phase === 'closed') closedCount++;
      },
      onError: function (error) { errors.push(error); }
    });

    assert.strictEqual(typeof subscription.close, 'function', '必须同步返回 {close()}');

    await waitFor(function () {
      return statuses.indexOf('open') !== -1 || errors.length > 0;
    }, 15000, 'SSE 连接建立');
    assert.strictEqual(errors.length, 0, '连接阶段不应报错：' + JSON.stringify(errors));

    var published = await core.publishMessage(SERVER, PUB_TOPIC, {
      message: liveProbe,
      cred: { mode: 'none' }
    });
    assert.strictEqual(published.ok, true, '发布失败：' + JSON.stringify(published));

    await waitFor(function () {
      return received.some(function (msg) { return msg.message === liveProbe; });
    }, 25000, '实时消息送达');

    assert.ok(statuses.indexOf('live') !== -1, '第一个数据块之后应进入 live 阶段');
    assert.deepStrictEqual(statuses.slice(0, 2), ['connecting', 'open'], '阶段顺序：' + statuses.join('→'));

    subscription.close();
    subscription.close(); // 幂等
    assert.strictEqual(closedCount, 1, 'closed 状态必须恰好触发一次，实际 ' + closedCount);

    return '阶段=' + statuses.join('→') + '，共收到 ' + received.length + ' 条，closed 次数=' + closedCount;
  });

  group('鉴权边界（验收 4）');
  var authResult = null;

  await step('fetchTopicMessages(dshteamtest, cred:none) → 401/403 / authRequired:true / 无 Authorization 头', async function () {
    var before = fetchCalls.length;
    authResult = await core.fetchTopicMessages(SERVER, PRIVATE_TOPIC, { cred: { mode: 'none' } });

    // 实测（msn.feg.cn）：匿名请求私有主题时，反向代理直接回 403（不到 ntfy 本体）；
    // 带了错误凭据才会回 401。两者都表示「需要认证」，store/UI 只依赖 authRequired。
    assert.ok(authResult.status === 401 || authResult.status === 403,
      '应为 401 或 403，实际：' + JSON.stringify(authResult));
    assert.strictEqual(authResult.authRequired, true);
    assert.deepStrictEqual(authResult.messages, []);
    assert.ok(authResult.error, '应带错误描述');

    var calls = fetchCalls.slice(before);
    assert.strictEqual(calls.length, 1, '应恰好发出 1 个请求');
    assert.ok(calls[0].url.indexOf('/' + PRIVATE_TOPIC + '/json') !== -1, '实际 URL：' + calls[0].url);
    assert.strictEqual(calls[0].hasAuthorization, false,
      '匿名请求绝不能带 Authorization 头，实际请求头：' + JSON.stringify(calls[0].headerNames));

    return 'status=' + authResult.status + ' · 请求头=[' + calls[0].headerNames.join(',') + ']（无 Authorization）';
  });

  await step('describeError(認證失敗結果) → 繁體中文「認證」提示', async function () {
    var text = core.describeError(authResult);
    assert.strictEqual(typeof text, 'string');
    assert.ok(text.indexOf('認證') !== -1, '实际：' + text);
    return text;
  });

  await step('publishMessage(dshteamtest, cred:none) → ok:false / 401或403 / 无 Authorization 头', async function () {
    var before = fetchCalls.length;
    var result = await core.publishMessage(SERVER, PRIVATE_TOPIC, {
      message: 'probe ' + suffix + ' should-be-rejected',
      cred: { mode: 'none' }
    });
    assert.strictEqual(result.ok, false, '实际：' + JSON.stringify(result));
    assert.ok(result.status === 401 || result.status === 403, '实际 status=' + result.status);
    var calls = fetchCalls.slice(before);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].hasAuthorization, false, '请求头：' + JSON.stringify(calls[0].headerNames));
    return 'status=' + result.status + ' error=' + result.error;
  });

  group('请求记录（本次全部请求，用于交叉核对）');
  fetchCalls.forEach(function (call, index) {
    console.log('  ' + (index + 1) + '. ' + (call.hasAuthorization ? '[Authorization] ' : '[anonymous]   ') + call.url);
  });
}

/* -------------------------------------------------------------- 运行 */

var watchdog = setTimeout(function () {
  console.log('\n!! 全局超时（120s），强制退出');
  process.exit(3);
}, 120000);

main()
  .catch(function (error) {
    failed++;
    console.log('\n未捕获异常：' + (error && error.stack ? error.stack : error));
  })
  .then(function () {
    clearTimeout(watchdog);
    console.log('\n--------------------------------------------------');
    console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
    if (failed > 0) {
      console.log('结果：FAILED');
      process.exitCode = 1;
    } else {
      console.log('结果：PASS（真实服务器 ' + SERVER + '）');
      process.exitCode = 0;
    }
    // 不要在 handle 正在关闭的瞬间强制 process.exit()：Node 24 + Windows 上
    // 会触发 libuv 断言（Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)），
    // 退出码变成 0xC0000409。这里让事件循环自然排空（undici keep-alive 最多几秒），
    // 只保留一个 unref 的兜底计时器，防止极端情况下卡住不退出。
    var forceExit = setTimeout(function () {
      process.exit(process.exitCode || 0);
    }, 8000);
    if (forceExit && typeof forceExit.unref === 'function') forceExit.unref();
  });
