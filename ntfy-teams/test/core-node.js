/* =============================================================================
 * ntfy-teams · core.js 离线单元测试（无网络）
 *
 *   node test/core-node.js
 *
 * 覆盖契约要求的全部纯逻辑：
 *   decodeId / parseTimeline / parseSseEvent / authHeaders / normalizeServer /
 *   mergeMessages / store 引用稳定性 / 凭据持久化 / describeError
 * 追加覆盖：
 *   parseMarkdown / inlineToText（Markdown 子集、inline 优先序、连结白名单、100 KB 效能）
 *   parseIdentity / senderTitle / setIdentity / getIdentity（发送者身份）
 * 追加覆盖网络层（stub 掉 globalThis.fetch，仍然零网络）：
 *   publishMessage / fetchTopicMessages / testConnection / subscribeTopic
 *
 * ⚠️ decodeId 的实测结论（已由 Lead 独立复核，8 个真实样本一致）：
 *   msn.feg.cn 的 ID 是 12 个 [A-Za-z0-9] 字符（base64url 解码后 9 字节），
 *   是**随机 ID、不携带时间戳**；对 8 个真实样本枚举全部位偏移 × 位长 × 10 的幂缩放
 *   都还原不出 JSON 里的 time（上游 ntfy 用 util.RandomString(12) 生成消息 ID）。
 *   所以本测试断言的是真实行为：随机 ID → null，畸形输入 → null；
 *   契约里「decodeId('1jLfaNcFIDCe') === 1790756810」这条验收标准已作废。
 * ========================================================================== */
'use strict';

var assert = require('assert');
var core = require('../lib/core.js');

/**
 * 宣告「面板正顯示著」。
 *
 * store 預設是「看不到面板」——它本身不知道有沒有人在看。未讀要不要累加、
 * 「讀到哪」要不要前進，都取決於這個旗標。client 掛載時會自己設定，
 * 這裡的測試等於扮演那個 client，所以要明說「我正在看」。
 * @param visible - 是否可見。
 */
function viewing(visible) {
  core.store.setViewHooks({ isPanelVisible: function () { return visible === true; } });
}
viewing(true);

/* ----------------------------------------------------------- 测试脚手架 */

var passed = 0;
var failed = 0;

function group(title) {
  console.log('\n== ' + title);
}

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failed++;
    console.log('  FAIL ' + name);
    console.log('       ' + (error && error.message ? error.message : String(error)));
  }
}

/** 异步版本的 check（网络层 stub 用例用）。 */
async function acheck(name, fn) {
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

/* ------------------------------------------------- 假 localStorage（Node 没有） */

function makeFakeStorage(limit) {
  var map = {};
  return {
    getItem: function (key) {
      return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
    },
    setItem: function (key, value) {
      var text = String(value);
      if (limit && text.length > limit) throw new Error('QuotaExceededError');
      map[key] = text;
    },
    removeItem: function (key) {
      delete map[key];
    },
    _dump: function () {
      return map;
    }
  };
}

globalThis.localStorage = makeFakeStorage();

var STORE_KEY = 'ntfy-teams:store:v1';

/* ------------------------------------------------------------ 真实样本 */

var REAL_HISTORY_LINE =
  '{"id":"1jLfaNcFIDCe","time":1790756810,"expires":1790800010,"event":"message",' +
  '"topic":"pub_dshteamtest","message":"hello from DSH plugin probe"}';

var REAL_SSE_OPEN_BLOCK =
  'event: open\ndata: {"id":"lPvlYw5BVHSE","time":1790756839,"event":"open","topic":"pub_dshteamtest"}';

var REAL_SSE_MESSAGE_BLOCK =
  'data: {"id":"yIr1fBunlw3L","time":1790757745,"expires":1790800945,"event":"message",' +
  '"topic":"pub_dshteamtest","message":"probe 1"}';

/** 实测采集到的真实 (id, time) 对，跨两次会话。 */
var REAL_ID_TIME = [
  ['1jLfaNcFIDCe', 1790756810],
  ['lPvlYw5BVHSE', 1790756839],
  ['yIr1fBunlw3L', 1790757745],
  ['HkJNrDbbMGeJ', 1790757754],
  ['TR3e42ppxW2l', 1790757761]
];

/** 契约描述的「8 字节大端 unix 纳秒」ID。 */
function nanosecondId(seconds) {
  var buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(seconds) * 1000000000n);
  return buffer.toString('base64url');
}

/** 8 字节大端 unix 毫秒 ID（decodeId 的兜底分支）。 */
function millisecondId(seconds) {
  var buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(seconds) * 1000n);
  return buffer.toString('base64url');
}

/* =========================================================== 1. 双形态 */

group('模块形态（浏览器 classic script + Node require 双形态）');

check('require() 返回 API 对象', function () {
  assert.strictEqual(typeof core, 'object');
  assert.strictEqual(typeof core.decodeId, 'function');
});

check('require() 本身无副作用，moduleRoot() 才挂载 globalThis.__ntfyTeamsCore', function () {
  // 关键：combo script 会把每个 plugin 档案包成 lazy body，档案在注册阶段不执行，
  // 所以「core.js 排在 client.js 前面」并不保证 global 已经存在。core 因此把实作
  // 包进 moduleRoot()，由 client.js 的 factory 在 materialize 时主动呼叫。
  // 这里验证的正是那条接线，而不是旧的「载入即挂载」假设。
  assert.strictEqual(typeof core.moduleRoot, 'function', '必须导出 moduleRoot()');
  assert.strictEqual(globalThis.__ntfyTeamsCore, undefined, 'require() 不应有副作用');

  var api = core.moduleRoot();
  assert.strictEqual(globalThis.__ntfyTeamsCore, api, 'moduleRoot() 应把 api 挂到 globalThis');
  assert.strictEqual(typeof api.decodeId, 'function');
});

check('契约列出的 API 全部存在', function () {
  var required = [
    'CONFIG', 'AUTH_MODES', 'readConfig',
    'loadCredentials', 'saveCredentials', 'clearCredentials',
    'normalizeServer', 'topicUrl', 'decodeId', 'sortMessages', 'mergeMessages', 'authHeaders',
    'parseServerMessage', 'parseTimeline', 'parseSseEvent',
    'fetchTopicMessages', 'publishMessage', 'testConnection', 'subscribeTopic',
    'store', 'describeError',
    // task-5 追加：Markdown 解析 + 发送者身份
    'parseMarkdown', 'inlineToText',
    'parseIdentity', 'senderTitle', 'setIdentity', 'getIdentity'
  ];
  required.forEach(function (key) {
    assert.ok(key in core, '缺少 API: ' + key);
  });
  assert.deepStrictEqual(core.AUTH_MODES, ['none', 'basic', 'token']);
  assert.strictEqual(core.CONFIG.server, 'https://msn.feg.cn');
  assert.deepStrictEqual(core.CONFIG.topics, []);
  assert.strictEqual(core.CONFIG.historyLimit, 300);
  assert.strictEqual(core.CONFIG.identity, '', 'CONFIG 必须带 identity 预设空串');
});

check('clampDashboardWidth：夾在 [min, max]，且低於最小值會被抬上來', function () {
  // 看板最小寬度是需求指定的值（會依使用者要求調整，所以**不要在這裡寫死數字** ——
  // 寫死的話每次改最小值都要改測試，而且會掩蓋「改了常數卻沒生效」）。
  var min = core.CONFIG.dashboardMinWidth;
  var max = core.CONFIG.dashboardMaxWidth;
  assert.ok(typeof min === 'number' && min > 0, 'dashboardMinWidth 應該是正數');
  assert.ok(max > min, '上限必須大於下限');

  // 低於下限 → 抬到下限（**這條最重要**：舊的存檔可能比新下限還窄）
  assert.strictEqual(core.clampDashboardWidth(min - 100, min), min, '低於下限應抬到下限');
  assert.strictEqual(core.clampDashboardWidth(0, min), min, '0 也該抬到下限');
  assert.strictEqual(core.clampDashboardWidth(-50, min), min, '負數也該抬到下限');

  // 範圍內 → 原樣（四捨五入到整數）
  assert.strictEqual(core.clampDashboardWidth(min, min), min);
  assert.strictEqual(core.clampDashboardWidth(min + 40, min), min + 40);
  assert.strictEqual(core.clampDashboardWidth(min + 40.6, min), min + 41, '應四捨五入');

  // 高於上限 → 夾到上限
  assert.strictEqual(core.clampDashboardWidth(max + 500, min), max, '高於上限應夾到上限');

  // 非數字 → 用 fallback；fallback 也不是數字 → 用預設寬度
  assert.strictEqual(core.clampDashboardWidth(null, min + 10), min + 10, 'null 應用 fallback');
  assert.strictEqual(core.clampDashboardWidth(undefined, min + 10), min + 10, 'undefined 應用 fallback');
  assert.ok(core.clampDashboardWidth(null, null) > 0, '全都沒有時至少要是正數');

  // 預設寬度本身不可以小於最小值（否則一開就違規）
  assert.ok(core.CONFIG.dashboardWidth >= min,
    'CONFIG.dashboardWidth（' + core.CONFIG.dashboardWidth + '）不該小於最小值（' + min + '）');
});

check('store 的方法全部存在（不再有 loadPersisted／persist）', function () {
  ['getSnapshot', 'subscribe', 'ensureTopic', 'pinTopicFirst', 'removeTopic', 'setActiveTopic',
    'addMessages', 'addMessage', 'setStatus', 'setAuthRequired', 'clearMessages',
    'markRead', 'markReadToLatest', 'setViewHooks', 'clearStatuses'].forEach(function (key) {
    assert.strictEqual(typeof core.store[key], 'function', '缺少 store.' + key);
  });
  // 這個外掛刻意不使用 localStorage → 這兩個持久化方法應該已經不存在。
  assert.strictEqual(core.store.loadPersisted, undefined,
    'loadPersisted 應該已經移除（不再用 localStorage）');
  assert.strictEqual(core.store.persist, undefined,
    'persist 應該已經移除（不再用 localStorage）');
});

check('clearStatuses 把狀態重置回 idle（重連前必須清掉上一條連線的錯誤）', function () {
  // 這個回歸對應使用者回報的「修改認證方式保存後，一直顯示上一個的錯誤」。
  //
  // 病灶：連線重建了，但 store 裡的 statusByTopic 還掛著上一條連線的
  // 「HTTP 403 需要認證」。使用者看到殘影，以為認證沒有生效。
  core.saveConfig({ server: 'https://msn.feg.cn', topics: [] });
  (core.store.getSnapshot().topics || []).slice().forEach(function (t) { core.store.removeTopic(t); });
  core.store.ensureTopic('cs_a');
  core.store.ensureTopic('cs_b');

  core.store.setStatus('cs_a', { phase: 'error', detail: 'HTTP 403：需要認證', retryAt: Date.now() + 3000 });
  core.store.setStatus('cs_b', { phase: 'closed', detail: '連線結束' });

  var changed = core.store.clearStatuses();
  assert.strictEqual(changed, 2, '應該重置 2 個主題，實際 ' + changed);

  var after = core.store.getSnapshot().statusByTopic;
  ['cs_a', 'cs_b'].forEach(function (t) {
    var st = after[t];
    // 必須回到「中性」。注意不能只斷言「不是 error」—— 之前用 delete 清，
    // 結果 emit 之後下游又把 `{phase:'',detail:''}` 填回來（看起來清掉了、其實還在）。
    var neutral = !st || st.phase === 'idle' || st.phase === '';
    assert.ok(neutral, t + ' 應該回到中性狀態，實際：' + JSON.stringify(st));
    assert.ok(!st || st.retryAt === undefined, t + ' 不該還帶著 retryAt');
  });
  assert.strictEqual(JSON.stringify(after).indexOf('error'), -1, '不該還有 error');

  // 側欄健康度要回到「正常」，而不是顯示故障。
  assert.notStrictEqual(core.sidebarHealth(core.store.getSnapshot()).state, 'error',
    '清完之後不該還被判定成 error');

  // 冪等：沒有東西可清時回 0，而且不會濫發變更。
  assert.strictEqual(core.store.clearStatuses(), 0, '第二次應該回 0');

  // 「需要認證」旗標也要一起清 —— 這是「保存生效了，提示還在顯示上一次的錯誤」
  // 的根因：那個旗標只會被 403 設成 true，沒有人設回 false。
  //
  // 為什麼可以清：它是「**上一次嘗試**的結論」，不是事實。重建連線＝重新嘗試，
  // 所以從「還不知道」開始；真的還需要認證時，新的 403 會再設回 true。
  core.store.setAuthRequired('cs_a', true);
  core.store.setStatus('cs_a', { phase: 'error', detail: 'x' });
  assert.strictEqual(core.store.getSnapshot().authByTopic.cs_a, true, '前置：旗標應為 true');
  const changed2 = core.store.clearStatuses();
  assert.ok(changed2 >= 1, '應該有東西被清（旗標或狀態），實際 ' + changed2);
  assert.strictEqual(core.store.getSnapshot().authByTopic.cs_a, false,
    'clearStatuses 應該把「需要認證」清掉，否則提示會一直掛著');

  // 其他主題上的「需要認證」也該一起清（合併連線時 403 會記在每個主題上）。
  core.store.setAuthRequired('cs_a', true);
  core.store.setAuthRequired('cs_b', true);
  core.store.clearStatuses();
  assert.strictEqual(core.store.getSnapshot().authByTopic.cs_a, false, 'cs_a 應被清');
  assert.strictEqual(core.store.getSnapshot().authByTopic.cs_b, false, 'cs_b 應被清');

  core.store.removeTopic('cs_a');
  core.store.removeTopic('cs_b');
});

check('没有调用 window.__ModuleLoader__（不注册客户端工厂）', function () {
  assert.strictEqual(typeof globalThis.__ModuleLoader__, 'undefined');
});

/* =========================================================== 2. decodeId */

group('decodeId —— 契约 ID 形态 + 真实服务器 ID 的实测结论');

check('契约形态：8 字节大端 unix 纳秒 → 正确的 unix 秒', function () {
  assert.strictEqual(nanosecondId(1790756810).length, 11, '8 字节 base64url 应为 11 字符');
  assert.strictEqual(core.decodeId(nanosecondId(1790756810)), 1790756810);
  assert.strictEqual(core.decodeId(nanosecondId(0)), null, '1970 年落在合理窗口外 → null');
});

check('兜底形态：8 字节大端 unix 毫秒 → 正确的 unix 秒', function () {
  assert.strictEqual(core.decodeId(millisecondId(1790756810)), 1790756810);
});

check('实测：真实随机 ID → null（不是时间编码）', function () {
  console.log('       证据 · 真实 ID 的 base64url 解码结果：');
  REAL_ID_TIME.forEach(function (pair) {
    var bytes = Buffer.from(pair[0], 'base64url');
    console.log('         ' + pair[0] + '  -> ' + bytes.length + ' bytes 0x' + bytes.toString('hex') +
      '  (JSON time=' + pair[1] + ', decodeId=' + core.decodeId(pair[0]) + ')');
    assert.strictEqual(bytes.length, 9, '实测每个真实 ID 都是 9 字节 / 12 字符');
    assert.strictEqual(core.decodeId(pair[0]), null, '随机 ID 必须返回 null');
  });
});

