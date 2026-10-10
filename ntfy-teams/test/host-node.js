'use strict';

// =============================================================================
// 團隊協同 · ntfy-teams —— 宿主半邊的離線測試（無需網路、無需真的宿主）
//
// 這裡測的是「帶著討論內容建立工作階段」那條路徑：路由註冊、請求解析、
// seed 組裝、以及失敗時的行為。宿主服務（webServer／agentLoop）用假的，
// 因為要驗的是**我們送出的東西對不對**，而不是宿主本身。
//
// 跑法：node test/host-node.js
// =============================================================================

const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

const mod = require(path.join(__dirname, '..', 'lib', 'index.js'));
const t = mod.__test;

let passed = 0;
let failed = 0;

/**
 * 跑一個測試。
 * @param name - 測試名稱。
 * @param fn - 測試內容。
 */
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (err) {
    failed += 1;
    console.log('  FAIL ' + name);
    console.log('       ' + (err && err.message ? err.message : String(err)));
  }
}

/**
 * 跑一個非同步測試。
 * @param name - 測試名稱。
 * @param fn - 回傳 Promise 的測試內容。
 * @returns Promise。
 */
async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (err) {
    failed += 1;
    console.log('  FAIL ' + name);
    console.log('       ' + (err && err.message ? err.message : String(err)));
  }
}

/**
 * 造一個假的 Cordis 上下文，並記錄註冊了什麼。
 * @param services - { webServer, agentLoop }。
 * @returns { ctx, routes, effects }。
 */
function makeCtx(services) {
  const routes = [];
  const effects = [];
  const injected = [];
  const ctx = {
    // 只有 window 形式的 get：模擬「apply 當下服務還沒就緒」的真實情況。
    // 實測宿主就是這樣：apply 時 ctx.get('webServer') 回 null。
    get(name) {
      return services[name];
    },
    effect(fn, label) {
      effects.push(label);
      return fn();
    },
    // Cordis 的注入：服務就緒之後才呼叫 callback，並在 scope 上把服務掛好。
    inject(names, cb) {
      injected.push(names.join(','));
      if (!names.every((n) => services[n])) return;
      const scope = { get(name) { return services[name]; } };
      for (const n of names) scope[n] = services[n];
      cb(scope);
    }
  };
  if (services.webServer) {
    services.webServer.register = (route) => {
      routes.push(route);
      return () => {
        const at = routes.indexOf(route);
        if (at !== -1) routes.splice(at, 1);
      };
    };
  }
  return { ctx, routes, effects, injected };
}

/**
 * 依路径找一条已注册的路由 —— 不要靠索引，免得新增路由就打乱既有测试。
 *
 * @param routes - makeCtx 回传的路由阵列。
 * @param path - 要的路径。
 * @returns 路由。
 */
function routeAt(routes, path) {
  const found = routes.filter((r) => r.path === path)[0];
  assert.ok(found, '找不到路由 ' + path + '（已注册：' + routes.map((r) => r.path).join(', ') + '）');
  return found;
}

/**
 * 造一組假的 req／res，並把回應記錄下來。
 * @param method - HTTP 方法。
 * @param body - 請求內容（物件會被序列化；字串直接送出）。
 * @returns { req, res, done: Promise }。
 */
function makeExchange(method, body) {
  const listeners = {};
  const req = {
    method,
    on(event, fn) {
      listeners[event] = fn;
      return req;
    },
    destroy() {}
  };
  let statusCode = 0;
  const headers = {};
  let payload = '';
  const res = {
    set statusCode(v) { statusCode = v; },
    get statusCode() { return statusCode; },
    setHeader(k, v) { headers[k] = v; },
    end(v) { payload = v; },
    get headers() { return headers; },
    get body() { return payload; }
  };
  const done = new Promise((resolve) => {
    // res.end 之後就結算
    const origEnd = res.end.bind(res);
    res.end = (v) => {
      origEnd(v);
      resolve(JSON.parse(payload));
    };
  });
  // 讓 handler 有機會掛上 data/end 監聽
  setImmediate(() => {
    if (listeners.data) listeners.data(typeof body === 'string' ? body : JSON.stringify(body));
    if (listeners.end) listeners.end();
  });
  return { req, res, done, status: () => statusCode, headers: () => headers };
}

