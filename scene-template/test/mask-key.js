'use strict';
// Offline tests for the mask key that every scene API POST body now carries.
//
//   node test/mask-key.js
//
// Two halves:
//   1. The host helpers (pure + one fake-context route test) — no network.
//   2. A source guard that the *client* really puts apiKey into all three
//      bodies. The client is a browser bundle, so the guard reads the source
//      instead of executing it: every `postJson(<SCENE_*_API>, …)` call must
//      take its body from `withApiKey(...)`, and no call may go back to a bare
//      GET against the list endpoint.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('../lib/index.js');
const t = mod.__test;

let passed = 0;
let failed = 0;

/** Run one test. @param name - test name. @param fn - body. */
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-mask-'));

/**
 * Build a fake Cordis context that captures registered routes.
 *
 * `inject` runs its callback **synchronously** with a ready scope, mirroring what
 * the real cordis does once the named services exist. That is the whole point of
 * the fix: registration must happen inside that callback, never in `apply`
 * itself, because at apply time the services may not be ready yet.
 * @param opts - `{ noWebServer }` simulates the service never arriving.
 * @returns { ctx, routes }.
 */
function makeCtx(opts) {
	const options = opts || {};
	const routes = [];
	const webServer = options.noWebServer ? undefined : { register(row) { routes.push(row); } };
	const scope = { webServer, systemPrompt: { context() { return () => {}; } } };
	scope.get = (name) => scope[name];
	const ctx = {
		// Deliberately returns nothing: if the plugin goes back to reading
		// services here instead of inside `inject`, this fake stops registering
		// routes and the tests below fail — which is the regression we want caught.
		get() { return undefined; },
		effect(fn) { try { const d = fn(); return typeof d === 'function' ? d : () => {}; } catch (err) { return () => {}; } },
		inject(names, cb) { cb(scope); },
	};
	return { ctx, routes };
}

console.log('== 遮蔽金鑰（lib/index.js）');

test('maskKey 與 MASK.md 的公式一致，且可解回原值', () => {
	const pinned = new Date('2026-01-01T00:00:00.000Z');
	const key = 'sk-ExampleKeyReplaceMe001';
	const masked = t.maskKey(key, pinned);
	assert.strictEqual(masked, 'sk-' + Buffer.from(key + '@2026-01-01T00:00:00.000Z', 'utf8').toString('base64'));
	assert.strictEqual(masked.slice(0, 3), 'sk-', '必須有 sk- 前綴');
	assert.strictEqual(masked.length, 71, 'MASK.md 說 25 字元的 key 會得到 71 字元');
	const back = Buffer.from(masked.slice(3), 'base64').toString('utf8');
	assert.strictEqual(back, key + '@2026-01-01T00:00:00.000Z');
	assert.throws(() => t.maskKey(''), /非空字串/);
	assert.throws(() => t.maskKey(null), /非空字串/);
});

test('readCredentialRef 只讀 refs 區塊，且剝引號', () => {
	const text = [
		'version: 1',
		'refs:',
		'  AIFE_API_KEY: sk-AbC',
		'  OTHER: sk-Def',
		'other:',
		'  AIFE_API_KEY: 不該被讀到',
	].join('\n');
	assert.strictEqual(t.readCredentialRef(text, 'AIFE_API_KEY'), 'sk-AbC');
	assert.strictEqual(t.readCredentialRef(text, 'OTHER'), 'sk-Def');
	assert.strictEqual(t.readCredentialRef(text, 'NOPE'), null);
	assert.strictEqual(t.readCredentialRef('refs:\n  K: "sk-q"\n', 'K'), 'sk-q');
	assert.strictEqual(t.readCredentialRef("refs:\n  K: 'sk-s'\n", 'K'), 'sk-s');
	assert.strictEqual(t.readCredentialRef('refs:\n  K:\n', 'K'), null);
	assert.strictEqual(t.readCredentialRef(null, 'K'), null);
	assert.strictEqual(t.readCredentialRef('other:\n  AIFE_API_KEY: x\n', 'AIFE_API_KEY'), null);
});