check('parseServerMessage 的 time 兜底：随机 ID 得到 0，真时间 ID 得到时间', function () {
  var noTime = core.parseServerMessage({ id: '1jLfaNcFIDCe', event: 'message', topic: 't' }, 'https://msn.feg.cn');
  assert.strictEqual(noTime.time, 0, '随机 ID 不应被解成荒诞年份');

  var withTime = core.parseServerMessage({ id: nanosecondId(1790756810), event: 'message' }, 'https://msn.feg.cn');
  assert.strictEqual(withTime.time, 1790756810, '真·纳秒 ID 应能兜底出时间');
});

check('非法输入返回 null，绝不抛异常', function () {
  assert.strictEqual(core.decodeId(''), null);
  assert.strictEqual(core.decodeId(null), null);
  assert.strictEqual(core.decodeId(undefined), null);
  assert.strictEqual(core.decodeId('!!!!'), null);
  assert.strictEqual(core.decodeId('AAAA'), null, '4 字节不是契约形态');
  assert.strictEqual(core.decodeId('A'.repeat(64)), null, '超出窗口 / 长度不符 → null');
});

/* =========================================================== 3. 解析 */

group('parseServerMessage / parseTimeline / parseSseEvent');

check('parseTimeline 解析真实历史行', function () {
  var messages = core.parseTimeline(REAL_HISTORY_LINE, 'https://msn.feg.cn');
  assert.strictEqual(messages.length, 1);
  var msg = messages[0];
  assert.strictEqual(msg.id, '1jLfaNcFIDCe');
  assert.strictEqual(msg.time, 1790756810);
  assert.strictEqual(msg.expires, 1790800010);
  assert.strictEqual(msg.event, 'message');
  assert.strictEqual(msg.topic, 'pub_dshteamtest');
  assert.strictEqual(msg.message, 'hello from DSH plugin probe');
  assert.strictEqual(msg.server, 'https://msn.feg.cn');
  assert.strictEqual(msg.source, 'history');
  assert.deepStrictEqual(msg.tags, []);
  assert.deepStrictEqual(msg.actions, []);
  assert.strictEqual(msg.priority, 0);
  assert.strictEqual(typeof msg.raw, 'object');
});

check('parseTimeline 忽略噪声、容忍 data: 前缀、坏行不抛异常', function () {
  var text = [
    'event: open',
    '',
    ': keepalive',
    'data: ' + REAL_HISTORY_LINE,
    REAL_SSE_MESSAGE_BLOCK,
    'not json at all',
    'data: ',
    '[DONE]',
    '{"id":"TR3e42ppxW2l","time":1790757761,"event":"message","topic":"pub_dshteamtest","message":"probe 3"}'
  ].join('\n');
  var messages = core.parseTimeline(text, 'https://msn.feg.cn');
  assert.deepStrictEqual(messages.map(function (m) { return m.id; }),
    ['1jLfaNcFIDCe', 'yIr1fBunlw3L', 'TR3e42ppxW2l']);
});

check('parseTimeline 对非字符串 / 空输入返回空数组', function () {
  assert.deepStrictEqual(core.parseTimeline(null, 's'), []);
  assert.deepStrictEqual(core.parseTimeline('', 's'), []);
  assert.deepStrictEqual(core.parseTimeline(undefined, 's'), []);
});

check('parseSseEvent 丢弃 event: open 块', function () {
  assert.strictEqual(core.parseSseEvent(REAL_SSE_OPEN_BLOCK, 'https://msn.feg.cn'), null);
});

check('parseSseEvent 解析裸 data: 消息块', function () {
  var msg = core.parseSseEvent(REAL_SSE_MESSAGE_BLOCK, 'https://msn.feg.cn');
  assert.ok(msg, '应解析出消息');
  assert.strictEqual(msg.id, 'yIr1fBunlw3L');
  assert.strictEqual(msg.time, 1790757745);
  assert.strictEqual(msg.topic, 'pub_dshteamtest');
  assert.strictEqual(msg.message, 'probe 1');
  assert.strictEqual(msg.source, 'sse');
});

check('parseSseEvent 用 \\n 连接多行 data:', function () {
  var block = 'event: message\ndata: {"id":"m1",\ndata: "time":5,"topic":"t","message":"hi"}';
  var msg = core.parseSseEvent(block, 'https://msn.feg.cn');
  assert.ok(msg);
  assert.strictEqual(msg.id, 'm1');
  assert.strictEqual(msg.time, 5);
  assert.strictEqual(msg.message, 'hi');
});

check('parseSseEvent 丢弃 keepalive / 坏 JSON / 无 data 块', function () {
  assert.strictEqual(core.parseSseEvent('event: keepalive\ndata: {"id":"k","time":1,"event":"keepalive"}', 's'), null);
  assert.strictEqual(core.parseSseEvent('data: {oops', 's'), null);
  assert.strictEqual(core.parseSseEvent('event: open', 's'), null);
  assert.strictEqual(core.parseSseEvent('', 's'), null);
  assert.strictEqual(core.parseSseEvent(null, 's'), null);
});

check('parseServerMessage 坏输入返回 null', function () {
  assert.strictEqual(core.parseServerMessage('{oops', 's'), null);
  assert.strictEqual(core.parseServerMessage(null, 's'), null);
  assert.strictEqual(core.parseServerMessage([1, 2], 's'), null);
  assert.strictEqual(core.parseServerMessage('null', 's'), null);
});

check('parseServerMessage 归一化 tags/priority/title/click/actions', function () {
  var msg = core.parseServerMessage({
    id: 'x', time: 5, topic: 't', title: 'T', message: 'M',
    tags: ['a', 1, null], priority: '4', click: 'https://e.x', actions: [{ action: 'view' }]
  }, 'msn.feg.cn/');
  assert.deepStrictEqual(msg.tags, ['a', '1']);
  assert.strictEqual(msg.priority, 4);
  assert.strictEqual(msg.title, 'T');
  assert.strictEqual(msg.click, 'https://e.x');
  assert.deepStrictEqual(msg.actions, [{ action: 'view' }]);
  assert.strictEqual(msg.server, 'https://msn.feg.cn');
  assert.strictEqual(msg.source, 'server');
});

/* ====================================================== 4. 地址 / 鉴权 */

group('normalizeServer / topicUrl / authHeaders');

check('normalizeServer 各种输入', function () {
  assert.strictEqual(core.normalizeServer('  https://msn.feg.cn/  '), 'https://msn.feg.cn');
  assert.strictEqual(core.normalizeServer('msn.feg.cn'), 'https://msn.feg.cn');
  assert.strictEqual(core.normalizeServer('msn.feg.cn///'), 'https://msn.feg.cn');
  assert.strictEqual(core.normalizeServer('http://msn.feg.cn'), 'http://msn.feg.cn');
  assert.strictEqual(core.normalizeServer('msn.feg.cn/base/'), 'https://msn.feg.cn/base');
  assert.strictEqual(core.normalizeServer('//msn.feg.cn'), 'https://msn.feg.cn');
  assert.strictEqual(core.normalizeServer(''), '');
  assert.strictEqual(core.normalizeServer('   '), '');
  assert.strictEqual(core.normalizeServer(null), '');
  assert.strictEqual(core.normalizeServer('https://'), '');
});

check('topicUrl 拼接且编码', function () {
  assert.strictEqual(core.topicUrl('msn.feg.cn', 'pub_dshteamtest'), 'https://msn.feg.cn/pub_dshteamtest');
  assert.strictEqual(core.topicUrl('https://msn.feg.cn/', 'a b'), 'https://msn.feg.cn/a%20b');
  assert.strictEqual(core.topicUrl('https://msn.feg.cn', ' 主题 '), 'https://msn.feg.cn/%E4%B8%BB%E9%A2%98');
});

check('authHeaders: none / 空字段 → 不发送凭据', function () {
  assert.deepStrictEqual(core.authHeaders(null), {});
  assert.deepStrictEqual(core.authHeaders(undefined), {});
  assert.deepStrictEqual(core.authHeaders({ mode: 'none', user: 'u', password: 'p', token: 't' }), {});
  assert.deepStrictEqual(core.authHeaders({ mode: 'basic', user: '', password: 'p' }), {});
  assert.deepStrictEqual(core.authHeaders({ mode: 'basic', user: 'u', password: '' }), {});
  assert.deepStrictEqual(core.authHeaders({ mode: 'token', token: '' }), {});
  assert.deepStrictEqual(core.authHeaders({ mode: 'bearer', token: 'tk' }), {});
});

check('authHeaders: basic 用标准 base64（不是 URL-safe）', function () {
  assert.deepStrictEqual(core.authHeaders({ mode: 'basic', user: 'u', password: 'p' }),
    { Authorization: 'Basic dTpw' });

  // 故意选会产生 '+' / '/' 的字节，证明没有用 URL-safe 字母表（ntfy 按标准 base64 校验 Basic）
  var trickyUser = '\u00ff\u00ff';
  var trickyPass = '\u00ff';
  var expected = 'Basic ' + Buffer.from(trickyUser + ':' + trickyPass, 'utf8').toString('base64');
  assert.ok(/[+/]/.test(expected), 'sanity: 期望值应包含 +/- 字符，实际 ' + expected);
  assert.deepStrictEqual(core.authHeaders({ mode: 'basic', user: trickyUser, password: trickyPass }),
    { Authorization: expected });
  assert.strictEqual(core.authHeaders({ mode: 'basic', user: '用户', password: '密码' }).Authorization,
    'Basic ' + Buffer.from('用户:密码', 'utf8').toString('base64'));
});

check('authHeaders: token → Bearer', function () {
  assert.deepStrictEqual(core.authHeaders({ mode: 'token', token: 'tk_abc123' }),
    { Authorization: 'Bearer tk_abc123' });
});

/* ====================================================== 5. 排序 / 合并 */

group('sortMessages / mergeMessages');

check('sortMessages 升序且不修改入参', function () {
  var input = [{ id: 'c', time: 30 }, { id: 'a', time: 10 }, { id: 'b', time: 20 }];
  var sorted = core.sortMessages(input);
  assert.deepStrictEqual(sorted.map(function (m) { return m.id; }), ['a', 'b', 'c']);
  assert.deepStrictEqual(input.map(function (m) { return m.id; }), ['c', 'a', 'b'], '入参不应被改动');
  assert.deepStrictEqual(core.sortMessages(null), []);
});

check('mergeMessages 去重（后到覆盖先到）', function () {
  var merged = core.mergeMessages(
    [{ id: 'a', time: 1, message: 'old' }],
    [{ id: 'a', time: 1, message: 'new' }, { id: 'b', time: 2, message: 'b' }],
    10
  );
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[0].id, 'a');
  assert.strictEqual(merged[0].message, 'new');
});

check('mergeMessages 升序 + 只保留最新 limit 条', function () {
  var merged = core.mergeMessages(
    [{ id: 'a', time: 3 }, { id: 'b', time: 1 }],
    [{ id: 'c', time: 2 }],
    2
  );
  assert.deepStrictEqual(merged.map(function (m) { return m.id; }), ['c', 'a']);
  assert.deepStrictEqual(merged.map(function (m) { return m.time; }), [2, 3], '保持升序');
});

check('mergeMessages 忽略非对象项', function () {
  var merged = core.mergeMessages([], [null, 'x', 5, { id: 'v', time: 1 }], 10);
  assert.deepStrictEqual(merged.map(function (m) { return m.id; }), ['v']);
});

/* ============================================================ 6. store */

group('store：引用稳定性、变更、未读、订阅');

check('getSnapshot() 无变更时返回同一引用，真实变更后换新引用', function () {
  var s1 = core.store.getSnapshot();
  assert.strictEqual(core.store.getSnapshot(), s1, '未变更必须同引用');
  core.store.ensureTopic('t1');
  var s2 = core.store.getSnapshot();
  assert.notStrictEqual(s2, s1, '发生变更后必须是新引用');
  assert.strictEqual(core.store.getSnapshot(), s2, '再次读取仍应稳定');
  core.store.ensureTopic('t1');
  assert.strictEqual(core.store.getSnapshot(), s2, '重复 ensureTopic 是空操作，不应换引用');
});

check('快照形状完整', function () {
  var snap = core.store.getSnapshot();
  ['topics', 'activeTopic', 'messagesByTopic', 'statusByTopic', 'unreadByTopic', 'authByTopic']
    .forEach(function (key) {
      assert.ok(key in snap, '快照缺少 ' + key);
    });
  assert.ok(Array.isArray(snap.topics));
});

check('addMessages 返回新增条数并去重', function () {
  var a = { id: 'm1', time: 100, message: 'one' };
  var b = { id: 'm2', time: 200, message: 'two' };
  assert.strictEqual(core.store.addMessages('t1', [a, b], 'history'), 2);
  assert.strictEqual(core.store.addMessages('t1', [a], 'history'), 0, '重复消息不计新增');
  assert.strictEqual(core.store.addMessages('t1', [], 'history'), 0);
  assert.deepStrictEqual(core.store.getSnapshot().messagesByTopic.t1.map(function (m) { return m.id; }),
    ['m1', 'm2']);
  assert.strictEqual(core.store.addMessage('t1', { id: 'm3', time: 300, message: 'three' }), true);
  assert.strictEqual(core.store.addMessage('t1', { id: 'm3', time: 300, message: 'three' }), false);
});

check('未读只在 SSE 实时到达且非当前主题时累加', function () {
  core.store.ensureTopic('t2');
  core.store.setActiveTopic('t1');
  assert.strictEqual(core.store.addMessages('t2', [{ id: 'u1', time: 10 }], 'history'), 1);
  assert.strictEqual(core.store.getSnapshot().unreadByTopic.t2, 0, '历史加载不产生未读');
  assert.strictEqual(core.store.addMessages('t2', [{ id: 'u2', time: 11 }], 'sse'), 1);
  assert.strictEqual(core.store.getSnapshot().unreadByTopic.t2, 1, 'SSE 且非当前主题 → 未读 +1');
  assert.strictEqual(core.store.addMessages('t1', [{ id: 'u3', time: 12 }], 'sse'), 1);
  assert.strictEqual(core.store.getSnapshot().unreadByTopic.t1, 0, '当前主题不产生未读');
  core.store.markRead('t2');
  assert.strictEqual(core.store.getSnapshot().unreadByTopic.t2, 0);
});

check('setActiveTopic 换主题并清掉该主题未读', function () {
  core.store.addMessages('t2', [{ id: 'u4', time: 20 }], 'sse');
  core.store.setActiveTopic('t2');
  var snap = core.store.getSnapshot();
  assert.strictEqual(snap.activeTopic, 't2');
  assert.strictEqual(snap.unreadByTopic.t2, 0);
  core.store.setActiveTopic('t1');
});