async function main() {
  console.log('宿主半邊離線測試（無網路）');
  console.log('');

  // ---------------------------------------------------------------- 基本导出
  console.log('== 基本导出');
  test('插件名與 patch 行 id 一致', () => {
    assert.strictEqual(mod.name, 'ntfy-teams');
  });
  test('inject 為空 —— 宿主服務全是可選依賴，缺了不該拖垮掛載', () => {
    assert.deepStrictEqual(mod.inject, []);
  });
  test('apply 是函式', () => {
    assert.strictEqual(typeof mod.apply, 'function');
  });

  // ---------------------------------------------------------------- 路由註冊
  console.log('');
  console.log('== 路由註冊');
  test('用 ctx.inject 等 webServer 就緒後才註冊（apply 當下服務還沒好）', () => {
    const webServer = {};
    const { ctx, routes, injected } = makeCtx({ webServer, agentLoop: {} });
    mod.apply(ctx);
    assert.ok(injected.indexOf('webServer') !== -1, '必須走 ctx.inject 等服務就緒');
    assert.strictEqual(routes.length, 3, '應註冊三條路由（工作階段 + 設定 + 遮蔽金鑰）');
    const paths = routes.map((r) => r.path).sort();
    assert.deepStrictEqual(paths, [t.ROUTE_PATH, t.SETTINGS_PATH, t.MASK_KEY_PATH].sort());
    routes.forEach((r) => {
      assert.strictEqual(r.kind, 'exact', 'exact 才不會影響 Web 頁面');
      assert.strictEqual(typeof r.handler, 'function');
    });
  });
  test('apply 當下拿不到 webServer 也不抛，且不會誤註冊', () => {
    const { ctx, routes } = makeCtx({});
    assert.doesNotThrow(() => mod.apply(ctx));
    assert.strictEqual(routes.length, 0);
  });
  test('ctx.get 抛異常時也不影響掛載', () => {
    const ctx = {
      get() { throw new Error('boom'); },
      inject(names, cb) { cb({ get() { throw new Error('boom'); } }); },
      effect() { return undefined; }
    };
    assert.doesNotThrow(() => mod.apply(ctx));
  });
  test('沒有 ctx.inject 的舊宿主：只回報能力缺失，不抛', () => {
    assert.doesNotThrow(() => mod.apply(makeCtx({ webServer: {} }).ctx));
  });

  // ---------------------------------------------------------------- seed 組裝
  console.log('');
  console.log('== seed 組裝');
  test('seed 是一則 user 角色的訊息（帶背景，不是模型說的話）', () => {
    const seed = t.buildSeed({
      label: '今天', topic: 'pub_demo', server: 'https://msn.feg.cn',
      messages: [{ name: '#alice', clock: '10:24', text: '進度我放上去了' }]
    });
    assert.strictEqual(seed.length, 1);
    const ev = seed[0];
    assert.strictEqual(ev.type, 'user/message');
    assert.strictEqual(typeof ev.seq, 'number');
    assert.strictEqual(typeof ev.time, 'number');
    assert.strictEqual(ev.data.role, 'user');
    assert.deepStrictEqual(ev.data.source, { kind: 'user' });
    assert.strictEqual(ev.surfaceOp, 'append');
    assert.ok(Array.isArray(ev.data.content) && ev.data.content[0].type === 'text');
  });
  test('seed 內文帶上日期、主題、來源與每一則訊息', () => {
    const seed = t.buildSeed({
      label: '昨天', topic: 'pub_x', server: 'https://s.example',
      messages: [
        { name: '#alice', clock: '09:00', text: '第一則' },
        { name: '--', clock: '', text: '' }
      ]
    });
    const body = seed[0].data.content[0].text;
    assert.ok(body.indexOf('昨天') !== -1, '應有日期');
    assert.ok(body.indexOf('pub_x') !== -1, '應有主題');
    assert.ok(body.indexOf('https://s.example/pub_x') !== -1, '應有來源');
    assert.ok(body.indexOf('#alice') !== -1 && body.indexOf('第一則') !== -1);
    assert.ok(body.indexOf('（無內文）') !== -1, '空內文要有標記');
  });
  test('畸形輸入不抛，且不產出 undefined', () => {
    const inputs = [null, undefined, 42, 'x', [], {}, { messages: 'nope' },
      { messages: [null, 1, 'x', {}] }, { label: 5, topic: null }];
    for (const input of inputs) {
      let seed;
      assert.doesNotThrow(() => { seed = t.buildSeed(input); }, '不該抛：' + JSON.stringify(input));
      const body = seed[0].data.content[0].text;
      assert.strictEqual(body.indexOf('undefined'), -1, '不該出現 undefined：' + body);
    }
  });
  test('一次最多收 400 則（避免有人貼整個頻道進來）', () => {
    const many = new Array(1000).fill({ name: 'a', text: 'b' });
    const body = t.buildSeed({ messages: many })[0].data.content[0].text;
    const bullets = body.split('\n').filter((l) => l.indexOf('- ') === 0).length;
    assert.strictEqual(bullets, t.MAX_MESSAGES);
  });
  test('單則過長會被截斷並標記', () => {
    const long = 'x'.repeat(t.MAX_MESSAGE_CHARS + 500);
    const out = t.clampText(long);
    assert.ok(out.length < long.length);
    assert.ok(out.endsWith('（已截斷）'));
  });

  // ---------------------------------------------------------------- HTTP 路由
  console.log('');
  console.log('== HTTP 路由');
  await testAsync('GET 回報能力探測', async () => {
    const webServer = {};
    const { ctx, routes } = makeCtx({ webServer, agentLoop: { async createAgent() { return { agent: { id: 's1' } }; } } });
    mod.apply(ctx);
    const ex = makeExchange('GET');
    await routeAt(routes, t.ROUTE_PATH).handler(ex.req, ex.res);
    const body = await ex.done;
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.hasAgentLoop, true);
  });
  await testAsync('POST 建立 session 並回傳 id', async () => {
    const created = [];
    const agentLoop = {
      async createAgent(ownerCtx, options) {
        created.push(options);
        return { agent: { id: options.sessionId } };
      }
    };
    const { ctx, routes } = makeCtx({ webServer: {}, agentLoop });
    mod.apply(ctx);
    const ex = makeExchange('POST', {
      label: '今天', topic: 'pub_demo', cwd: 'C:/tmp',
      messages: [{ name: '#a', clock: '10:00', text: 'hi' }]
    });
    await routeAt(routes, t.ROUTE_PATH).handler(ex.req, ex.res);
    const body = await ex.done;
    assert.strictEqual(body.ok, true, JSON.stringify(body));
    assert.ok(body.sessionId, '應回傳 sessionId');
    assert.strictEqual(created.length, 1, '應呼叫 createAgent 一次');
    assert.strictEqual(created[0].sessionId, body.sessionId);
    assert.strictEqual(created[0].meta.isSeeded, true);
    assert.strictEqual(created[0].meta.cwd, 'C:/tmp');
    assert.ok(Array.isArray(created[0].seed) && created[0].seed.length === 1);
    assert.ok(created[0].seed[0].data.content[0].text.indexOf('hi') !== -1, 'seed 應帶著訊息內容');
    // 宿主的契約：帶了 seed 就必須帶 inheritedEventCount（實測錯誤：
    // `seeded session requires an inherited event count`）。
    // 0 是正確語意 —— 這份 seed 是「帶進來的背景」，不是從父 session 繼承的歷史。
    assert.strictEqual(created[0].inheritedEventCount, 0,
      'seed 必須帶 inheritedEventCount:0，否則宿主會拒絕建立');
  });
  await testAsync('agentLoop 不可用 → 503 帶原因，不静默失敗', async () => {
    const { ctx, routes } = makeCtx({ webServer: {} });
    mod.apply(ctx);
    const ex = makeExchange('POST', { topic: 'pub_demo', messages: [] });
    await routeAt(routes, t.ROUTE_PATH).handler(ex.req, ex.res);
    const body = await ex.done;
    assert.strictEqual(body.ok, false);
    assert.ok(body.error.indexOf('agentLoop') !== -1, '原因要說清楚：' + body.error);
  });
  await testAsync('createAgent 抛錯 → 回報失敗而不是讓路由炸掉', async () => {
    const agentLoop = { async createAgent() { throw new Error('額度不足'); } };
    const { ctx, routes } = makeCtx({ webServer: {}, agentLoop });
    mod.apply(ctx);
    const ex = makeExchange('POST', { topic: 'pub_demo', messages: [] });
    await routeAt(routes, t.ROUTE_PATH).handler(ex.req, ex.res);
    const body = await ex.done;
    assert.strictEqual(body.ok, false);
    assert.ok(body.error.indexOf('額度不足') !== -1, '應帶上底層原因：' + body.error);
  });
  await testAsync('壞 JSON → 400 且不呼叫宿主', async () => {
    const calls = [];
    const agentLoop = { async createAgent(o) { calls.push(o); return { agent: { id: 'x' } }; } };
    const { ctx, routes } = makeCtx({ webServer: {}, agentLoop });
    mod.apply(ctx);
    const ex = makeExchange('POST', '{oops');
    await routeAt(routes, t.ROUTE_PATH).handler(ex.req, ex.res);
    const body = await ex.done;
    assert.strictEqual(body.ok, false);
    assert.strictEqual(ex.status(), 400, '壞 JSON 應該是 400');
    assert.strictEqual(calls.length, 0, '壞 JSON 不該驚動宿主');
  });
  await testAsync('不支援的方法 → 405', async () => {
    const { ctx, routes } = makeCtx({ webServer: {}, agentLoop: {} });
    mod.apply(ctx);
    const ex = makeExchange('DELETE');
    await routeAt(routes, t.ROUTE_PATH).handler(ex.req, ex.res);
    const body = await ex.done;
    assert.strictEqual(body.ok, false);
    assert.strictEqual(ex.status(), 405);
  });
  await testAsync('回應標了 no-store（這種內容不該被快取）', async () => {
    const agentLoop = { async createAgent(o) { return { agent: { id: o.sessionId } }; } };
    const { ctx, routes } = makeCtx({ webServer: {}, agentLoop });
    mod.apply(ctx);
    const ex = makeExchange('POST', { topic: 't', messages: [] });
    await routeAt(routes, t.ROUTE_PATH).handler(ex.req, ex.res);
    await ex.done;
    assert.strictEqual(ex.headers()['Cache-Control'], 'no-store');
  });

  // ---------------------------------------------------------------- 設定路由
  console.log('');
  console.log('== 設定路由（YAML 落档）');

  const settingsTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ntfy-teams-host-'));

  await testAsync('PUT 把設定與憑證寫成兩個 YAML 档', async () => {
    process.env.NTFY_TEAMS_SETTINGS_DIR = settingsTmp;
    const { ctx, routes } = makeCtx({ webServer: {}, agentLoop: {} });
    mod.apply(ctx);
    const ex = makeExchange('PUT', {
      // dashboardWidth 用一個**保證不可能合法**的哨兵值（遠超上限），
      // 這樣下面的「測試污染」守門可以認出它，而不會跟真實設定撞號。
      config: { server: 'https://msn.feg.cn', topics: ['pub_demo'], dashboardWidth: 108300 },
      secrets: { 'https://msn.feg.cn': { mode: 'basic', user: 'u', password: 'p' } }
    });
    await routeAt(routes, t.SETTINGS_PATH).handler(ex.req, ex.res);
    const body = await ex.done;
    assert.strictEqual(body.ok, true, JSON.stringify(body));
    assert.deepStrictEqual(body.written.sort(), ['config', 'secrets']);
    assert.ok(fs.existsSync(path.join(settingsTmp, 'config.yml')), '應寫出 config.yml');
    assert.ok(fs.existsSync(path.join(settingsTmp, 'secrets.yml')), '應寫出 secrets.yml');
    const cfg = fs.readFileSync(path.join(settingsTmp, 'config.yml'), 'utf8');
    assert.ok(cfg.indexOf('server: https://msn.feg.cn') !== -1, '設定要能直接閱讀：\n' + cfg);
    assert.strictEqual(cfg.indexOf('password'), -1, '一般設定档不該含憑證');
  });

  await testAsync('GET 回設定與憑證（客戶端要靠它才能訂閱私有主題）', async () => {
    process.env.NTFY_TEAMS_SETTINGS_DIR = settingsTmp;
    const { ctx, routes } = makeCtx({ webServer: {}, agentLoop: {} });
    mod.apply(ctx);
    const ex = makeExchange('GET');
    await routeAt(routes, t.SETTINGS_PATH).handler(ex.req, ex.res);
    const body = await ex.done;
    assert.strictEqual(body.ok, true, JSON.stringify(body));
    assert.deepStrictEqual(body.config.topics, ['pub_demo']);
    assert.ok(body.secrets && body.secrets['https://msn.feg.cn'], '應回傳憑證（訂閱私有主題需要）');
    assert.strictEqual(body.secrets['https://msn.feg.cn'].password, 'p');
    assert.strictEqual(body.secrets['https://msn.feg.cn'].user, 'u');
  });

  await testAsync('PUT 只帶 config 也能寫（secrets 可省略）', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ntfy-teams-host2-'));
    try {
      process.env.NTFY_TEAMS_SETTINGS_DIR = dir2;
      const { ctx, routes } = makeCtx({ webServer: {}, agentLoop: {} });
      mod.apply(ctx);
      const ex = makeExchange('PUT', { config: { server: 'https://x' } });
      await routeAt(routes, t.SETTINGS_PATH).handler(ex.req, ex.res);
      const body = await ex.done;
      assert.strictEqual(body.ok, true, JSON.stringify(body));
      assert.deepStrictEqual(body.written, ['config']);
      assert.strictEqual(fs.existsSync(path.join(dir2, 'secrets.yml')), false, '不該順手造出憑證档');
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  await testAsync('PUT 什麼都沒帶 → 400（不靜默成功）', async () => {
    process.env.NTFY_TEAMS_SETTINGS_DIR = settingsTmp;
    const { ctx, routes } = makeCtx({ webServer: {}, agentLoop: {} });
    mod.apply(ctx);
    const ex = makeExchange('PUT', { nothing: true });
    await routeAt(routes, t.SETTINGS_PATH).handler(ex.req, ex.res);
    const body = await ex.done;
    assert.strictEqual(body.ok, false);
    assert.strictEqual(ex.status(), 400);
    assert.ok(body.error.indexOf('config') !== -1, '要說清楚缺什麼：' + body.error);
  });

  await testAsync('PUT 非法內容 → 500 帶原因，不寫出壞档', async () => {
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ntfy-teams-host3-'));
    try {
      process.env.NTFY_TEAMS_SETTINGS_DIR = dir3;
      const { ctx, routes } = makeCtx({ webServer: {}, agentLoop: {} });
      mod.apply(ctx);
      const ex = makeExchange('PUT', { config: 'not an object' });
      await routeAt(routes, t.SETTINGS_PATH).handler(ex.req, ex.res);
      const body = await ex.done;
      assert.strictEqual(body.ok, false);
      assert.ok(body.error, '要有原因');
      assert.strictEqual(fs.existsSync(path.join(dir3, 'config.yml')), false, '不該寫出不合法的档');
    } finally {
      fs.rmSync(dir3, { recursive: true, force: true });
    }
  });

  await testAsync('設定路徑的 GET 在坏档時回 500（不是把坏档當成空設定）', async () => {
    const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'ntfy-teams-host4-'));
    try {
      fs.writeFileSync(path.join(dir4, 'config.yml'), 'server: https://x\n??? 壞了\n', 'utf8');
      process.env.NTFY_TEAMS_SETTINGS_DIR = dir4;
      const { ctx, routes } = makeCtx({ webServer: {}, agentLoop: {} });
      mod.apply(ctx);
      const ex = makeExchange('GET');
      await routeAt(routes, t.SETTINGS_PATH).handler(ex.req, ex.res);
      const body = await ex.done;
      assert.strictEqual(body.ok, false, '坏档必須回報失敗');
      assert.ok(body.error);
    } finally {
      fs.rmSync(dir4, { recursive: true, force: true });
    }
  });

  await testAsync('不支援的方法 → 405', async () => {
    process.env.NTFY_TEAMS_SETTINGS_DIR = settingsTmp;
    const { ctx, routes } = makeCtx({ webServer: {}, agentLoop: {} });
    mod.apply(ctx);
    const ex = makeExchange('DELETE');
    await routeAt(routes, t.SETTINGS_PATH).handler(ex.req, ex.res);
    await ex.done;
    assert.strictEqual(ex.status(), 405);
  });

  test('測試沒把「測試資料」寫進外掛目錄（真正的使用者設定檔不受影響）', () => {
    // 這裡刻意**不**斷言「外掛目錄不該有 config.yml」。
    //
    // 最初的寫法就是那樣，結果在使用者真的開始用之後變成誤報（實測踩過）：
    // 外掛目錄正是設定的存放位置（依使用者選擇），所以那份檔案本來就會在，
    // 而且裡面是使用者自己的伺服器／身分／別名。
    // 該擋的是「測試污染」，不是「檔案存在」——所以要認的是測試專屬的內容。
    const pluginDir = path.join(__dirname, '..');
    const cfgPath = path.join(pluginDir, 'config.yml');
    if (fs.existsSync(cfgPath)) {
      const text = fs.readFileSync(cfgPath, 'utf8');
      assert.strictEqual(text.indexOf('pub_team') === -1, true,
        '測試用的 pub_team 不該出現在使用者的設定裡（那是測試污染）');
      // 哨兵要用**保證不可能合法**的值（超過上限），不要用某個碰巧寫到的數字。
      // 實測踩過：原本寫死 280，等使用者要求「最小寬度 280」之後，
      // 真實設定裡合法出現 280 → 這條守門變成誤報。
      assert.strictEqual(text.indexOf('dashboardWidth: 108300') === -1, true,
        '測試寫的哨兵寬度不該出現在使用者的設定裡（那是測試污染）');
    }
    const secPath = path.join(pluginDir, 'secrets.yml');
    if (fs.existsSync(secPath)) {
      const text = fs.readFileSync(secPath, 'utf8');
      assert.strictEqual(text.indexOf('s3cret') === -1, true,
        '測試用的密碼 s3cret 不該留在使用者的憑證檔裡（那是測試污染）');
      assert.strictEqual(text.indexOf('alice') === -1, true,
        '測試用的帳號 alice 不該留在使用者的憑證檔裡（那是測試污染）');
    }
  });

  // ------------------------------------------------------- 遮蔽金鑰（mask key）
  console.log('');
  console.log('== 遮蔽金鑰（「恢復設定」用）');

  test('maskKey 與 MASK.md 的公式一致，且可以解回原值', () => {
    const pinned = new Date('2026-01-01T00:00:00.000Z');
    const key = 'sk-ExampleKeyReplaceMe001';                 // MASK.md 的合成 key
    const masked = t.maskKey(key, pinned);
    // MASK.md 第 22 行：masked = "sk-" + base64(key + "@" + ISO)
    assert.strictEqual(masked, 'sk-' + Buffer.from(key + '@2026-01-01T00:00:00.000Z', 'utf8').toString('base64'));
    assert.strictEqual(masked.slice(0, 3), 'sk-', '一定要有 sk- 前綴（伺服器靠它判格式）');
    assert.strictEqual(masked.length, 71, 'MASK.md 說 25 字元的 key 會得到 71 字元');
    const back = Buffer.from(masked.slice(3), 'base64').toString('utf8');
    assert.strictEqual(back, key + '@2026-01-01T00:00:00.000Z', '必須能解回 key + stamp');
    // 壞輸入要抛，不是靜默回一個像樣的値
    assert.throws(() => t.maskKey(''), /非空字串/);
    assert.throws(() => t.maskKey(null), /非空字串/);
  });

  test('maskKey 每次帶當下時間戳 → 同一個 key 會得到不同的遮蔽値', () => {
    const key = 'sk-ExampleKeyReplaceMe001';
    const a = t.maskKey(key, new Date('2026-01-01T00:00:00.000Z'));
    const b = t.maskKey(key, new Date('2026-01-01T00:00:01.000Z'));
    assert.notStrictEqual(a, b, '不同時間戳應該產生不同的遮蔽値');
    assert.strictEqual(a.slice(0, 3), b.slice(0, 3), '但前綴相同');
  });

  test('readCredentialRef 讀得出 refs 底下的値，且不誤讀其他欄位', () => {
    const text = [
      'version: 1',
      'refs:',
      '  FEG_API_KEY: sk-ExampleKeyReplaceMe001',
      '  DEEPSEEK_API_KEY: sk-AnotherKeyReplaceMe0002',
      'other:',
      '  FEG_API_KEY: 這不該被讀到'
    ].join('\n');
    assert.strictEqual(t.readCredentialRef(text, 'FEG_API_KEY'), 'sk-ExampleKeyReplaceMe001');
    assert.strictEqual(t.readCredentialRef(text, 'DEEPSEEK_API_KEY'), 'sk-AnotherKeyReplaceMe0002');
    assert.strictEqual(t.readCredentialRef(text, 'NOPE'), null);
    // 引號要剝掉
    assert.strictEqual(t.readCredentialRef('refs:\n  K: "sk-quoted"\n', 'K'), 'sk-quoted');
    assert.strictEqual(t.readCredentialRef("refs:\n  K: 'sk-single'\n", 'K'), 'sk-single');
    // 空値／壞輸入 → null（不抛）
    assert.strictEqual(t.readCredentialRef('refs:\n  K:\n', 'K'), null);
    assert.strictEqual(t.readCredentialRef('refs:\n  K: ""\n', 'K'), null);
    assert.strictEqual(t.readCredentialRef(null, 'K'), null);
    assert.strictEqual(t.readCredentialRef('refs:\n  K: v\n', ''), null);
    // refs 區塊之外的東西不該被讀到
    assert.strictEqual(t.readCredentialRef('other:\n  FEG_API_KEY: nope\n', 'FEG_API_KEY'), null);
  });

  test('maskedCredential：讀不到憑證檔時回一份說得出原因的錯誤', () => {
    const saved = process.env.DSH_CREDENTIALS_PATH;
    process.env.DSH_CREDENTIALS_PATH = path.join(settingsTmp, 'does-not-exist.yaml');
    try {
      const r = t.maskedCredential({});
      assert.strictEqual(r.ok, false);
      assert.ok(r.error.indexOf('讀不到憑證檔') !== -1, '要說出讀不到，實際：' + r.error);
      assert.ok(r.error.indexOf('does-not-exist.yaml') !== -1, '要指出是哪個檔案，實際：' + r.error);
    } finally {
      if (saved === undefined) delete process.env.DSH_CREDENTIALS_PATH;
      else process.env.DSH_CREDENTIALS_PATH = saved;
    }
  });

  test('maskedCredential：憑證檔裡沒有可用的金鑰時，錯誤要列出試過哪些參照', () => {
    const saved = process.env.DSH_CREDENTIALS_PATH;
    const f = path.join(settingsTmp, 'creds-no-ref.yaml');
    fs.writeFileSync(f, 'version: 1\nrefs:\n  OTHER_KEY: sk-x\n', 'utf8');
    process.env.DSH_CREDENTIALS_PATH = f;
    try {
      const r = t.maskedCredential({});
      assert.strictEqual(r.ok, false);
      // 錯誤要把「試過哪些」說出來 —— 否則使用者不知道該補哪個參照名。
      assert.ok(r.error.indexOf('AIFE_API_KEY') !== -1,
        '要列出試過的參照名，實際：' + r.error);
      assert.ok(r.error.indexOf('creds-no-ref.yaml') !== -1,
        '要指出是哪個檔案，實際：' + r.error);
    } finally {
      if (saved === undefined) delete process.env.DSH_CREDENTIALS_PATH;
      else process.env.DSH_CREDENTIALS_PATH = saved;
      fs.rmSync(f, { force: true });
    }
  });

  test('★ maskedCredential：參照名按候選順序取第一個存在的（實測 AIFE_API_KEY 才是對的）', () => {
    // 這條是被實測逼出來的：第一版寫死 FEG_API_KEY，而這台機器的
    // `$DSH_HOME/.credentials.yaml` 裡叫 AIFE_API_KEY —— 那時按鈕只會回
    // 「找不到 refs.FEG_API_KEY」或拿到一把伺服器不認得的金鑰（200 {}）。
    const saved = process.env.DSH_CREDENTIALS_PATH;
    const pinned = new Date('2026-01-01T00:00:00.000Z');

    // 1) 只有 FEG_API_KEY（沒有 AIFE）→ 用它，並回報用了哪一個
    const f1 = path.join(settingsTmp, 'creds-feg.yaml');
    fs.writeFileSync(f1, 'version: 1\nrefs:\n  FEG_API_KEY: sk-FegOnly\n', 'utf8');
    process.env.DSH_CREDENTIALS_PATH = f1;
    try {
      const r = t.maskedCredential({ now: pinned });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.ref, 'FEG_API_KEY', '只有 FEG 時應該用它，實際：' + r.ref);
      assert.strictEqual(r.masked, t.maskKey('sk-FegOnly', pinned));
    } finally {
      fs.rmSync(f1, { force: true });
    }

    // 2) 兩個都在 → 優先 AIFE_API_KEY（實測它才是伺服器認得的那把）
    const f2 = path.join(settingsTmp, 'creds-both.yaml');
    fs.writeFileSync(f2, [
      'version: 1',
      'refs:',
      '  FEG_API_KEY: sk-FegOnly',
      '  AIFE_API_KEY: sk-Aife'
    ].join('\n') + '\n', 'utf8');
    process.env.DSH_CREDENTIALS_PATH = f2;
    try {
      const r = t.maskedCredential({ now: pinned });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.ref, 'AIFE_API_KEY',
        '★ 兩個都在時必須優先 AIFE_API_KEY（實測 FEG 那把會拿到 200 {}），實際：' + r.ref);
      assert.strictEqual(r.masked, t.maskKey('sk-Aife', pinned));
    } finally {
      if (saved === undefined) delete process.env.DSH_CREDENTIALS_PATH;
      else process.env.DSH_CREDENTIALS_PATH = saved;
      fs.rmSync(f2, { force: true });
    }
  });

  test('★ maskedCredential：成功時回遮蔽値，原文絕不出現', () => {
    const saved = process.env.DSH_CREDENTIALS_PATH;
    const f = path.join(settingsTmp, 'creds-ok.yaml');
    const secret = 'sk-ExampleKeyReplaceMe001';
    fs.writeFileSync(f, 'version: 1\nrefs:\n  FEG_API_KEY: ' + secret + '\n', 'utf8');
    process.env.DSH_CREDENTIALS_PATH = f;
    const pinned = new Date('2026-01-01T00:00:00.000Z');
    try {
      const r = t.maskedCredential({ now: pinned });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.masked, t.maskKey(secret, pinned));
      assert.ok(r.source.indexOf('creds-ok.yaml') !== -1, '要回報來源檔案');
      // ★ 最重要的一條：回傳値裡不能出現原文
      assert.strictEqual(JSON.stringify(r).indexOf(secret), -1,
        '★ 原文不得出現在回傳値裡（它只該以遮蔽形式離開宿主）');
    } finally {
      if (saved === undefined) delete process.env.DSH_CREDENTIALS_PATH;
      else process.env.DSH_CREDENTIALS_PATH = saved;
      fs.rmSync(f, { force: true });
    }
  });

  // ⚠️ 這條一定要用 testAsync + await route.handler(...)：
  //    handler 是 async，不 await 的話 `res.end` 還在 microtask 裡沒跑，
  //    讀到的會是空物件，於是斷言全部落空（第一版就是這樣，看起來像路由壞了）。
  await testAsync('遮蔽金鑰路由：GET 回遮蔽値、非 GET 回 405、失敗回 503', async () => {
    const webServer = {};
    const { ctx, routes } = makeCtx({ webServer, agentLoop: {} });
    mod.apply(ctx);
    const route = routeAt(routes, t.MASK_KEY_PATH);

    const saved = process.env.DSH_CREDENTIALS_PATH;
    const f = path.join(settingsTmp, 'creds-route.yaml');
    fs.writeFileSync(f, 'version: 1\nrefs:\n  FEG_API_KEY: sk-ExampleKeyReplaceMe001\n', 'utf8');
    process.env.DSH_CREDENTIALS_PATH = f;
    try {
      // 1) GET → 200 + maskKey
      const ex1 = makeExchange('GET');
      await route.handler(ex1.req, ex1.res);
      const out1 = await ex1.done;
      assert.strictEqual(ex1.res.statusCode, 200, 'GET 應該回 200');
      assert.strictEqual(out1.ok, true, 'GET 應該成功，實際：' + JSON.stringify(out1));
      assert.ok(typeof out1.maskKey === 'string' && out1.maskKey.slice(0, 3) === 'sk-',
        '應該回一把 sk- 開頭的遮蔽値，實際：' + JSON.stringify(out1));
      assert.strictEqual(out1.maskKey.indexOf('ExampleKeyReplaceMe001'), -1,
        '★ 路由回應不得含原文');

      // 2) POST → 405（只有 GET）
      const ex2 = makeExchange('POST', {});
      await route.handler(ex2.req, ex2.res);
      const out2 = await ex2.done;
      assert.strictEqual(out2.ok, false, 'POST 應該被拒');
      assert.ok(String(out2.error).indexOf('GET') !== -1, '要說明只接受 GET');

      // 3) 憑證檔不在 → 503 且說得出原因
      process.env.DSH_CREDENTIALS_PATH = path.join(settingsTmp, 'nope.yaml');
      const ex3 = makeExchange('GET');
      await route.handler(ex3.req, ex3.res);
      const out3 = await ex3.done;
      assert.strictEqual(ex3.res.statusCode, 503,
        '讀不到憑證檔應該回 503，實際 ' + ex3.res.statusCode);
      assert.ok(out3 && out3.ok === false && out3.error, '要有錯誤訊息');
    } finally {
      if (saved === undefined) delete process.env.DSH_CREDENTIALS_PATH;
      else process.env.DSH_CREDENTIALS_PATH = saved;
      fs.rmSync(f, { force: true });
    }
  });

  delete process.env.NTFY_TEAMS_SETTINGS_DIR;
  fs.rmSync(settingsTmp, { recursive: true, force: true });

  console.log('');
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  console.log('结果：' + (failed === 0 ? 'PASS（全程无网络）' : 'FAILED'));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('測試本身爆了：', err);
  process.exit(1);
});