test('★ maskedCredential 依候選順序取第一個存在的（AIFE 優先）', () => {
	const saved = process.env.DSH_CREDENTIALS_PATH;
	const pinned = new Date('2026-01-01T00:00:00.000Z');
	const f = path.join(tmp, 'creds.yaml');
	fs.writeFileSync(f, 'version: 1\nrefs:\n  FEG_API_KEY: sk-feg\n  AIFE_API_KEY: sk-aife\n', 'utf8');
	process.env.DSH_CREDENTIALS_PATH = f;
	try {
		const r = t.maskedCredential({ now: pinned });
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.ref, 'AIFE_API_KEY', '實測 FEG 那把會拿到 200 {}，必須優先 AIFE');
		assert.strictEqual(r.masked, t.maskKey('sk-aife', pinned));
		assert.strictEqual(JSON.stringify(r).indexOf('sk-aife'), -1, '★ 原文不得出現在回傳値裡');
	} finally {
		if (saved === undefined) delete process.env.DSH_CREDENTIALS_PATH;
		else process.env.DSH_CREDENTIALS_PATH = saved;
		fs.rmSync(f, { force: true });
	}
});

test('maskedCredential 的失敗訊息要指出檔案與試過的參照', () => {
	const saved = process.env.DSH_CREDENTIALS_PATH;
	process.env.DSH_CREDENTIALS_PATH = path.join(tmp, 'no-such.yaml');
	try {
		let r = t.maskedCredential({});
		assert.strictEqual(r.ok, false);
		assert.ok(r.error.indexOf('no-such.yaml') !== -1, '要指出檔案，實際：' + r.error);

		const f = path.join(tmp, 'empty.yaml');
		fs.writeFileSync(f, 'version: 1\nrefs:\n  OTHER: x\n', 'utf8');
		process.env.DSH_CREDENTIALS_PATH = f;
		r = t.maskedCredential({});
		assert.strictEqual(r.ok, false);
		assert.ok(r.error.indexOf('AIFE_API_KEY') !== -1, '要列出試過的參照，實際：' + r.error);
		fs.rmSync(f, { force: true });
	} finally {
		if (saved === undefined) delete process.env.DSH_CREDENTIALS_PATH;
		else process.env.DSH_CREDENTIALS_PATH = saved;
	}
});

test('路由：GET 回遮蔽値、非 GET 回 405、讀不到憑證回 503', () => {
	const { ctx, routes } = makeCtx();
	mod.apply(ctx);
	const route = routes.find((r) => r.path === t.MASK_KEY_PATH);
	assert.ok(route, '應該註冊 ' + t.MASK_KEY_PATH + '（已註冊：' + routes.map((r) => r.path).join(', ') + '）');

	const saved = process.env.DSH_CREDENTIALS_PATH;
	const f = path.join(tmp, 'route.yaml');
	fs.writeFileSync(f, 'version: 1\nrefs:\n  AIFE_API_KEY: sk-route\n', 'utf8');
	process.env.DSH_CREDENTIALS_PATH = f;
	/** Invoke the handler and capture the JSON body + status. @param method - HTTP method. @returns {status, body}. */
	const call = (method) => {
		let status = 0;
		let body = null;
		route.handler({ method }, {
			set statusCode(v) { status = v; },
			get statusCode() { return status; },
			setHeader() {},
			end(s) { body = JSON.parse(s); },
		});
		return { status, body };
	};
	try {
		const ok = call('GET');
		assert.strictEqual(ok.status, 200);
		assert.strictEqual(ok.body.ok, true);
		assert.strictEqual(ok.body.ref, 'AIFE_API_KEY');
		assert.strictEqual(ok.body.maskKey.slice(0, 3), 'sk-');
		assert.strictEqual(JSON.stringify(ok.body).indexOf('sk-route'), -1, '★ 回應不得含原文');

		assert.strictEqual(call('POST').body.ok, false, 'POST 應該被拒');
		assert.ok(String(call('POST').body.error).indexOf('GET') !== -1);

		process.env.DSH_CREDENTIALS_PATH = path.join(tmp, 'missing.yaml');
		assert.strictEqual(call('GET').status, 503);
	} finally {
		if (saved === undefined) delete process.env.DSH_CREDENTIALS_PATH;
		else process.env.DSH_CREDENTIALS_PATH = saved;
		fs.rmSync(f, { force: true });
	}
});

console.log('');
console.log('== ★ 路由註冊的坑（這個 bug 讓整條路由靜默消失過）');

const HOST_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'index.js'), 'utf8');