check('setStatus / setAuthRequired / clearMessages', function () {
  core.store.setStatus('t1', { phase: 'live', detail: '实时接收中' });
  assert.deepStrictEqual(core.store.getSnapshot().statusByTopic.t1, { phase: 'live', detail: '实时接收中' });
  var ref = core.store.getSnapshot();
  core.store.setStatus('t1', { phase: 'live', detail: '实时接收中' });
  assert.strictEqual(core.store.getSnapshot(), ref, '状态没变不应换引用');

  core.store.setAuthRequired('t2', true);
  assert.strictEqual(core.store.getSnapshot().authByTopic.t2, true);
  core.store.setAuthRequired('t2', true);
  core.store.setAuthRequired('t2', false);
  assert.strictEqual(core.store.getSnapshot().authByTopic.t2, false);

  core.store.clearMessages('t1');
  assert.deepStrictEqual(core.store.getSnapshot().messagesByTopic.t1, []);
});

check('subscribe 收到通知，退订幂等', function () {
  var calls = 0;
  var unsubscribe = core.store.subscribe(function () { calls++; });
  core.store.ensureTopic('t3');
  assert.strictEqual(calls, 1);
  unsubscribe();
  unsubscribe();
  core.store.ensureTopic('t4');
  assert.strictEqual(calls, 1, '退订后不应再收到通知');
  core.store.removeTopic('t3');
  core.store.removeTopic('t4');
});

check('removeTopic 清理主题数据并修正 activeTopic', function () {
  core.store.ensureTopic('gone');
  core.store.addMessages('gone', [{ id: 'g1', time: 1 }], 'history');
  core.store.setActiveTopic('gone');
  core.store.removeTopic('gone');
  var snap = core.store.getSnapshot();
  assert.strictEqual(snap.topics.indexOf('gone'), -1);
  assert.strictEqual(snap.messagesByTopic.gone, undefined);
  assert.notStrictEqual(snap.activeTopic, 'gone');
});

/* ================================================= 7. 配置 / 凭据持久化 */

group('配置与凭据持久化（假 localStorage）');

check('readConfig 默认值', function () {
  var config = core.readConfig();
  assert.strictEqual(config.server, 'https://msn.feg.cn');
  assert.strictEqual(config.historyLimit, 300);
  assert.deepStrictEqual(config.topics, []);
});

check('saveConfig → readConfig 往返（归一化 server / topics / limit）', function () {
  core.saveConfig({ server: 'msn.feg.cn/', topics: ['a', 'a', 'b', ''], historyLimit: 42 });
  var config = core.readConfig();
  assert.strictEqual(config.server, 'https://msn.feg.cn');
  assert.deepStrictEqual(config.topics, ['a', 'b']);
  assert.strictEqual(config.historyLimit, 42);
  core.saveConfig({ server: 'https://msn.feg.cn', topics: [], historyLimit: 300 });
});

check('凭据按服务器分桶、保存/读取/清除', function () {
  assert.deepStrictEqual(core.loadCredentials('https://msn.feg.cn'),
    { mode: 'none', user: '', password: '', token: '' });

  core.saveCredentials('msn.feg.cn', { mode: 'token', token: 'tk_1', user: 'alice' });
  assert.deepStrictEqual(core.loadCredentials('https://msn.feg.cn/'),
    { mode: 'token', user: 'alice', password: '', token: 'tk_1' }, 'server 归一化后应命中同一桶');

  core.saveCredentials('https://other.example', { mode: 'basic', user: 'bob', password: 'pw' });
  assert.strictEqual(core.loadCredentials('https://msn.feg.cn').token, 'tk_1', '不同服务器互不干扰');
  assert.deepStrictEqual(core.loadCredentials('other.example'),
    { mode: 'basic', user: 'bob', password: 'pw', token: '' });

  assert.strictEqual(core.clearCredentials('https://msn.feg.cn'), true);
  assert.strictEqual(core.loadCredentials('https://msn.feg.cn').mode, 'none');
  assert.strictEqual(core.loadCredentials('other.example').mode, 'basic', '清除只影响指定服务器');
});

check('saveCredentials 必須同時登記到 credentialServers（否則 secrets 寫不進 YAML）', function () {
  // 這個回歸對應使用者回報的「此主題需要認證：憑證給了、測試也 OK，但保存不了」。
  //
  // 病灶：saveCredentials() 只寫記憶體儲存，而 credentialServers() 只認
  // credentialCache —— collectSecrets()（「哪些憑證要寫進 YAML」）用的正是後者，
  // 於是 PUT 送出的 secrets 是空物件，YAML 永遠是 {}。
  // 兩份儲存必須一起寫；只寫一份就會出現「存了但沒生效」。
  var srv = 'https://regress.example';
  core.clearCredentials(srv);
  // 注意：credentialCache 是模組層的，前面的測試會留下別的伺服器 ——
  // 所以只針對**這個**伺服器斷言，不要宣告整個清單等於 []。
  assert.strictEqual(core.credentialServers().indexOf(srv), -1, '起點應該沒有這個伺服器');

  core.saveCredentials(srv, { mode: 'basic', user: 'u', password: 'p' });
  assert.ok(core.credentialServers().indexOf(srv) !== -1,
    'saveCredentials 之後 credentialServers 必須看得到這個伺服器，實際：'
    + JSON.stringify(core.credentialServers()));
  assert.deepStrictEqual(core.loadCredentials(srv),
    { mode: 'basic', user: 'u', password: 'p', token: '' });

  // 清除時兩份都要清掉，不然會留下一筆「空的」憑證。
  core.clearCredentials(srv);
  assert.strictEqual(core.credentialServers().indexOf(srv), -1, '清除後不該還留著');
});

check('送往宿主的 secrets 不該是空的（憑證存了就要真的送出去）', function () {
  // 這條盯的是「存了但沒生效」的**最後一哩**：
  // client 的 collectSecrets() 就是照這個方式組出要寫進 YAML 的 secrets。
  // 若 saveCredentials 沒讓 credentialServers() 看到憑證，這裡會組出 {} ——
  // 也就是使用者看到的「憑證給了、測試 OK，但保存不了」。
  //
  // 為什麼不直接測 collectSecrets：它是 client 閉包內的私有函式。這裡用同一套
  // 公開 API 重現它的組法（credentialServers + loadCredentials），
  // 契約一旦被打破就會在這裡失敗。
  var srv = 'https://msn.feg.cn';
  core.clearCredentials(srv);
  core.saveCredentials(srv, { mode: 'basic', user: 'u', password: 'p' });

  /** 依 collectSecrets() 的規則組出 secrets。 @returns secrets 物件。 */
  function buildSecrets() {
    var out = {};
    core.credentialServers().forEach(function (s) {
      var c = core.loadCredentials(s);
      if (c.mode === 'none' && c.user === '' && c.password === '' && c.token === '') return;
      out[s] = c;
    });
    return out;
  }

  var secrets = buildSecrets();
  assert.ok(secrets[srv], 'secrets 應包含剛存的伺服器，實際：' + JSON.stringify(secrets));
  assert.strictEqual(secrets[srv].user, 'u', 'secrets 裡必須有帳號');
  assert.strictEqual(secrets[srv].password, 'p', 'secrets 裡必須有密碼');

  // 清掉之後就不該再送出（免得在 YAML 留下一堆空殼）
  core.clearCredentials(srv);
  assert.ok(!buildSecrets()[srv], '清除後不該再送出這個伺服器');
});

check('非法 mode 归一为 none，其余字段保留', function () {
  core.saveCredentials('https://msn.feg.cn', { mode: 'bearer', token: 'tk_2' });
  assert.deepStrictEqual(core.loadCredentials('https://msn.feg.cn'),
    { mode: 'none', user: '', password: '', token: 'tk_2' });
  core.clearCredentials('https://msn.feg.cn');
});

check('憑證存在記憶體，不再寫 localStorage', function () {
  // 這個外掛刻意不使用 localStorage：設定的持久層只有宿主那一側的 YAML。
  // 因此設定／憑證在瀏覽器這一側只活在記憶體裡，重新整理就從 YAML 重建。
  core.saveCredentials('https://msn.feg.cn', { mode: 'basic', user: 'u', password: 'p' });
  assert.strictEqual(core.loadCredentials('https://msn.feg.cn').user, 'u',
    '記憶體內應該讀得到');
  // 就算外部環境有 localStorage，也不該被寫入任何 ntfy-teams 的 key。
  var store = globalThis.localStorage;
  if (store && typeof store.getItem === 'function') {
    assert.strictEqual(store.getItem('ntfy-teams:config:v1'), null,
      '不該把設定寫進 localStorage');
    assert.strictEqual(store.getItem('ntfy-teams:store:v1'), null,
      '不該把訊息快取寫進 localStorage');
    assert.strictEqual(store.getItem('ntfy-teams:cred:https://msn.feg.cn'), null,
      '不該把憑證寫進 localStorage');
  }
  core.clearCredentials('https://msn.feg.cn');
});


/* ====================================================== 8. describeError */

group('describeError —— 繁体中文（zh-TW）可读文案');

check('各类失败都有中文说明（401=凭据无效，403=需要认证）', function () {
  var cases = [
    [{ status: 401, authRequired: true }, '憑證無效'],
    [{ status: 401 }, '憑證無效'],
    [{ status: 403, authRequired: true }, '需要認證'],
    [{ status: 403 }, '需要認證'],
    [{ status: 0, authRequired: true }, '需要憑證'],
    [{ status: 404 }, '404'],
    [{ status: 429 }, '429'],
    [{ status: 503 }, '伺服器'],
    [{ status: 400, error: 'HTTP 400 · bad request' }, '請求失敗'],
    [{ status: 0, error: 'TypeError: fetch failed' }, '無法連線'],
    [null, '未知']
  ];
  cases.forEach(function (pair) {
    var text = core.describeError(pair[0]);
    assert.strictEqual(typeof text, 'string');
    assert.ok(text.length > 0, '不能返回空串');
    assert.ok(text.indexOf(pair[1]) !== -1, '期望包含「' + pair[1] + '」，实际：' + text);
    assert.ok(/[\u4e00-\u9fa5]/.test(text), '应包含中文：' + text);
  });
});

check('describeError 的输出是繁体（zh-TW），不得混入简体字', function () {
  // 只列「简体写法与繁体不同」的字；这些字一旦出现在使用者可见文案里就是漏转。
  // 注意：'查' / '使' / '用' 之类两体同形，绝不能放进来（会误判）。
  var SIMPLIFIED_ONLY = '发认凭证请设务连实时读环报题误闭检无关错见权账户国际间体档资讯开关连线';
  var results = [
    null,
    new Error('boom'),
    { status: 401, authRequired: true },
    { status: 403 },
    { status: 403, authRequired: true },
    { status: 404 },
    { status: 429 },
    { status: 500 },
    { status: 400, error: 'HTTP 400 · bad request' },
    { status: 0, error: 'TypeError: fetch failed' }
  ];
  results.forEach(function (input) {
    var text = core.describeError(input);
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      assert.strictEqual(SIMPLIFIED_ONLY.indexOf(ch), -1,
        '文案里出现简体字「' + ch + '」：' + text);
    }
  });
  // 订阅状态文案（store/UI 会直接显示）也必须是繁体
  [
    '伺服器位址為空',
    '伺服器回報自身不健康（healthy=false）',
    '目前環境不支援串流讀取（response.body 無法使用）',
    '即時接收中',
    '正在連線 ',
    '已連線',
    '已關閉',
    '連線已中斷',
    '伺服器已結束推送'
  ].forEach(function (expected) {
    for (var i = 0; i < expected.length; i++) {
      var ch = expected.charAt(i);
      assert.strictEqual(SIMPLIFIED_ONLY.indexOf(ch), -1, '简体字「' + ch + '」：' + expected);
    }
  });
});

/* ============================================== 9. Markdown（纯逻辑） */

/** 递归检查 block / inline 形状合法：任何未知节点、危险 href 都直接失败。 */
function assertWellFormed(blocks) {
  assert.ok(Array.isArray(blocks), 'blocks 必须是数组');
  blocks.forEach(function (block) {
    assert.ok(block && typeof block === 'object', 'block 必须是对象');
    switch (block.type) {
      case 'code':
        assert.strictEqual(typeof block.lang, 'string', 'code.lang 必须是字串');
        assert.strictEqual(typeof block.text, 'string', 'code.text 必须是字串');
        break;
      case 'heading':
        assert.ok(block.level >= 1 && block.level <= 3, 'heading.level 只能是 1..3，实际 ' + block.level);
        assertInlineShape(block.inline);
        break;
      case 'list':
        assert.strictEqual(typeof block.ordered, 'boolean', 'list.ordered 必须是布林');
        assert.ok(Array.isArray(block.items), 'list.items 必须是数组');
        block.items.forEach(assertInlineShape);
        break;
      case 'blockquote':
        assertWellFormed(block.blocks);
        break;
      case 'hr':
        break;
      case 'para':
        assertInlineShape(block.inline);
        break;
      default:
        assert.fail('未知 block type: ' + block.type);
    }
  });
}