test('★ 不得再用 apply 當下的 ctx.get 取服務（要用 ctx.inject）', () => {
	// 實測：用 ctx.get("webServer") 時，apply 當下拿到未就緒的對象，
	// register 從來沒被呼叫，於是 /scene-template/selection 與 mask-key
	// 兩條路由都只表現成 404（GET 404 / POST 405，沒有 content-type）。
	assert.strictEqual(/ctx\.get\(\s*["']webServer["']\s*\)/.test(HOST_SRC), false,
		'ctx.get("webServer") 會靜默不註冊路由；必須用 ctx.inject([...], scope => …)');
	assert.strictEqual(/ctx\.get\(\s*["']systemPrompt["']\s*\)/.test(HOST_SRC), false,
		'ctx.get("systemPrompt") 同理');
	assert.ok(/ctx\.inject\(\s*\[\s*["']webServer["']\s*\]/.test(HOST_SRC),
		'webServer 必須走 ctx.inject');
	assert.ok(/ctx\.inject\(\s*\[\s*["']systemPrompt["']\s*\]/.test(HOST_SRC),
		'systemPrompt 必須走 ctx.inject');
});

test('webServer 一直沒就緒時，apply 不抛且不誤註冊', () => {
	const { ctx, routes } = makeCtx({ noWebServer: true });
	assert.doesNotThrow(() => mod.apply(ctx));
	assert.strictEqual(routes.length, 0, '沒有 webServer 就不該註冊任何路由');
});

test('apply 沒有 ctx.inject 時也不抛（退化而不是崩掉整排）', () => {
	const { ctx } = makeCtx();
	delete ctx.inject;
	assert.doesNotThrow(() => mod.apply(ctx));
});

console.log('');
console.log('== 客戶端：三個 scene API 的 POST body 都要帶 apiKey');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');

test('★ 三個呼叫都走 withApiKey + postJson（不再有裸 GET）', () => {
	const cases = [
		['list', 'SCENE_API'],
		['detail', 'SCENE_DETAIL_API'],
		['suggestion', 'SCENE_SUGGEST_API'],
	];
	for (const [label, constName] of cases) {
		// Each call site is `withApiKey({...}).then(function (X) { return postJson(CONST, X); })`.
		// Don't pin the callback's parameter name — list calls it `payload`, the
		// others `body`; what matters is that postJson's argument came from withApiKey.
		const call = new RegExp('postJson\\(' + constName + ',\\s*(\\w+)\\)').exec(CLIENT);
		assert.ok(call, label + '：找不到 postJson(' + constName + ', …)');
		const argName = call[1];
		const before = CLIENT.slice(Math.max(0, call.index - 220), call.index);
		assert.ok(/withApiKey\(/.test(before),
			label + '：postJson(' + constName + ', ' + argName + ') 的 body 必須由 withApiKey 產生');
		assert.ok(new RegExp('withApiKey\\([\\s\\S]*?function \\(' + argName + '\\)').test(before),
			label + '：' + argName + ' 應該就是 withApiKey 的結果');
	}
	// no bare GET against the list endpoint may come back
	assert.strictEqual(/fetch\(SCENE_API/.test(CLIENT), false,
		'list 不該再用 fetch( 直接發出（那會漏掉 apiKey）');
	assert.strictEqual(/SCENE_API \+ "\?_t="/.test(CLIENT), false,
		'list 的 ?_t= 去快取已由 POST 取代');
});

test('getMaskKey 只快取成功、失敗會重試（否則宿主晚一步就緒就永遠拿不到）', () => {
	assert.ok(/maskKeyCache = key;/.test(CLIENT), '成功才寫快取');
	const catchBlock = /\.catch\(function \(err\) \{[\s\S]{0,200}?return "";\s*\}\)/.exec(CLIENT);
	assert.ok(catchBlock, '失敗時應回空字串而不是抛（抛會把整個介面打成 mock）');
	assert.strictEqual(/maskKeyCache = ""/.test(CLIENT), false, '失敗不該寫進快取');
});

test('拿不到金鑰時仍送出請求（只是不帶 apiKey）', () => {
	assert.ok(/if \(key !== ""\) out\.apiKey = key;/.test(CLIENT),
		'withApiKey 應該只在拿到金鑰時才附加 apiKey');
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
console.log('通過 ' + passed + ' 項，失敗 ' + failed + ' 項');
console.log('結果：' + (failed === 0 ? 'PASS（全程無網路）' : 'FAILED'));
process.exit(failed === 0 ? 0 : 1);