/** 递归检查 inline 形状合法；link 的 href 必须过 http/https 白名单（安全断言）。 */
function assertInlineShape(inline) {
  assert.ok(Array.isArray(inline), 'inline 必须是数组');
  inline.forEach(function (node) {
    assert.ok(node && typeof node === 'object', 'inline 节点必须是对象');
    switch (node.type) {
      case 'text':
      case 'code':
        assert.strictEqual(typeof node.text, 'string', node.type + '.text 必须是字串');
        break;
      case 'strong':
      case 'em':
      case 'del':
        assertInlineShape(node.children);
        break;
      case 'link':
        assert.strictEqual(typeof node.href, 'string');
        assert.ok(/^https?:\/\//i.test(node.href), 'link.href 必须过白名单，实际：' + node.href);
        assertInlineShape(node.children);
        break;
      default:
        assert.fail('未知 inline type: ' + node.type);
    }
  });
}

/** 毫秒计时（优先用 hrtime）。 */
function nowMs() {
  if (typeof process !== 'undefined' && process.hrtime && process.hrtime.bigint) {
    return Number(process.hrtime.bigint()) / 1e6;
  }
  return Date.now();
}

group('parseMarkdown —— 块级：code / heading / list / blockquote / hr / para');

check('空 / null / undefined / 纯空白 → []（绝不抛异常）', function () {
  assert.deepStrictEqual(core.parseMarkdown(null), []);
  assert.deepStrictEqual(core.parseMarkdown(undefined), []);
  assert.deepStrictEqual(core.parseMarkdown(''), []);
  assert.deepStrictEqual(core.parseMarkdown('   \n\n \t \n'), []);
});

check('fenced code：语言标记 + 逐字保留（含空行与缩排）', function () {
  var blocks = core.parseMarkdown('```js\nvar a = 1;\n\n  indented\n```\n');
  assert.deepStrictEqual(blocks, [{ type: 'code', lang: 'js', text: 'var a = 1;\n\n  indented' }]);

  var noLang = core.parseMarkdown('```\nplain\n```');
  assert.strictEqual(noLang[0].lang, '', '没有语言标记时 lang 为空串');
  assert.strictEqual(noLang[0].text, 'plain');
});

check('未闭合 fence：一路吃到档尾', function () {
  assert.deepStrictEqual(core.parseMarkdown('```\nline1\nline2'), [
    { type: 'code', lang: '', text: 'line1\nline2' }
  ]);
  // fence 里的 ``` 不会自己乱配对：内容逐字保留
  assert.deepStrictEqual(core.parseMarkdown('```\na\n~~~\nb'), [
    { type: 'code', lang: '', text: 'a\n~~~\nb' }
  ]);
});

check('heading：# / ## / ###；#### 以上夹到 level 3', function () {
  assert.deepStrictEqual(core.parseMarkdown('# A'), [
    { type: 'heading', level: 1, inline: [{ type: 'text', text: 'A' }] }
  ]);
  assert.deepStrictEqual(core.parseMarkdown('## B'), [
    { type: 'heading', level: 2, inline: [{ type: 'text', text: 'B' }] }
  ]);
  assert.deepStrictEqual(core.parseMarkdown('### C'), [
    { type: 'heading', level: 3, inline: [{ type: 'text', text: 'C' }] }
  ]);
  assert.deepStrictEqual(core.parseMarkdown('#### D'), [
    { type: 'heading', level: 3, inline: [{ type: 'text', text: 'D' }] }
  ]);
  // '#hashtag'（没有空白）不是标题，是段落
  assert.deepStrictEqual(core.parseMarkdown('#hashtag'), [
    { type: 'para', inline: [{ type: 'text', text: '#hashtag' }] }
  ]);
});

check('list：无序（- * +）与有序（1. / 2)）', function () {
  var unordered = core.parseMarkdown('- a\n* b\n+ c');
  assert.strictEqual(unordered.length, 1, '连续项行应并成一个 list');
  assert.strictEqual(unordered[0].type, 'list');
  assert.strictEqual(unordered[0].ordered, false);
  assert.deepStrictEqual(unordered[0].items, [
    [{ type: 'text', text: 'a' }],
    [{ type: 'text', text: 'b' }],
    [{ type: 'text', text: 'c' }]
  ]);

  var ordered = core.parseMarkdown('1. one\n2) two');
  assert.strictEqual(ordered.length, 1);
  assert.strictEqual(ordered[0].ordered, true);
  assert.deepStrictEqual(ordered[0].items, [
    [{ type: 'text', text: 'one' }],
    [{ type: 'text', text: 'two' }]
  ]);

  // 空行结束列表；有序 / 无序不会并成同一块
  var split = core.parseMarkdown('- a\n\n1. b');
  assert.strictEqual(split.length, 2);
  assert.strictEqual(split[0].ordered, false);
  assert.strictEqual(split[1].ordered, true);

  var switched = core.parseMarkdown('- a\n1. b');
  assert.strictEqual(switched.length, 2, '有序性变了就是两个 list');
});

check('blockquote：连续 > 行；内容递归（列表 / code / hr）', function () {
  assert.deepStrictEqual(core.parseMarkdown('> hello\n> world'), [
    { type: 'blockquote', blocks: [{ type: 'para', inline: [{ type: 'text', text: 'hello\nworld' }] }] }
  ]);

  // 引用里的列表（契约明列的巢状案例）
  assert.deepStrictEqual(core.parseMarkdown('> - a\n> - b'), [
    {
      type: 'blockquote',
      blocks: [{
        type: 'list',
        ordered: false,
        items: [[{ type: 'text', text: 'a' }], [{ type: 'text', text: 'b' }]]
      }]
    }
  ]);

  // 引用里的 fence
  assert.deepStrictEqual(core.parseMarkdown('> ```js\n> code\n> ```'), [
    { type: 'blockquote', blocks: [{ type: 'code', lang: 'js', text: 'code' }] }
  ]);

  // 巢状引用
  assert.deepStrictEqual(core.parseMarkdown('> > deep'), [
    { type: 'blockquote', blocks: [{ type: 'blockquote', blocks: [{ type: 'para', inline: [{ type: 'text', text: 'deep' }] }] }] }
  ]);
});

check('hr：--- / *** / ___ / - - -', function () {
  ['---', '***', '___', '- - -', '* * *', '_ _ _', '----'].forEach(function (src) {
    assert.deepStrictEqual(core.parseMarkdown(src), [{ type: 'hr' }], src + ' 应该是 hr');
  });
  // 两个不够；'--' 是段落
  assert.deepStrictEqual(core.parseMarkdown('--'), [
    { type: 'para', inline: [{ type: 'text', text: '--' }] }
  ]);
});

check('para：连续非空行用 \\n 连接；空行分段；块级起始行分段', function () {
  assert.deepStrictEqual(core.parseMarkdown('a\nb\n\nc'), [
    { type: 'para', inline: [{ type: 'text', text: 'a\nb' }] },
    { type: 'para', inline: [{ type: 'text', text: 'c' }] }
  ]);
  assert.deepStrictEqual(core.parseMarkdown('text\n# heading'), [
    { type: 'para', inline: [{ type: 'text', text: 'text' }] },
    { type: 'heading', level: 1, inline: [{ type: 'text', text: 'heading' }] }
  ]);
  assert.deepStrictEqual(core.parseMarkdown('text\n- item'), [
    { type: 'para', inline: [{ type: 'text', text: 'text' }] },
    { type: 'list', ordered: false, items: [[{ type: 'text', text: 'item' }]] }
  ]);
});

group('parseMarkdown —— inline：优先序、巢状与安全');

check('code span 优先：** 在 code 内保持字面', function () {
  assert.deepStrictEqual(core.parseMarkdown('`**not bold**`'), [
    { type: 'para', inline: [{ type: 'code', text: '**not bold**' }] }
  ]);
  assert.deepStrictEqual(core.parseMarkdown('`[x](https://e.x)`'), [
    { type: 'para', inline: [{ type: 'code', text: '[x](https://e.x)' }] }
  ]);
});

check('strong / em / del（** __ * _ ~~）', function () {
  assert.deepStrictEqual(core.parseMarkdown('**b**'), [
    { type: 'para', inline: [{ type: 'strong', children: [{ type: 'text', text: 'b' }] }] }
  ]);
  assert.deepStrictEqual(core.parseMarkdown('__b__'), [
    { type: 'para', inline: [{ type: 'strong', children: [{ type: 'text', text: 'b' }] }] }
  ]);
  assert.deepStrictEqual(core.parseMarkdown('*i*'), [
    { type: 'para', inline: [{ type: 'em', children: [{ type: 'text', text: 'i' }] }] }
  ]);
  assert.deepStrictEqual(core.parseMarkdown('_i_'), [
    { type: 'para', inline: [{ type: 'em', children: [{ type: 'text', text: 'i' }] }] }
  ]);
  assert.deepStrictEqual(core.parseMarkdown('~~d~~'), [
    { type: 'para', inline: [{ type: 'del', children: [{ type: 'text', text: 'd' }] }] }
  ]);
});

check('巢状：**a *b* c**', function () {
  assert.deepStrictEqual(core.parseMarkdown('**a *b* c**'), [{
    type: 'para',
    inline: [{
      type: 'strong',
      children: [
        { type: 'text', text: 'a ' },
        { type: 'em', children: [{ type: 'text', text: 'b' }] },
        { type: 'text', text: ' c' }
      ]
    }]
  }]);
});

check('link：只有 http/https 变成 link 节点，label 内的 inline 照常解析', function () {
  assert.deepStrictEqual(core.parseMarkdown('[d](https://e.x)'), [
    { type: 'para', inline: [{ type: 'link', href: 'https://e.x', children: [{ type: 'text', text: 'd' }] }] }
  ]);
  assert.deepStrictEqual(core.parseMarkdown('[**b**](http://e.x)'), [{
    type: 'para',
    inline: [{
      type: 'link',
      href: 'http://e.x',
      children: [{ type: 'strong', children: [{ type: 'text', text: 'b' }] }]
    }]
  }]);
});

check('危险 / 相对 href 一律降级成字面文字，绝不产生 link 节点', function () {
  [
    '[x](javascript:alert(1))',
    '[x](JavaScript:alert(1))',
    '[x](vbscript:msgbox(1))',
    '[x](data:text/html;base64,PHNjcmlwdD4=)',
    '[x](file:///etc/passwd)',
    '[x](/relative/path)',
    '[x](ftp://host/f)',
    '[x]()',
    '[x](  )',
    '[x](https://e.x "title")',
    '[x](https://e.x\njavascript:alert(1))'
  ].forEach(function (src) {
    var blocks = core.parseMarkdown(src);
    assertWellFormed(blocks); // 内含 link.href 白名单断言
    var inline = blocks[0].inline;
    inline.forEach(function (node) {
      assert.notStrictEqual(node.type, 'link', '不应产生 link 节点：' + src);
    });
    assert.strictEqual(core.inlineToText(inline), src, '应原样降级成文字：' + src);
  });
});

check('原始 HTML 只会变成 text 节点（UI 用文字渲染，永远不会变元素）', function () {
  var src = '<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n<b>bold</b>';
  var blocks = core.parseMarkdown(src);
  assertWellFormed(blocks);
  assert.strictEqual(blocks.length, 1);
  blocks[0].inline.forEach(function (node) {
    assert.strictEqual(node.type, 'text', 'HTML 只能是 text 节点');
  });
  assert.strictEqual(core.inlineToText(blocks[0].inline), src);
});

check('inlineToText 摊平所有 inline 节点', function () {
  var inline = core.parseMarkdown('**粗**`码`[链](https://e.x)~~删~~*斜*')[0].inline;
  assert.strictEqual(core.inlineToText(inline), '粗码链删斜');
  assert.strictEqual(core.inlineToText(null), '');
  assert.strictEqual(core.inlineToText(undefined), '');
  assert.strictEqual(core.inlineToText('not an array'), '');
  assert.strictEqual(core.inlineToText([
    { type: 'strong', children: [{ type: 'text', text: 'a' }] },
    { type: 'unknown' },
    null,
    { type: 'code', text: 'b' }
  ]), 'ab', '未知节点忽略、不抛异常');
});

check('畸形输入永不抛异常，且形状永远合法', function () {
  var cases = [
    '**unterminated', 'a ` b', '[no close', '**a *b* c**', '`'.repeat(5000), '*'.repeat(5000),
    '['.repeat(5000), '[x](', '[x](javascript:alert(1))', '>'.repeat(3000), '#'.repeat(3000),
    'x'.repeat(10000), '~~~', '~~', '[]()', '[](https://e.x)', '``', '****', '____',
    '1. ', '- ', '+', '> ', '```', '_'.repeat(2001)
  ];
  cases.forEach(function (src) {
    var blocks = core.parseMarkdown(src);
    assertWellFormed(blocks);
    blocks.forEach(function (block) {
      core.inlineToText(block.inline || []);
    });
  });
});

check('乱数畸形输入（固定种子）：1500 组，永不抛异常 / 永不出现危险 link', function () {
  var alphabet = '`*_~[]()<>!#-+ abc\n>1.\\';
  var seed = 20260930;
  function next() {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  }
  for (var n = 0; n < 1500; n++) {
    var len = next() % 60;
    var text = '';
    for (var k = 0; k < len; k++) text += alphabet.charAt(next() % alphabet.length);
    var blocks = core.parseMarkdown(text);
    assertWellFormed(blocks);
  }
});

check('10k 字元的长行段落', function () {
  var src = 'x'.repeat(10000);
  var blocks = core.parseMarkdown(src);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].type, 'para');
  assert.strictEqual(core.inlineToText(blocks[0].inline), src);

  var longLine = new Array(10001).join('*a');
  assertWellFormed(core.parseMarkdown(longLine));
});

group('parseMarkdown —— 效能（100 KB 预算）');

check('100 KB 本文解析：多次取样取最小值 < 100 ms', function () {
  var chunk =
    '# 标题\n\n' +
    '段落一 **粗体** [链](https://msn.feg.cn/pub_x) 与 `代码`。\n\n' +
    '> - 引用里的列表\n> - 第二项\n\n' +
    '```js\nvar a = 1;\n```\n\n' +
    '---\n\n';
  var src = '';
  while (src.length < 100 * 1024) src += chunk;

  // 9 次取样取最小值：机器上常有其他行程（本 bundle 有多个 agent 同时跑 node），
  // 只有最小值才反映真正的算法成本；纯逻辑解析在空载机器上约 15~40 ms。
  var samples = [];
  var blocks = null;
  for (var i = 0; i < 9; i++) {
    var started = nowMs();
    blocks = core.parseMarkdown(src);
    samples.push(nowMs() - started);
  }
  assert.ok(blocks.length > 100, '应解析出多个块，实际 ' + blocks.length);
  assert.strictEqual(blocks[0].type, 'heading');

  var best = Math.min.apply(Math, samples);
  console.log('       ' + (src.length / 1024).toFixed(1) + ' KB → ' + blocks.length + ' blocks · 9 次取样 ' +
    samples.map(function (v) { return v.toFixed(1); }).join(' / ') + ' ms · 最小值 ' + best.toFixed(1) + ' ms');
  assert.ok(best < 100, '100 KB 解析最小值 ' + best.toFixed(1) + ' ms，超出 100 ms 预算');
});

/* ============================================ 10. 发送者身份（纯逻辑） */

group('发送者身份：parseIdentity / senderTitle / setIdentity / getIdentity');

check('parseIdentity：＃ 提及（含旧 @ 兼容）与普通标题', function () {
  assert.deepStrictEqual(core.parseIdentity('#shawoo'),
    { raw: '#shawoo', handle: 'shawoo', isMention: true });
  // 历史格式：用过 '@'，解析必须继续接受，否则旧主题的訊息会变成未具名。
  assert.deepStrictEqual(core.parseIdentity('@shawoo'),
    { raw: '@shawoo', handle: 'shawoo', isMention: true }, '旧 @ 格式仍要能解析');
  assert.deepStrictEqual(core.parseIdentity('標題測試'),
    { raw: '標題測試', handle: '', isMention: false });
  assert.deepStrictEqual(core.parseIdentity('  #shawoo  '),
    { raw: '  #shawoo  ', handle: 'shawoo', isMention: true });
  assert.deepStrictEqual(core.parseIdentity('#'),
    { raw: '#', handle: '', isMention: true });
  assert.deepStrictEqual(core.parseIdentity('hello #x'),
    { raw: 'hello #x', handle: '', isMention: false }, '不在开头的 # 不算提及');
  assert.deepStrictEqual(core.parseIdentity(''),
    { raw: '', handle: '', isMention: false });
  assert.deepStrictEqual(core.parseIdentity(null),
    { raw: '', handle: '', isMention: false });
  assert.deepStrictEqual(core.parseIdentity(undefined),
    { raw: '', handle: '', isMention: false });
});

check('senderTitle：空 → 空；自动加 #；幂等且永不 ##x；旧 @ 输入正規化成 #', function () {
  assert.strictEqual(core.senderTitle(''), '');
  assert.strictEqual(core.senderTitle(null), '');
  assert.strictEqual(core.senderTitle(undefined), '');
  assert.strictEqual(core.senderTitle('   '), '');
  assert.strictEqual(core.senderTitle('shawoo'), '#shawoo');
  assert.strictEqual(core.senderTitle('#shawoo'), '#shawoo', '#shawoo 必须幂等');
  assert.strictEqual(core.senderTitle(core.senderTitle('#shawoo')), '#shawoo', '两次调用仍幂等');
  assert.strictEqual(core.senderTitle('  shawoo  '), '#shawoo');
  assert.strictEqual(core.senderTitle('##shawoo'), '#shawoo', '绝不产生 ##x');
  assert.strictEqual(core.senderTitle('#'), '');
  // 旧的 '@' 仍然接受，但一律输出现行的 '#'
  assert.strictEqual(core.senderTitle('@shawoo'), '#shawoo', '旧 @ 输入要正規化成 #');
  assert.strictEqual(core.senderTitle('@@shawoo'), '#shawoo', '旧的重复 @ 也要收干净');
});

check('setIdentity / getIdentity 往返，且不破坏其它配置字段', function () {
  core.saveConfig({ server: 'msn.feg.cn', topics: ['t1'], historyLimit: 77 });

  assert.strictEqual(core.setIdentity('#shawoo'), 'shawoo', 'setIdentity 回传存进去的值');
  assert.strictEqual(core.getIdentity(), 'shawoo');
  assert.strictEqual(core.readConfig().identity, 'shawoo');

  var kept = core.readConfig();
  assert.strictEqual(kept.server, 'https://msn.feg.cn', 'server 不应被覆盖');
  assert.deepStrictEqual(kept.topics, ['t1'], 'topics 不应被覆盖');
  assert.strictEqual(kept.historyLimit, 77, 'historyLimit 不应被覆盖');

  assert.strictEqual(core.setIdentity('  阿豪  '), '阿豪');
  assert.strictEqual(core.getIdentity(), '阿豪');

  // saveConfig 只带 identity 的部分更新：其它字段必须原样保留
  core.saveConfig({ identity: '#bob' });
  var afterPartial = core.readConfig();
  assert.strictEqual(afterPartial.identity, 'bob');
  assert.deepStrictEqual(afterPartial.topics, ['t1']);
  assert.strictEqual(afterPartial.historyLimit, 77);
  assert.strictEqual(afterPartial.server, 'https://msn.feg.cn');

  // 旧格式存进来的值也要能读成纯名称
  core.saveConfig({ identity: '@legacy' });
  assert.strictEqual(core.getIdentity(), 'legacy', '旧的 @ 存档要读成纯名称');

  assert.strictEqual(core.setIdentity(''), '');
  assert.strictEqual(core.getIdentity(), '');
  assert.strictEqual(core.setIdentity(null), '');
  assert.strictEqual(core.getIdentity(), '');

  // 复原成预设，避免影响后面的用例
  core.saveConfig({ server: 'https://msn.feg.cn', topics: [], historyLimit: 300, identity: '' });
});

/* ============================================ 10a2. Markdown 表格 */

group('Markdown 表格（GFM）');

check('基本表格：抬头 + 分隔 + 资料列', function () {
  var blocks = core.parseMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |');
  assert.strictEqual(blocks.length, 1, '應只有一個區塊');
  assert.strictEqual(blocks[0].type, 'table');
  assert.strictEqual(blocks[0].head.length, 2);
  assert.strictEqual(blocks[0].rows.length, 1);
  assert.strictEqual(blocks[0].rows[0].length, 2, '每一列要和抬头同宽');
  assert.deepStrictEqual(blocks[0].align, ['', '']);
});

check('对齐标记 :-- / :-: / --:', function () {
  var t = core.parseMarkdown('| 左 | 中 | 右 |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |')[0];
  assert.deepStrictEqual(t.align, ['left', 'center', 'right']);
});

check('最外侧竖线可以省略', function () {
  var t = core.parseMarkdown('a | b\n--- | ---\n1 | 2')[0];
  assert.strictEqual(t.type, 'table');
  assert.strictEqual(t.head.length, 2);
  assert.strictEqual(t.rows.length, 1);
});

check('格数与抬头不一致时退化为普通段落（不误判）', function () {
  var blocks = core.parseMarkdown('| a | b |\n| --- |');
  assert.ok(blocks.every(function (b) { return b.type !== 'table'; }),
    '分隔列格数不符时不该当成表格，实际：' + JSON.stringify(blocks.map(function (b) { return b.type; })));
});

check('纯文字不会被误判成表格', function () {
  var blocks = core.parseMarkdown('没有表格\n只是段落');
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].type, 'para');
});

check('表格前后的段落都保留', function () {
  var blocks = core.parseMarkdown('前文\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n後文');
  assert.deepStrictEqual(blocks.map(function (b) { return b.type; }), ['para', 'table', 'para']);
});

check('格子里的行内标记照常解析', function () {
  var t = core.parseMarkdown('| **粗** | `code` |\n| --- | --- |\n| [x](https://a.b) | 3 |')[0];
  assert.strictEqual(t.head[0][0].type, 'strong');
  assert.strictEqual(t.rows[0][0][0].type, 'link');
  assert.strictEqual(t.rows[0][0][0].href, 'https://a.b');
});

check('少一格会补空，多一格会裁掉（保持矩形）', function () {
  var short = core.parseMarkdown('| a | b | c |\n| --- | --- | --- |\n| 1 |')[0];
  assert.strictEqual(short.rows[0].length, 3, '少一格要补到与抬头同宽');
  assert.deepStrictEqual(short.rows[0][1], [], '补的是空内容');
  var long = core.parseMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 | 3 |')[0];
  assert.strictEqual(long.rows[0].length, 2, '多一格要裁掉');
});

check('表格里的内容不会变成 HTML（安全底线）', function () {
  var t = core.parseMarkdown('| a |\n| --- |\n| <img src=x onerror=alert(1)> |')[0];
  var cell = t.rows[0][0];
  assert.strictEqual(cell.length, 1);
  assert.strictEqual(cell[0].type, 'text', '危险内容只能是文字节点');
  assert.ok(cell[0].text.indexOf('<img') !== -1);
});
/* ============================================ 10b. 主題別名（空 = 用主題名） */

group('主題別名：topicLabel / setTopicAlias（空別名 = 用主題名）');

check('topicLabel：沒有別名時回主題名', function () {
  core.saveConfig({ aliases: {} });
  assert.strictEqual(core.topicLabel('pub_demo'), 'pub_demo');
  assert.strictEqual(core.topicLabel('  pub_demo  '), 'pub_demo', '主題名應去空白');
  assert.strictEqual(core.topicLabel(''), '', '空主題名回空字串');
});

check('setTopicAlias：設定後 topicLabel 回別名，並寫進 config', function () {
  core.saveConfig({ aliases: {} });
  assert.strictEqual(core.setTopicAlias('pub_demo', '研發組'), '研發組');
  assert.strictEqual(core.topicLabel('pub_demo'), '研發組');
  assert.deepStrictEqual(core.readConfig().aliases, { pub_demo: '研發組' });
});

check('setTopicAlias 空字串／空白 = 清除別名，顯示回主題名', function () {
  core.setTopicAlias('pub_demo', '研發組');
  assert.strictEqual(core.setTopicAlias('pub_demo', ''), '', '清除應回空字串');
  assert.strictEqual(core.topicLabel('pub_demo'), 'pub_demo', '清掉後應回主題名');
  assert.deepStrictEqual(core.readConfig().aliases, {}, '空別名不該留在表裡');

  core.setTopicAlias('pub_demo', '再設一次');
  assert.strictEqual(core.setTopicAlias('pub_demo', '   '), '', '只有空白也算清除');
  assert.strictEqual(core.topicLabel('pub_demo'), 'pub_demo');
  assert.deepStrictEqual(core.readConfig().aliases, {});
});

check('setTopicAlias：非字串被忽略（不寫入垃圾）', function () {
  core.saveConfig({ aliases: {} });
  assert.strictEqual(core.setTopicAlias('t', 123), '', '數字別名應被忽略');
  assert.strictEqual(core.setTopicAlias('t', null), '');
  assert.strictEqual(core.setTopicAlias('t', {}), '');
  assert.deepStrictEqual(core.readConfig().aliases, {});
  assert.strictEqual(core.topicLabel('t'), 't');
});

check('別名表正規化：去空白、丟掉空值、主題名去空白', function () {
  core.saveConfig({ aliases: { ' a ': ' 甲 ', b: '', '  ': 'x', c: '丙' } });
  var aliases = core.readConfig().aliases;
  assert.deepStrictEqual(aliases, { a: '甲', c: '丙' }, '實際：' + JSON.stringify(aliases));
  assert.strictEqual(core.topicLabel('a'), '甲');
  assert.strictEqual(core.topicLabel('b'), 'b', '空別名的主題回主題名');
  assert.strictEqual(core.topicLabel('c'), '丙');
});

check('別名持久化：reload（重讀 config）後還在，且不破壞其它欄位', function () {
  core.saveConfig({
    server: 'msn.feg.cn', topics: ['t1'], historyLimit: 55, identity: '#me',
    aliases: { t1: '第一組' }
  });
  var cfg = core.readConfig();
  assert.strictEqual(cfg.server, 'https://msn.feg.cn');
  assert.deepStrictEqual(cfg.topics, ['t1']);
  assert.strictEqual(cfg.historyLimit, 55);
  assert.strictEqual(cfg.identity, 'me');
  assert.deepStrictEqual(cfg.aliases, { t1: '第一組' });
  assert.strictEqual(core.topicLabel('t1'), '第一組');

  // 只更新 server 時，別名不該被清掉
  core.saveConfig({ server: 'https://other.example' });
  assert.deepStrictEqual(core.readConfig().aliases, { t1: '第一組' }, '改 server 不該動到別名');
  assert.strictEqual(core.topicLabel('t1'), '第一組');

  // 整批替換
  assert.deepStrictEqual(core.setTopicAliases({ t1: '新名', t2: '二' }), { t1: '新名', t2: '二' });
  assert.strictEqual(core.topicLabel('t1'), '新名');
  assert.strictEqual(core.topicLabel('t2'), '二');

  core.saveConfig({ server: 'https://msn.feg.cn', topics: [], historyLimit: 300, identity: '', aliases: {} });
});

/* ============================================ 10d. 上次讀到哪（lastReadId） */

group('未讀的第二層提示：記錄「上次讀到哪一則」');

check('切到某主題不會清掉「讀到哪」，未讀數會歸零（捲動前還看得到未讀線）', function () {
  core.saveConfig({ aliases: {} });
  (core.store.getSnapshot().topics || []).slice().forEach(function (t) { core.store.removeTopic(t); });
  core.store.ensureTopic('rd_a');
  core.store.ensureTopic('rd_b');
  core.store.setActiveTopic('rd_b');
  core.store.addMessages('rd_b', [{ id: 'b1', time: 100 }], 'sse');
  assert.strictEqual(core.store.getSnapshot().lastReadIdByTopic.rd_b, 'b1',
    '看得到的主題：新訊息進來就等於讀到了');
  assert.strictEqual(core.store.getSnapshot().unreadByTopic.rd_b, 0, '正在看的主題不累加未讀');

  // rd_a 不是當前主題 → 累加未讀，且「讀到哪」不前進
  core.store.addMessages('rd_a', [{ id: 'a1', time: 101 }, { id: 'a2', time: 102 }], 'sse');
  assert.strictEqual(core.store.getSnapshot().unreadByTopic.rd_a, 2, '沒在看的主題要累加未讀');
  assert.strictEqual(core.store.getSnapshot().lastReadIdByTopic.rd_a, '', '沒在看就不該前進「讀到哪」');

  // 切過去：未讀歸零，但 lastReadId 還停在原點 —— 這正是可以捲的位置
  core.store.setActiveTopic('rd_a');
  assert.strictEqual(core.store.getSnapshot().unreadByTopic.rd_a, 0, '切過去後未讀歸零');
  assert.strictEqual(core.store.getSnapshot().lastReadIdByTopic.rd_a, '',
    '切過去還沒看到，lastReadId 不該被推進（否則就沒有未讀線可以捲）');

  // 使用者捲到未讀線 → 回報已看到
  core.store.markReadToLatest('rd_a');
  assert.strictEqual(core.store.getSnapshot().lastReadIdByTopic.rd_a, 'a2',
    '回報後應推進到最新一則');

  core.store.removeTopic('rd_a');
  core.store.removeTopic('rd_b');
});

check('「讀到哪」在同一 session 內保留，但不再跨重新整理（不再用 localStorage）', function () {
  // 舊行為：lastReadIdByTopic 會被寫進 localStorage，重開後還原。
  // 新行為：這個外掛不使用 localStorage，所以「讀到哪」只活在記憶體 ——
  // 重新整理後從頭開始（未讀線不會跨重新整理保留）。
  core.store.ensureTopic('rd_p2');
  if (core.store.setViewHooks) {
    core.store.setViewHooks({ isPanelVisible: function () { return true; } });
  }
  core.store.addMessage('rd_p2', { id: 'p1', time: 1, message: 'a' });
  core.store.setActiveTopic('rd_p2');
  core.store.addMessage('rd_p2', { id: 'p2', time: 2, message: 'b' });
  assert.strictEqual(core.store.getSnapshot().lastReadIdByTopic.rd_p2, 'p2',
    '同一個 session 內應該有記錄');

  // 對外不再提供持久化入口
  assert.strictEqual(core.store.persist, undefined, 'persist 應該已經移除');
  assert.strictEqual(core.store.loadPersisted, undefined, 'loadPersisted 應該已經移除');
  core.store.removeTopic('rd_p2');
});

check('移除主題時「讀到哪」一起清掉，不留孤兒', function () {
  (core.store.getSnapshot().topics || []).slice().forEach(function (t) { core.store.removeTopic(t); });
  core.store.ensureTopic('rd_x');
  core.store.setActiveTopic('rd_x');
  core.store.addMessages('rd_x', [{ id: 'x1', time: 300 }], 'sse');
  assert.strictEqual(core.store.getSnapshot().lastReadIdByTopic.rd_x, 'x1');
  core.store.removeTopic('rd_x');
  assert.strictEqual(core.store.getSnapshot().lastReadIdByTopic.rd_x, undefined,
    '移除後快照裡不該再有這個主題的 lastReadId');
});
/* ============================================ 10c. 取消訂閱後不得被「復活」 */

group('取消訂閱：已移除的主題不再收資料，也不會自己回來');

check('removeTopic 之後，迟到的 SSE 訊息不會讓主題復活', function () {
  core.saveConfig({ aliases: {} });
  (core.store.getSnapshot().topics || []).slice().forEach(function (t) { core.store.removeTopic(t); });
  core.store.ensureTopic('probe_live');
  core.store.ensureTopic('probe_keep');
  assert.deepStrictEqual(core.store.getSnapshot().topics, ['probe_live', 'probe_keep']);

  core.store.removeTopic('probe_live');
  assert.deepStrictEqual(core.store.getSnapshot().topics, ['probe_keep'], '移除後應只剩 probe_keep');

  // 订阅连线的收尾事件（伺服器在断线前还会送东西）
  var added = core.store.addMessages('probe_live', [
    { id: 'late-1', time: 1790756900, topic: 'probe_live', message: 'late arrival' }
  ], 'sse');
  assert.strictEqual(added, 0, '已取消的主題不該收到訊息');
  assert.deepStrictEqual(
    core.store.getSnapshot().topics,
    ['probe_keep'],
    '已取消的主題不該被訊息復活'
  );
  assert.strictEqual(
    (core.store.getSnapshot().messagesByTopic.probe_live || []).length,
    0,
    '已取消的主題不該留下訊息'
  );

  // 状态与认证回报同样不该复活
  core.store.setStatus('probe_live', { phase: 'error', detail: 'late' });
  core.store.setAuthRequired('probe_live', true);
  assert.deepStrictEqual(
    core.store.getSnapshot().topics,
    ['probe_keep'],
    '状态／认证回报也不該把主題復活'
  );

  // 未訂閱的主題本來就不收資料
  var ignored = core.store.addMessages('never_subscribed', [
    { id: 'x-1', time: 1790756901, topic: 'never_subscribed', message: 'nope' }
  ], 'sse');
  assert.strictEqual(ignored, 0, '從未訂閱的主題不該收訊息');
  assert.strictEqual(
    core.store.getSnapshot().topics.indexOf('never_subscribed'),
    -1,
    '從未訂閱的主題不該被建立'
  );

  // 重新訂閱後照常運作
  core.store.ensureTopic('probe_live');
  var readded = core.store.addMessages('probe_live', [
    { id: 'back-1', time: 1790756902, topic: 'probe_live', message: 'back' }
  ], 'sse');
  assert.strictEqual(readded, 1, '重新訂閱後應能正常收訊息');

  core.store.removeTopic('probe_live');
  core.store.removeTopic('probe_keep');
});

/* ============================================ 10e. 面板沒開也要收未讀 */

group('面板沒打開時，訊息要累加未讀（角標才有意義）');

check('面板不可見時，就算該主題是 activeTopic 也要算未讀', function () {
  core.saveConfig({ aliases: {} });
  (core.store.getSnapshot().topics || []).slice().forEach(function (t) { core.store.removeTopic(t); });
  core.store.ensureTopic('bg_a');
  core.store.setActiveTopic('bg_a');

  // 面板顯示著：訊息進來算「看到」，不累加
  viewing(true);
  core.store.addMessages('bg_a', [{ id: 'v1', time: 300 }], 'sse');
  assert.strictEqual(core.store.getSnapshot().unreadByTopic.bg_a, 0, '看得到時不該累加未讀');
  assert.strictEqual(core.store.getSnapshot().lastReadIdByTopic.bg_a, 'v1', '看得到時應推進讀到哪');

  // 面板被切走（host 把面板從 DOM 移除）：activeTopic 還是 bg_a，但人已經不看了
  viewing(false);
  core.store.addMessages('bg_a', [{ id: 'v2', time: 301 }, { id: 'v3', time: 302 }], 'sse');
  assert.strictEqual(core.store.getSnapshot().unreadByTopic.bg_a, 2,
    '面板不在時，就算是 activeTopic 也要累加未讀（否則角標永遠不動）');
  assert.strictEqual(core.store.getSnapshot().lastReadIdByTopic.bg_a, 'v1',
    '面板不在時不該推進「讀到哪」');

  // 回到面板：未讀歸零、讀到哪繼續前進
  viewing(true);
  core.store.setActiveTopic('bg_a');
  assert.strictEqual(core.store.getSnapshot().unreadByTopic.bg_a, 0, '回到面板後未讀歸零');
  core.store.markReadToLatest('bg_a');
  assert.strictEqual(core.store.getSnapshot().lastReadIdByTopic.bg_a, 'v3', '回報後推進到最新');

  core.store.removeTopic('bg_a');
  viewing(true);
});

/* ============================================ 10f. 日復盤材料（buildDayReview） */

group('日復盤材料：把一天的訊息收斂成一段可送出的文字');

check('正常情况：主題、日期、訊息數、每一則都在', function () {
  var r = core.buildDayReview({
    topic: 'pub_demo',
    label: '今天',
    entries: [
      { name: '#alice', clock: '10:24', text: '進度我放上去了' },
      { name: '#bob', clock: '10:26', text: '收到' }
    ],
    notes: ['請幫我整理：', '1. 重點？']
  });
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.title, '今天 復盤');
  assert.ok(r.body.indexOf('pub_demo') !== -1, '應提到主題');
  assert.ok(r.body.indexOf('今天') !== -1, '應提到日期');
  assert.ok(r.body.indexOf('#alice') !== -1 && r.body.indexOf('10:24') !== -1, '應有發送者與時間');
  assert.ok(r.body.indexOf('收到') !== -1, '應有內文');
  assert.ok(r.body.indexOf('1. 重點？') !== -1, '應帶上附加指示');
});

check('空的一天也要能送（不能生出 undefined）', function () {
  var r = core.buildDayReview({ topic: 'pub_demo', label: '昨天', entries: [] });
  assert.strictEqual(r.count, 0);
  assert.ok(r.body.indexOf('沒有訊息') !== -1, '應說明沒有訊息');
  assert.ok(r.body.indexOf('undefined') === -1, '不該出現 undefined');
});

check('畸形输入不抛异常、不产出 undefined／null 字串', function () {
  var inputs = [
    null, undefined, {}, 'not an object', 42,
    { topic: null, label: 123, entries: 'nope' },
    { topic: '  ', label: '', entries: [null, undefined, 1, 'x', {}] },
    { topic: 'a', label: 'b', entries: [{ name: null, clock: 7, text: null }] },
    { topic: 'a', label: 'b', entries: [{ name: 'x', clock: 'y', text: 'z' }], notes: 'not array' }
  ];
  inputs.forEach(function (input) {
    var r;
    assert.doesNotThrow(function () { r = core.buildDayReview(input); }, '不該抛异常：' + JSON.stringify(input));
    assert.ok(r && typeof r.body === 'string', 'body 必須是字串');
    assert.strictEqual(r.body.indexOf('undefined'), -1, 'body 不該含 undefined：' + r.body);
    assert.strictEqual(r.body.indexOf('null'), -1, 'body 不該含 null：' + r.body);
  });
});

check('内文换行会被收成一行（一則一列，清單不會被打散）', function () {
  var r = core.buildDayReview({
    topic: 't',
    label: '今天',
    entries: [{ name: '#a', clock: '09:00', text: '第一行\n第二行\n\n第四行' }]
  });
  var bullet = r.body.split('\n').filter(function (l) { return l.indexOf('**#a**') !== -1; });
  assert.strictEqual(bullet.length, 1, '一則訊息只該佔一列，實際：' + JSON.stringify(bullet));
  assert.ok(bullet[0].indexOf('第一行 第二行 第四行') !== -1, '換行應被收成空白：' + bullet[0]);
});

check('沒有內文的訊息標成（無內文），不會留下空尾巴', function () {
  var r = core.buildDayReview({ topic: 't', label: '今天', entries: [{ name: '--', clock: '', text: '' }] });
  assert.ok(r.body.indexOf('（無內文）') !== -1, '實際：' + r.body);
});
/* ============================================ 10g. 群組語意：決定／待辦 */

group('群組語意：決定與待辦（走原生 Tags，全群可見）');

/** 造一則測試訊息。 */
function mkMsg(id, time, tags, message, title) {
  return { id: id, time: time, topic: 'g', tags: tags, message: message, title: title || '#alice' };
}

check('只認得 decision／action／done，其餘標籤不受影響', function () {
  assert.deepStrictEqual(core.markerTagsOf({ tags: ['Decision', '隨便', 'done', 'ACTION'] }),
    ['decision', 'done', 'action']);
  assert.deepStrictEqual(core.markerTagsOf({ tags: ['urgent', 'ok'] }), []);
  assert.deepStrictEqual(core.markerTagsOf({}), []);
  assert.deepStrictEqual(core.markerTagsOf(null), []);
  assert.deepStrictEqual(core.markerTagsOf({ tags: 'decision' }), [], '非陣列不該爆');
});

check('標記內文：#<目標 id> 或 #<目標 id> 說明', function () {
  assert.strictEqual(core.markerBody('m1', ''), '#m1');
  assert.strictEqual(core.markerBody('m1', '備註'), '#m1 備註');
  assert.strictEqual(core.markerBody('', 'x'), '');
});

check('推導出決定與待辦，並算未結案數', function () {
  var list = [
    mkMsg('m1', 100, null, '用 snake_case'),
    mkMsg('m2', 200, ['decision'], '#m1 欄位命名定 snake_case'),
    mkMsg('m3', 300, null, '誰去改 config'),
    mkMsg('m4', 400, ['action'], '#m3 @米林 改 config'),
    mkMsg('m5', 500, ['action'], '#m1 補文件')
  ];
  var r = core.deriveMarkers(list);
  assert.strictEqual(r.decisions.length, 1);
  assert.strictEqual(r.decisions[0].id, 'm1');
  assert.strictEqual(r.decisions[0].text, '欄位命名定 snake_case');
  assert.strictEqual(r.actions.length, 2);
  assert.strictEqual(r.openCount, 2);
});

check('結案只結那一筆，同一則原始訊息的其他待辦不受影響', function () {
  var list = [
    mkMsg('m1', 100, null, '用 snake_case'),
    mkMsg('m4', 400, ['action'], '#m1 補文件'),
    mkMsg('m5', 500, ['action'], '#m1 改註解'),
    mkMsg('m6', 600, ['done'], '#m4')
  ];
  var r = core.deriveMarkers(list);
  assert.strictEqual(r.actions.length, 2, '兩個待辦都該還在');
  var a4 = r.actions.filter(function (a) { return a.markerId === 'm4'; })[0];
  var a5 = r.actions.filter(function (a) { return a.markerId === 'm5'; })[0];
  assert.strictEqual(a4.done, true, '被指到的應該結案');
  assert.strictEqual(a5.done, false, '沒被指到的不該跟著結案');
  assert.strictEqual(r.openCount, 1);
});

check('順序不影響結果（先後雜亂也能算對）', function () {
  var list = [
    mkMsg('m6', 600, ['done'], '#m4'),
    mkMsg('m4', 400, ['action'], '#m1 補文件'),
    mkMsg('m1', 100, null, 'x')
  ];
  var r = core.deriveMarkers(list);
  assert.strictEqual(r.openCount, 0, '排序後 done 在後，應結案');
});

check('重複標記同一則只算一次', function () {
  var list = [
    mkMsg('m1', 100, null, 'x'),
    mkMsg('m2', 200, ['decision'], '#m1 第一次'),
    mkMsg('m3', 300, ['decision'], '#m1 第二次')
  ];
  var r = core.deriveMarkers(list);
  assert.strictEqual(r.decisions.length, 1, '同一目標只記一次');
  assert.strictEqual(r.decisions[0].text, '第一次', '保留最早的那次');
});

check('畸形輸入不抛异常', function () {
  assert.doesNotThrow(function () { core.deriveMarkers(null); });
  assert.doesNotThrow(function () { core.deriveMarkers('x'); });
  var r = core.deriveMarkers([null, 1, 'x', {}, { tags: ['decision'] }, { tags: ['action'], message: '' }]);
  assert.strictEqual(r.decisions.length, 0, '沒有目標 id 的標記要忽略');
  assert.strictEqual(r.actions.length, 0);
  assert.strictEqual(r.openCount, 0);
});
/* ============================================ 10h. 側欄健康狀態 */

group('側欄健康狀態：把多個主題的連線收斂成一個結論');

/** 造一份 store 快照。 @param o - 覆写欄位。 @returns 快照。 */
function healthSnap(o) {
  return {
    topics: [], statusByTopic: {}, unreadByTopic: {}, authByTopic: {},
    ...(o || {})
  };
}

check('沒有訂閱 → idle「尚未訂閱主題」', function () {
  const h = core.sidebarHealth(healthSnap());
  assert.strictEqual(h.state, 'idle');
  assert.ok(h.label.indexOf('尚未訂閱') !== -1, h.label);
});

check('全部連線且無未讀 → live「已連線」（不是 idle「閒置」）', function () {
  const h = core.sidebarHealth(healthSnap({
    topics: ['a'], statusByTopic: { a: { phase: 'open' } }
  }));
  // 這裡刻意不叫 idle：SSE 正常掛著跟「什麼都沒訂閱」必須分得出來，
  // 否則使用者會以為沒在用 SSE（實測被問過「為什麼會有閒置狀態」）。
  assert.strictEqual(h.state, 'live');
  assert.strictEqual(h.label, '已連線');
  assert.ok(h.detail.indexOf('SSE') !== -1, '說明要點出 SSE：' + h.detail);
});

check('沒有訂閱任何主題 → idle（這才是真的「什麼都沒有」）', function () {
  const h = core.sidebarHealth(healthSnap({ topics: [] }));
  assert.strictEqual(h.state, 'idle');
  assert.strictEqual(h.label, '尚未訂閱主題');
});

check('有未讀 → unread，並帶出總數', function () {
  const h = core.sidebarHealth(healthSnap({
    topics: ['a', 'b'],
    statusByTopic: { a: { phase: 'open' }, b: { phase: 'open' } },
    unreadByTopic: { a: 2, b: 3 }
  }));
  assert.strictEqual(h.state, 'unread');
  assert.strictEqual(h.unread, 5);
  assert.strictEqual(h.label, '5 則新訊息');
});

check('連線中 → connecting（部分時標出比例）', function () {
  const h = core.sidebarHealth(healthSnap({
    topics: ['a', 'b'],
    statusByTopic: { a: { phase: 'open' }, b: { phase: 'connecting' } }
  }));
  assert.strictEqual(h.state, 'connecting');
  assert.ok(h.label.indexOf('1／2') !== -1, h.label);
});

check('斷線 → offline（部分／全部說法不同）', function () {
  const part = core.sidebarHealth(healthSnap({
    topics: ['a', 'b'],
    statusByTopic: { a: { phase: 'open' }, b: { phase: 'closed' } }
  }));
  assert.strictEqual(part.state, 'offline');
  assert.strictEqual(part.offlineTopics, 1);
  assert.ok(part.label.indexOf('1 個主題未連線') !== -1, part.label);

  const all = core.sidebarHealth(healthSnap({
    topics: ['a', 'b'],
    statusByTopic: { a: { phase: 'closed' }, b: { phase: 'closed' } }
  }));
  assert.strictEqual(all.label, '未連線');
});

check('錯誤 → error，且優先於其他狀態', function () {
  const h = core.sidebarHealth(healthSnap({
    topics: ['a', 'b'],
    statusByTopic: { a: { phase: 'open' }, b: { phase: 'error' } },
    // 有未讀、也有斷線，但錯誤最重要
    unreadByTopic: { a: 9 }
  }));
  assert.strictEqual(h.state, 'error', '錯誤必須蓋過未讀');
  assert.strictEqual(h.errorTopics, 1);
  assert.strictEqual(h.unread, 9, '數字仍要算出來，只是不當標題');
});

check('優先序：錯誤 > 斷線 > 連線中 > 未讀 > 正常', function () {
  /** @param o - 覆写。 @returns 狀態。 */
  const pick = (o) => core.sidebarHealth(healthSnap(o)).state;

  // 全部狀態同時存在時，最嚴重的那個勝出
  assert.strictEqual(pick({
    topics: ['a', 'b', 'c', 'd'],
    statusByTopic: {
      a: { phase: 'error' }, b: { phase: 'closed' },
      c: { phase: 'connecting' }, d: { phase: 'open' }
    },
    unreadByTopic: { d: 3 }
  }), 'error', '錯誤最優先，且要蓋過未讀');

  // 逐一移除最嚴重的狀態，看它是不是按順序讓位
  assert.strictEqual(pick({
    topics: ['b', 'c', 'd'],
    statusByTopic: { b: { phase: 'closed' }, c: { phase: 'connecting' }, d: { phase: 'open' } },
    unreadByTopic: { d: 3 }
  }), 'offline', '沒有錯誤時，斷線最優先');

  assert.strictEqual(pick({
    topics: ['c', 'd'],
    statusByTopic: { c: { phase: 'connecting' }, d: { phase: 'open' } },
    unreadByTopic: { d: 3 }
  }), 'connecting', '沒有斷線時，連線中最優先（即使有未讀）');

  assert.strictEqual(pick({
    topics: ['d'],
    statusByTopic: { d: { phase: 'open' } },
    unreadByTopic: { d: 3 }
  }), 'unread', '都連上之後才輪到未讀');

  assert.strictEqual(pick({
    topics: ['d'],
    statusByTopic: { d: { phase: 'open' } },
    unreadByTopic: {}
  }), 'live', '沒有未讀就是「已連線」（健康）');
});

check('離線優先於連線中：一條斷了比一條還在撥號更該被看見', function () {
  const h = core.sidebarHealth(healthSnap({
    topics: ['a', 'b'],
    statusByTopic: { a: { phase: 'closed' }, b: { phase: 'connecting' } }
  }));
  assert.strictEqual(h.state, 'offline');
  assert.strictEqual(h.offlineTopics, 1);
  assert.strictEqual(h.connectingTopics, 1, '連線中的數量還是要算出來');
});

check('狀態可以是字串（normalizeStatus 允許）', function () {
  const h = core.sidebarHealth(healthSnap({
    topics: ['a'], statusByTopic: { a: 'error' }
  }));
  assert.strictEqual(h.state, 'error');
});

check('畸形輸入不抛，且欄位齊全', function () {
  const inputs = [null, undefined, 42, 'x', [], {},
    { topics: 'x', statusByTopic: null, unreadByTopic: 'y' },
    { topics: ['a'], statusByTopic: { a: null }, unreadByTopic: { a: -5 } }];
  inputs.forEach(function (input) {
    let h;
    assert.doesNotThrow(function () { h = core.sidebarHealth(input); }, '不該抛：' + JSON.stringify(input));
    assert.strictEqual(typeof h.state, 'string');
    assert.strictEqual(typeof h.label, 'string');
    assert.strictEqual(typeof h.detail, 'string');
    assert.strictEqual(typeof h.unread, 'number');
    assert.strictEqual(h.label.indexOf('undefined'), -1, '標題不該含 undefined');
  });
});

check('負數與非數字未讀不算進總數', function () {
  const h = core.sidebarHealth(healthSnap({
    topics: ['a', 'b', 'c'],
    statusByTopic: { a: { phase: 'open' }, b: { phase: 'open' }, c: { phase: 'open' } },
    unreadByTopic: { a: -5, b: 'abc', c: 4 }
  }));
  assert.strictEqual(h.unread, 4);
});

/* ============================================ 10i. 錯誤訊息要給人看 */

group('錯誤訊息：不把伺服器原始 JSON 丟給使用者');

// 這是使用者實際看到的字串（ntfy 的 429 回應）。
const RAW_429 = 'HTTP 429 · {"code":42901,"http":429,"error":"limit reached: too many requests",'
  + '"link":"https://ntfy.sh/docs/publish/#limitations"}';

check('429：翻成繁體中文，且不含伺服器原始 JSON', function () {
  const msg = core.describeError({ status: 429, error: RAW_429 });
  assert.ok(msg.indexOf('429') !== -1, '要保留狀態碼，方便追查：' + msg);
  assert.ok(msg.indexOf('請求過於頻繁') !== -1, '要是人看得懂的話：' + msg);
  assert.strictEqual(msg.indexOf('"code"'), -1, '不該出現原始 JSON：' + msg);
  assert.strictEqual(msg.indexOf('ntfy.sh/docs'), -1, '不該出現原始連結：' + msg);
});

check('401／403／404／5xx 都有對應文案', function () {
  const cases = [
    { status: 401, want: '認證失敗' },
    { status: 403, want: '需要認證' },
    { status: 404, want: '404' },
    { status: 500, want: '伺服器內部錯誤' },
    { status: 503, want: '伺服器內部錯誤' }
  ];
  cases.forEach(function (c) {
    const msg = core.describeError({ status: c.status, error: 'raw' });
    assert.ok(msg.indexOf(c.want) !== -1, c.status + ' 應含「' + c.want + '」，實際：' + msg);
  });
});

check('連不上（status 0）也有可讀說明', function () {
  const msg = core.describeError({ status: 0, error: 'TypeError: Failed to fetch' });
  assert.ok(msg.indexOf('無法連線') !== -1, msg);
});

check('其他狀態碼仍保留細節（那是真的有用）', function () {
  const msg = core.describeError({ status: 418, error: 'teapot' });
  assert.ok(msg.indexOf('418') !== -1 && msg.indexOf('teapot') !== -1, msg);
});

check('畸形輸入不抛', function () {
  [null, undefined, 42, 'x', {}, { status: 'abc' }, { status: -1 }].forEach(function (v) {
    let msg;
    assert.doesNotThrow(function () { msg = core.describeError(v); }, JSON.stringify(v));
    assert.strictEqual(typeof msg, 'string');
    assert.ok(msg.length > 0);
  });
});

/* ============================================ 10j. 訂閱主題上限 */

group('訂閱上限：最多 5 個主題');

check('上限就是 8，且從正式 API 物件拿得到', function () {
  // 一定要用 moduleRoot() 的回傳值。
  //
  // require() 回傳的那一份是「快照」：它的鍵是在 moduleRoot() 建立真正的 API
  // **之前**就列舉好的，所以從快照讀**常數欄位**會拿到 undefined（實測踩過）。
  // 函式欄位沒這個問題（它們是各自獨立定義的），所以只有常數要用 moduleRoot()。
  var api = require('../lib/core.js').moduleRoot();
  assert.strictEqual(api.MAX_TOPICS, 8);
  // 兩份共用同一批函式，所以 canSubscribe 從哪一份拿都是同一個
  assert.strictEqual(core.canSubscribe, api.canSubscribe, '兩份應指向同一個函式');
});

check('未滿 8 個可以加', function () {
  var r = core.canSubscribe(['a', 'b', 'c', 'd'], 'e');
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.limit, 8);
  assert.strictEqual(r.count, 4);
});

check('第 9 個被擋，且說明可讀', function () {
  var r = core.canSubscribe(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 'i');
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.indexOf('8') !== -1, '要說出上限：' + r.reason);
  assert.ok(r.reason.indexOf('取消') !== -1, '要告訴使用者怎麼辦：' + r.reason);
});

check('重複訂閱既有主題不算新增（不該被擋）', function () {
  var r = core.canSubscribe(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 'c');
  assert.strictEqual(r.ok, true, '同一主題重複點不該被上限擋住');
});

check('空名稱被擋', function () {
  ['', '   ', null, undefined].forEach(function (v) {
    var r = core.canSubscribe(['a'], v);
    assert.strictEqual(r.ok, false, '空名稱應被拒：' + JSON.stringify(v));
    assert.ok(r.reason);
  });
});

check('畸形清單不抛', function () {
  [null, undefined, 'x', 42, {}].forEach(function (list) {
    var r;
    assert.doesNotThrow(function () { r = core.canSubscribe(list, 'a'); }, JSON.stringify(list));
    assert.strictEqual(typeof r.ok, 'boolean');
    assert.strictEqual(r.limit, 8);
  });
});

check('名稱會先正規化再比對（避免用空白繞過上限）', function () {
  // normalizeTopic 會 trim；"  a  " 應該被視為既有的 "a"
  var r = core.canSubscribe(['a', 'b', 'c', 'd', 'e'], '  a  ');
  assert.strictEqual(r.ok, true, '正規化後是既有主題，不該算新增');
});

/* ============================================ 10k. 預設訂閱主題 */

group('預設訂閱主題：pub_dsh / AIFE');

check('常數存在且是 pub_ 開頭（免認證）', function () {
  var api = require('../lib/core.js').moduleRoot();
  assert.strictEqual(api.DEFAULT_TOPIC, 'pub_dsh');
  assert.strictEqual(api.DEFAULT_TOPIC_ALIAS, 'AIFE');
  assert.ok(/^pub_/.test(api.DEFAULT_TOPIC), '預設主題必須免認證，否則新使用者一開就 403');
});

/* ================================================= 11. 网络层（stub fetch） */

var realFetch = globalThis.fetch;

/** 用假 fetch 替换全局 fetch，返回记录数组。 */
function stubFetch(handler) {
  var calls = [];
  globalThis.fetch = function (input, init) {
    var record = {
      url: String(input),
      method: init && init.method ? init.method : 'GET',
      init: init || {},
      headers: (init && init.headers) || {}
    };
    calls.push(record);
    return Promise.resolve(handler(record));
  };
  return calls;
}

function fakeResponse(options) {
  var status = options.status;
  return {
    ok: status >= 200 && status < 300,
    status: status,
    headers: { get: function (name) { return (options.headers || {})[String(name).toLowerCase()] || null; } },
    text: function () { return Promise.resolve(options.body === undefined ? '' : options.body); },
    body: options.bodyStream || null
  };
}

function textEncoder() {
  return new TextEncoder();
}

(async function networkLayer() {
  group('网络层（stub globalThis.fetch，零网络）');

  await acheck('publishMessage 默认用「纯文本体 + 元数据头」（实测可用形态）', async function () {
    var calls = stubFetch(function () {
      return fakeResponse({
        status: 200,
        body: '{"id":"new1","time":100,"event":"message","topic":"pub_demo","message":"hello",' +
          '"title":"T","priority":4,"tags":["a","b"]}'
      });
    });
    var result = await core.publishMessage('msn.feg.cn', 'pub_demo', {
      message: 'hello', title: 'T', priority: 4, tags: ['a', 'b'], cred: { mode: 'none' }
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://msn.feg.cn/pub_demo');
    assert.strictEqual(calls[0].method, 'POST');
    assert.strictEqual(calls[0].init.body, 'hello', 'body 必须是纯文本消息本身');
    assert.strictEqual(calls[0].headers['Content-Type'], 'text/plain; charset=utf-8');
    assert.strictEqual(calls[0].headers.Title, 'T');
    assert.strictEqual(calls[0].headers.Priority, '4');
    assert.strictEqual(calls[0].headers.Tags, 'a,b');
    assert.strictEqual('Authorization' in calls[0].headers, false);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.message.id, 'new1');
    assert.strictEqual(result.message.title, 'T');
    return 'body=' + JSON.stringify(calls[0].init.body);
  });

  await acheck('publishMessage 空 title/priority/tags/click 时不发对应头', async function () {
    var calls = stubFetch(function () {
      return fakeResponse({ status: 200, body: '{"id":"new2","time":101,"topic":"pub_demo","message":"hi"}' });
    });
    var result = await core.publishMessage('https://msn.feg.cn', 'pub_demo', { message: 'hi' });
    assert.strictEqual(result.ok, true);
    ['Title', 'Priority', 'Tags', 'Click'].forEach(function (header) {
      assert.strictEqual(header in calls[0].headers, false, '不应发送 ' + header);
    });
  });

  await acheck('publishMessage opts.json=true → 契约的 JSON 体形态', async function () {
    var calls = stubFetch(function () {
      return fakeResponse({ status: 200, body: '{"id":"new3","time":102,"topic":"pub_demo","message":"hi"}' });
    });
    await core.publishMessage('https://msn.feg.cn', 'pub_demo', {
      message: 'hi', title: 'T', priority: 5, cred: { mode: 'token', token: 'tk_1' }, json: true
    });
    assert.strictEqual(calls[0].headers['Content-Type'], 'application/json');
    assert.strictEqual(calls[0].headers.Authorization, 'Bearer tk_1');
    var body = JSON.parse(calls[0].init.body);
    assert.deepStrictEqual(body, { topic: 'pub_demo', message: 'hi', title: 'T', priority: 5 });
  });

  await acheck('publishMessage 失败不抛异常（403 → ok:false）', async function () {
    stubFetch(function () {
      return fakeResponse({ status: 403, body: '{"code":40301,"error":"forbidden"}' });
    });
    var result = await core.publishMessage('https://msn.feg.cn', 'private', { message: 'x' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 403);
    assert.ok(result.error.indexOf('403') !== -1, result.error);
    assert.strictEqual(result.message, null);
  });

  await acheck('publishMessage 网络异常 → ok:false / status:0', async function () {
    globalThis.fetch = function () { return Promise.reject(new TypeError('fetch failed')); };
    var result = await core.publishMessage('https://msn.feg.cn', 'pub_demo', { message: 'x' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 0);
    assert.ok(result.error.indexOf('fetch failed') !== -1, result.error);
  });

  await acheck('fetchTopicMessages 200 → 解析 JSON lines', async function () {
    var calls = stubFetch(function () {
      return fakeResponse({ status: 200, body: REAL_HISTORY_LINE + '\n' + REAL_SSE_MESSAGE_BLOCK });
    });
    var result = await core.fetchTopicMessages('msn.feg.cn', 'pub_dshteamtest', { cred: { mode: 'none' } });
    assert.strictEqual(calls[0].url, 'https://msn.feg.cn/pub_dshteamtest/json?poll=1&since=all');
    assert.strictEqual(calls[0].method, 'GET');
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.error, null);
    assert.strictEqual(result.authRequired, false);
    assert.deepStrictEqual(result.messages.map(function (m) { return m.id; }),
      ['1jLfaNcFIDCe', 'yIr1fBunlw3L']);
    assert.strictEqual(result.messages[0].source, 'history');
  });

  await acheck('fetchTopicMessages limit 只留最新 N 条', async function () {
    stubFetch(function () {
      return fakeResponse({
        status: 200,
        body: [
          '{"id":"a","time":1,"event":"message","topic":"t"}',
          '{"id":"b","time":2,"event":"message","topic":"t"}',
          '{"id":"c","time":3,"event":"message","topic":"t"}'
        ].join('\n')
      });
    });
    var result = await core.fetchTopicMessages('https://msn.feg.cn', 't', { limit: 2 });
    assert.deepStrictEqual(result.messages.map(function (m) { return m.id; }), ['b', 'c']);
  });

  await acheck('fetchTopicMessages 403（无凭据）→ authRequired:true 且不抛异常', async function () {
    var calls = stubFetch(function () {
      return fakeResponse({ status: 403, body: '{"code":40301,"http":403,"error":"forbidden"}' });
    });
    var result = await core.fetchTopicMessages('https://msn.feg.cn', 'dshteamtest', { cred: { mode: 'none' } });
    assert.strictEqual(result.status, 403);
    assert.strictEqual(result.authRequired, true);
    assert.deepStrictEqual(result.messages, []);
    assert.ok(result.error.indexOf('403') !== -1);
    assert.strictEqual('Authorization' in calls[0].headers, false, '未配置凭据时不应带 Authorization');
    assert.ok(core.describeError(result).indexOf('需要認證') !== -1);
  });

  await acheck('fetchTopicMessages 401（凭据错误）→ authRequired:true', async function () {
    var calls = stubFetch(function () {
      return fakeResponse({ status: 401, body: '{"code":40101,"http":401,"error":"unauthorized"}' });
    });
    var result = await core.fetchTopicMessages('https://msn.feg.cn', 'dshteamtest', {
      cred: { mode: 'basic', user: 'u', password: 'wrong' }
    });
    assert.strictEqual(result.status, 401);
    assert.strictEqual(result.authRequired, true);
    assert.strictEqual(calls[0].headers.Authorization, 'Basic ' + Buffer.from('u:wrong').toString('base64'));
    assert.ok(core.describeError(result).indexOf('憑證無效') !== -1);
  });

  await acheck('testConnection 200 {"healthy":true} → ok:true', async function () {
    var calls = stubFetch(function () { return fakeResponse({ status: 200, body: '{"healthy":true}' }); });
    var result = await core.testConnection('msn.feg.cn');
    assert.strictEqual(calls[0].url, 'https://msn.feg.cn/v1/health');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.error, null);
  });

  await acheck('testConnection healthy:false → ok:false', async function () {
    stubFetch(function () { return fakeResponse({ status: 200, body: '{"healthy":false}' }); });
    var result = await core.testConnection('https://msn.feg.cn');
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.indexOf('healthy') !== -1, result.error);
  });

  await acheck('testConnection 网络异常 → ok:false / status:0', async function () {
    globalThis.fetch = function () { return Promise.reject(new Error('boom')); };
    var result = await core.testConnection('https://msn.feg.cn');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 0);
    assert.strictEqual(core.describeError(result).indexOf('無法連線') !== -1, true);
  });

  await acheck('subscribeTopic：open → live → 消息送达 → 流结束 closed 恰好一次', async function () {
    var encoder = textEncoder();
    var stream = new ReadableStream({
      start: function (controller) {
        controller.enqueue(encoder.encode(
          'event: open\ndata: {"id":"o1","time":1,"event":"open","topic":"pub_demo"}\n\n'));
        controller.enqueue(encoder.encode(
          'data: {"id":"s1","time":2,"event":"message","topic":"pub_demo","message":"live hello"}\n\n'));
        controller.enqueue(encoder.encode(
          'event: keepalive\ndata: {"id":"k1","time":3,"event":"keepalive","topic":"pub_demo"}\n\n'));
        controller.close();
      }
    });
    var calls = stubFetch(function () {
      return fakeResponse({
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        bodyStream: stream
      });
    });

    var statuses = [];
    var messages = [];
    var errors = [];
    var closedCount = 0;
    var subscription = core.subscribeTopic('msn.feg.cn', 'pub_demo', {
      cred: { mode: 'none' },
      onMessage: function (msg) { messages.push(msg); },
      onStatus: function (status) {
        statuses.push(status.phase);
        if (status.phase === 'closed') closedCount++;
      },
      onError: function (error) { errors.push(error); }
    });

    assert.strictEqual(typeof subscription.close, 'function', '必须同步返回 {close()}');
    await waitUntil(function () { return closedCount > 0; }, 3000, '流结束');

    assert.strictEqual(calls[0].url, 'https://msn.feg.cn/pub_demo/sse');
    assert.deepStrictEqual(statuses, ['connecting', 'open', 'live', 'closed'], '阶段序列：' + statuses.join('→'));
    assert.strictEqual(messages.length, 1, 'open / keepalive 不应被当成消息');
    assert.strictEqual(messages[0].message, 'live hello');
    assert.strictEqual(messages[0].source, 'sse');
    assert.deepStrictEqual(errors, []);

    subscription.close();
    subscription.close();
    assert.strictEqual(closedCount, 1, 'closed 必须恰好一次');
    return '阶段=' + statuses.join('→');
  });

  await acheck('subscribeTopic：403 → onError(authRequired) 且以 error→closed 收尾', async function () {
    stubFetch(function () {
      return fakeResponse({ status: 403, body: '{"code":40301,"error":"forbidden"}' });
    });
    var statuses = [];
    var errors = [];
    core.subscribeTopic('https://msn.feg.cn', 'dshteamtest', {
      onStatus: function (status) { statuses.push(status.phase); },
      onError: function (error) { errors.push(error); }
    });
    await waitUntil(function () { return statuses.indexOf('closed') !== -1; }, 3000, '403 收尾');
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].status, 403);
    assert.strictEqual(errors[0].authRequired, true);
    assert.deepStrictEqual(statuses, ['connecting', 'error', 'closed']);
  });

  await acheck('subscribeTopic：已经 abort 的 signal → 立即 closed，且只报一次', async function () {
    stubFetch(function () { return fakeResponse({ status: 200, body: '' }); });
    var controller = new AbortController();
    controller.abort();
    var statuses = [];
    var subscription = core.subscribeTopic('https://msn.feg.cn', 'pub_demo', {
      signal: controller.signal,
      onStatus: function (status) { statuses.push(status.phase); }
    });
    assert.deepStrictEqual(statuses, ['closed'], '同步返回时就应收尾');
    subscription.close();
    assert.deepStrictEqual(statuses, ['closed'], 'close() 幂等，不再重复');
  });

  await acheck('串流自然結束會觸發 onClosed（可重連），主動 close() 不會', async function () {
    // 1) 串流自己結束（伺服器收尾）→ 必須通知訂閱方，否則會永久停在「未連線」
    var encoder = textEncoder();
    var stream = new ReadableStream({
      start: function (controller) {
        controller.enqueue(encoder.encode(
          'data: {"id":"s1","time":1,"event":"message","topic":"pub_x","message":"hi"}\n\n'));
        controller.close();   // 沒有錯誤，就是結束了
      }
    });
    stubFetch(function () {
      return fakeResponse({ status: 200, headers: { 'content-type': 'text/event-stream' }, bodyStream: stream });
    });

    var closedInfos = [];
    var subscription = core.subscribeTopic('msn.feg.cn', 'pub_x', {
      onClosed: function (info) { closedInfos.push(info); }
    });
    await waitUntil(function () { return closedInfos.length > 0; }, 3000, '自然結束通知');
    assert.strictEqual(closedInfos.length, 1, '應恰好通知一次');
    assert.strictEqual(closedInfos[0].retryable, true, '應標記為可重試');
    subscription.close();
    assert.strictEqual(closedInfos.length, 1, 'close() 之後不該再多一次');

    // 2) 主動 close() → 不該觸發 onClosed（否則會變成「自己關→自己重連」的迴圈）
    var encoder2 = textEncoder();
    var openStream = new ReadableStream({
      start: function (controller) {
        controller.enqueue(encoder2.encode(
          'event: open\ndata: {"id":"o1","time":1,"event":"open","topic":"pub_y"}\n\n'));
        // 故意不關，讓它保持開啟
      }
    });
    stubFetch(function () {
      return fakeResponse({ status: 200, headers: { 'content-type': 'text/event-stream' }, bodyStream: openStream });
    });
    var closed2 = [];
    var sub2 = core.subscribeTopic('msn.feg.cn', 'pub_y', {
      onClosed: function (info) { closed2.push(info); }
    });
    await new Promise(function (r) { setTimeout(r, 200); });   // 等連線建立
    sub2.close();
    sub2.close();
    await new Promise(function (r) { setTimeout(r, 300); });   // 給 close() 一點時間（若會誤觸發，這裡就會抓到）
    assert.strictEqual(closed2.length, 0, '主動關閉不該觸發 onClosed，實際：' + JSON.stringify(closed2));

    // 3) 已經走過 onError 的失敗，不該再用 onClosed 重複通知
    stubFetch(function () {
      return fakeResponse({ status: 429, body: '{"code":42901,"error":"limit reached"}' });
    });
    var errors3 = [];
    var closed3 = [];
    var sub3 = core.subscribeTopic('msn.feg.cn', 'pub_z', {
      onError: function (e) { errors3.push(e); },
      onClosed: function (e) { closed3.push(e); }
    });
    await waitUntil(function () { return errors3.length > 0; }, 3000, '429 錯誤');
    await new Promise(function (r) { setTimeout(r, 200); });   // 等收尾
    assert.strictEqual(errors3.length, 1, '應回報一次錯誤');
    assert.strictEqual(closed3.length, 0,
      '報過錯就不該再發 onClosed（否則訂閱方會重試兩次）：' + JSON.stringify(closed3));
    sub3.close();
  });

  await acheck('subscribeTopics：一條連線訂閱多個主題，並按 topic 分發', async function () {
    var encoder = textEncoder();
    var stream = new ReadableStream({
      start: function (controller) {
        // open 事件的 topic 是**整串清單**（ntfy 的實際行為，已實測）
        controller.enqueue(encoder.encode(
          'event: open\ndata: {"id":"o1","time":1,"event":"open","topic":"pub_a,pub_b"}\n\n'));
        controller.enqueue(encoder.encode(
          'data: {"id":"m1","time":2,"event":"message","topic":"pub_a","message":"for a"}\n\n'));
        controller.enqueue(encoder.encode(
          'data: {"id":"m2","time":3,"event":"message","topic":"pub_b","message":"for b"}\n\n'));
        controller.enqueue(encoder.encode(
          'data: {"id":"m3","time":4,"event":"message","topic":"pub_other","message":"not ours"}\n\n'));
        controller.close();
      }
    });
    var calls = stubFetch(function () {
      return fakeResponse({
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        bodyStream: stream
      });
    });

    var routed = [];
    var statuses = [];
    var subscription = core.subscribeTopics('msn.feg.cn', ['pub_a', 'pub_b'], {
      cred: { mode: 'none' },
      onMessage: function (msg, topic) { routed.push(topic + '=' + msg.message); },
      onStatus: function (status) { statuses.push(status.phase + (status.topic ? ':' + status.topic : '')); }
    });
    await waitUntil(function () { return statuses.indexOf('closed') !== -1; }, 3000, '串流結束');
    subscription.close();

    // 1) URL 只有一條請求，而且逗號是**字面逗號**（不能被編成 %2C）
    assert.strictEqual(calls.length, 1, '只該發一條請求，實際：' + calls.length);
    var url = String(calls[0].url);
    assert.ok(url.indexOf('/pub_a,pub_b/sse') !== -1,
      'URL 應是逗號分隔的多主題路徑，實際：' + url);
    assert.ok(url.indexOf('%2C') === -1, '逗號不可被編碼，實際：' + url);

    // 2) 按 topic 分發；不屬於訂閱清單的訊息要丟掉
    assert.deepStrictEqual(routed, ['pub_a=for a', 'pub_b=for b'],
      '應只分發屬於已訂閱主題的訊息，實際：' + JSON.stringify(routed));

    // 3) live 狀態只發給真的收到訊息的主題
    assert.ok(statuses.indexOf('live:pub_a') !== -1, 'pub_a 應有 live：' + JSON.stringify(statuses));
    assert.ok(statuses.indexOf('live:pub_b') !== -1, 'pub_b 應有 live：' + JSON.stringify(statuses));
    assert.ok(statuses.indexOf('live:pub_other') === -1, '未訂閱的主題不該有 live');
  });

  await acheck('subscribeTopics：空清單是 no-op（不發請求、close 安全）', async function () {
    var calls = stubFetch(function () { return fakeResponse({ status: 200, body: '' }); });
    var subscription = core.subscribeTopics('msn.feg.cn', [], {});
    assert.strictEqual(calls.length, 0, '空清單不該發請求');
    assert.strictEqual(typeof subscription.close, 'function', '應回傳可 close 的句柄');
    subscription.close();
  });

  await acheck('subscribeTopics：subscribeTopic 是它的單主題包裝（簽名不變）', async function () {
    var encoder = textEncoder();
    var stream = new ReadableStream({
      start: function (controller) {
        controller.enqueue(encoder.encode(
          'data: {"id":"x1","time":1,"event":"message","topic":"pub_solo","message":"solo"}\n\n'));
        controller.close();
      }
    });
    var calls = stubFetch(function () {
      return fakeResponse({ status: 200, headers: { 'content-type': 'text/event-stream' }, bodyStream: stream });
    });
    var got = [];
    var subscription = core.subscribeTopic('msn.feg.cn', 'pub_solo', {
      onMessage: function (msg) { got.push(msg.message); }
    });
    await waitUntil(function () { return got.length > 0; }, 3000, '單主題訊息');
    subscription.close();
    assert.deepStrictEqual(got, ['solo']);
    assert.ok(String(calls[0].url).indexOf('/pub_solo/sse') !== -1, '應走單主題路徑');
  });

  await acheck('subscribeTopic：since 参数被正确编码到 query', async function () {
    var encoder = textEncoder();
    var stream = new ReadableStream({
      start: function (controller) { controller.close(); }
    });
    var calls = stubFetch(function () {
      return fakeResponse({ status: 200, bodyStream: stream });
    });
    var subscription = core.subscribeTopic('https://msn.feg.cn', 'pub_demo', { since: 'abc/def' });
    await waitUntil(function () { return calls.length > 0; }, 2000, '发起订阅');
    assert.strictEqual(calls[0].url, 'https://msn.feg.cn/pub_demo/sse?since=abc%2Fdef');
    subscription.close();
  });

  globalThis.fetch = realFetch;

  /* ------------------------------------------------------------ 汇总 */
  console.log('\n--------------------------------------------------');
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  if (failed > 0) {
    console.log('结果：FAILED');
    process.exitCode = 1;
  } else {
    console.log('结果：PASS（全程无网络）');
  }
})();

/** 轮询等待（离线异步用例用）。 */
function waitUntil(predicate, timeoutMs, label) {
  return new Promise(function (resolve, reject) {
    var started = Date.now();
    (function tick() {
      var value;
      try {
        value = predicate();
      } catch (error) {
        return reject(error);
      }
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error('等待超时：' + label));
      setTimeout(tick, 20);
    })();
  });
}
