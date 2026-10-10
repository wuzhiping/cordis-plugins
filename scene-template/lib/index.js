// Host half of the scene-template bundle.
//
// It exists for one purpose: make the composer's three-level selection count.
//
//   1. Receive what the user picked (scenario / branch / template). The picking
//      happens in lib/client.js, which runs in the browser and cannot call into
//      this process, so it POSTs the selection to ROUTE_PATH — an exact,
//      same-origin route on the DSH web server.
//   2. Register that selection as a *runtime prompt context*
//      (`systemPrompt.context`), so every model step of that session carries
//      the scenario's description and the selected template's reference
//      content. The assembly context the provider receives is built by
//      `dsh-agent`'s `assembleContextFor(agent, signal)` — `{ agent, scope:
//      agent, signal? }` — so the session comes straight from
//      `context.agent.id`; `agents.currentInitiator()` (the AsyncLocalStorage
//      the agent driver chain runs inside) stays as a fallback only.
//
// Every capability is optional and its absence is non-fatal: without
// `systemPrompt` nothing is injected, without `webServer` the client's POST
// fails (the UI still works, only the context is missing), and without `web`
// the remote template content is skipped while inline `data:` templates still
// resolve. Nothing here writes to a session log or the filesystem.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Exact route the browser bundle POSTs its selection to.
 *
 * NOT under `/plugins/`: DSH registers a prefix route on `/plugins` for the
 * plugin-asset/bundle carrier, and `match()` resolves an exact hit before any
 * prefix — but that exact table is not consulted for this path in practice, so a
 * `/plugins/scene-template/selection` route never runs (observed: GET 404, POST
 * 405, no content-type, i.e. the framework's asset handler answered). Keeping the
 * route outside that tree is what makes it reachable. See test/probe-host-route.js.
 */
const ROUTE_PATH = "/scene-template/selection";
/** Prompt-context name; unique in the registry, and how it reads in a trace. */
const CONTEXT_NAME = "scene-template/selection";
/** Built-in runtime contexts sit at 110 / 115 / 120 (sandbox, approval,
 * subagent delegation); the selection follows them. */
const CONTEXT_ORDER = 130;
/** Reference content is a hint, not a document: cap what enters the prompt. */
const CONTENT_MAX = 4000;
/** The only accepted body shape is one small selection JSON object. */
const BODY_MAX = 256 * 1024;

/** @param value - anything from the wire. @returns a string, never undefined. */
function str(value) {
	return typeof value === "string" ? value : "";
}

/**
 * The prompt interpolates `{{name}}` groups and throws on an unknown variable,
 * so injected prose must never carry that shape: a template body that happens
 * to use mustache syntax would otherwise break every later step of the session.
 * @param text - the text about to become prompt context.
 * @returns the same text with `{{` neutralised.
 */
function promptSafe(text) {
	return String(text).split("{{").join("{ {");
}

/**
 * Decode the handful of entities a prose page actually uses.
 * @param text - HTML-escaped text.
 * @returns the readable text.
 */
function decodeEntities(text) {
	return text
		.split("&nbsp;").join(" ")
		.split("&amp;").join("&")
		.split("&lt;").join("<")
		.split("&gt;").join(">")
		.split("&quot;").join("\"")
		.split("&#39;").join("'");
}

/**
 * Turn the preview page into the prose the model can actually reference.
 * @param html - the preview document.
 * @returns tag-free, single-spaced text.
 */
function stripHtml(html) {
	let text = String(html);
	text = text.replace(/<script[\s\S]*?<\/script>/gi, " ");
	text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(/<\/(p|div|h[1-6]|li|tr|section)>/gi, "\n");
	text = text.replace(/<[^>]*>/g, " ");
	text = decodeEntities(text);
	text = text.replace(/[ \t\u00a0]+/g, " ").replace(/\n{3,}/g, "\n\n");
	return text.trim();
}

/**
 * The offline path: templates that ship with the UI carry their preview as a
 * `data:text/html` URL instead of an HTTP address.
 * @param url - the data URL.
 * @returns the decoded prose, or "" when it cannot be read.
 */
function textFromDataUrl(url) {
	const raw = String(url);
	const comma = raw.indexOf(",");
	if (comma < 0) return "";
	const meta = raw.slice(0, comma);
	const payload = raw.slice(comma + 1);
	try {
		const decoded = /;base64/i.test(meta) ? atob(payload) : decodeURIComponent(payload);
		return stripHtml(decoded);
	} catch (err) {
		return "";
	}
}

/**
 * Read one small request body, refusing anything oversized.
 * @param req - the HTTP request.
 * @returns the body as UTF-8 text.
 */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > BODY_MAX) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

// ── 遮蔽金鑰（mask key）──────────────────────────────────────────────────────
//
// 三個 scene 介面（list / detail / suggestion_template）的 POST body 都要帶
// `apiKey`，而它的值必須是 MASK.md 定義的**遮蔽形**：
//
//     ts     = "@" + ISO 時間戳
//     masked = "sk-" + base64(key + ts)
//
// 遮蔽放在宿主，不讓瀏覽器自己算：金鑰住在宿主的憑證檔裡，送進瀏覽器只為了
// 再遮蔽一次，反而讓**原文**出現在 DevTools、記憶體與任何截圖裡。所以這裡只把
// 遮蔽後的値交出去（`GET MASK_KEY_PATH`），客戶端拿它填進每個 POST body。
//
// 這段與 ntfy-teams 的實作是**刻意重複**的：兩個外掛各自獨立發佈（GitHub
// tarball 個別安裝），共用一個模組會讓其中一個的缺席弄壞另一個。
//
// 參照名依序試，取第一個存在的 —— 這是被實測逼出來的：這台機器的
// `$DSH_HOME/.credentials.yaml` 裡叫 `AIFE_API_KEY`，沒有 `FEG_API_KEY`；
// 而 `FEG_API_KEY` 遮蔽後打端點會拿到 `200 {}`（格式對、但那把金鑰沒資料）。
const MASK_KEY_PATH = "/scene-template/mask-key";
const MASK_KEY_REFS = ["AIFE_API_KEY", "FEG_API_KEY", "DEEPSEEK_API_KEY"];
const MASK_PREFIX = "sk-";

/** @returns the credentials file path (honours DSH_CREDENTIALS_PATH). */
function credentialsFilePath() {
	const override = process.env.DSH_CREDENTIALS_PATH;
	if (typeof override === "string" && override.trim() !== "") return override.trim();
	const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
	return path.join(home, ".credentials.yaml");
}

/**
 * Read one `refs:` entry out of the credentials YAML text.
 *
 * A deliberately minimal line parser: the file is written by DSH itself and this
 * needs exactly one scalar out of one block. It stops at the first line that is
 * not indented, so a same-named key in a later top-level block cannot be picked
 * up by accident.
 *
 * @param text - the credentials file contents.
 * @param name - the reference name, e.g. `AIFE_API_KEY`.
 * @returns the value, or null.
 */
function readCredentialRef(text, name) {
	if (typeof text !== "string" || typeof name !== "string" || name === "") return null;
	const lines = text.split(/\r?\n/);
	let inRefs = false;
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
		if (!inRefs) continue;
		if (/^\S/.test(line)) break;
		const m = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
		if (!m || m[1] !== name) continue;
		let value = m[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		return value === "" ? null : value;
	}
	return null;
}

/**
 * Mask one key exactly as MASK.md specifies.
 * @param key - the raw key.
 * @param now - the timestamp to embed (tests pin this).
 * @returns the masked string.
 */
function maskKey(key, now) {
	if (typeof key !== "string" || key === "") throw new Error("maskKey: key 必須是非空字串");
	const stamp = "@" + (now instanceof Date ? now : new Date()).toISOString();
	return MASK_PREFIX + Buffer.from(key + stamp, "utf8").toString("base64");
}

/**
 * Resolve the first available reference and return its masked form.
 * @param options - `{ now }`, for tests.
 * @returns `{ ok, masked, ref, source, error }`.
 */
function maskedCredential(options) {
	const opts = options || {};
	const file = credentialsFilePath();
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		return { ok: false, error: "讀不到憑證檔（" + file + "）：" + (err && err.message ? err.message : String(err)) };
	}
	for (const ref of MASK_KEY_REFS) {
		const key = readCredentialRef(text, ref);
		if (!key) continue;
		try {
			return { ok: true, masked: maskKey(key, opts.now), ref, source: file };
		} catch (err) {
			return { ok: false, error: "遮蔽失敗（" + ref + "）：" + (err && err.message ? err.message : String(err)) };
		}
	}
	return { ok: false, error: "憑證檔裡找不到可用的金鑰（試過 " + MASK_KEY_REFS.join("、") + "）——檔案：" + file };
}

module.exports = {
	name: "scene-template",
	/** No statically required services: every one is taken through `ctx.inject`
	 * inside `apply`, so a missing service degrades instead of blocking the row. */
	inject: [],
	/**
	 * Register the prompt context and the selection route.
	 * @param ctx - the host context of this bundle's row.
	 */
	apply(ctx) {
		/** sessionId -> the selection the composer currently shows. */
		const selections = new Map();
		/** templateId -> { previewUrl, text, source } — fetched once per template. */
		const contents = new Map();
		/** Last assembly outcome, surfaced in the pet's tooltip so "did it get
		 * injected?" is answerable instead of guessed. `via` names the lookup
		 * that resolved the session. */
		let lastInjection = { at: 0, sessionId: null, chars: 0, reason: "idle", via: "none" };

		/**
		 * Fallback session lookup: the initiator the agent driver chain recorded
		 * in its AsyncLocalStorage. Only consulted when the assembly context
		 * carried no agent.
		 * @returns the SessionId, or null.
		 */
		function currentSessionId() {
			const agents = ctx.get("agents");
			if (agents === undefined || typeof agents.currentInitiator !== "function") return null;
			try {
				const agent = agents.currentInitiator();
				if (agent === undefined || agent === null) return null;
				const id = str(agent.id);
				return id.length > 0 ? id : null;
			} catch (err) {
				return null;
			}
		}

		/**
		 * Cache one template's reference content, from HTTP or from an inline
		 * data URL.
		 * @param selection - the selection holding templateId and previewUrl.
		 */
		async function ensureTemplateContent(selection) {
			const id = selection.templateId;
			if (!id) return;
			const url = selection.previewUrl;
			const cached = contents.get(id);
			if (cached !== undefined && cached.previewUrl === url) return;
			let text = "";
			let source = "none";
			if (url.indexOf("data:") === 0) {
				text = textFromDataUrl(url);
				source = "inline";
			} else if (url.length > 0) {
				const web = ctx.get("web");
				if (web === undefined) {
					source = "no-web-service";
				} else {
					try {
						const result = await web.fetch({ url });
						if (result && result.statusCode >= 200 && result.statusCode < 300) {
							text = stripHtml(result.body && result.body.content ? result.body.content : "");
							source = "remote";
						} else {
							source = "http-" + (result ? result.statusCode : "n/a");
						}
					} catch (err) {
						source = "error";
						console.error("[scene-template] template content fetch failed:", err && err.message ? err.message : err);
					}
				}
			}
			contents.set(id, { previewUrl: url, text: text.slice(0, CONTENT_MAX), source });
		}

		/**
		 * The prompt-context provider: called once per assembly. An empty string
		 * means "no contribution" — the assembler drops empty contexts, so an
		 * idle session adds nothing at all.
		 * @param assembleContext - the assembly context (`{ agent, scope, signal? }`).
		 * @returns the runtime-context text.
		 */
		function selectionContextText(assembleContext) {
			const argAgent = assembleContext !== undefined && assembleContext !== null
				&& assembleContext.agent !== undefined && assembleContext.agent !== null
				? str(assembleContext.agent.id)
				: "";
			const fromAssembly = argAgent.length > 0;
			const sessionId = fromAssembly ? argAgent : currentSessionId();
			const via = sessionId === null ? "none" : (fromAssembly ? "context.agent" : "currentInitiator");
			if (sessionId === null) {
				lastInjection = { at: Date.now(), sessionId: null, chars: 0, reason: "no-session", via: "none" };
				return "";
			}
			const selection = selections.get(sessionId);
			if (selection === undefined) {
				lastInjection = { at: Date.now(), sessionId, chars: 0, reason: "no-selection", via };
				return "";
			}
			const lines = [];
			if (selection.scenarioName) {
				lines.push("【已選場景】" + selection.scenarioName);
				if (selection.scenarioDescription) lines.push("場景說明:" + selection.scenarioDescription);
			}
			if (selection.branchName) {
				lines.push("【已選分支】" + selection.branchName + "(該分支的 preset 已寫入輸入框,若使用者改過則以輸入框內容為準)");
			}
			if (selection.templateTitle) {
				lines.push("【參考模板】" + selection.templateTitle);
				// The preview address is the model's fallback reference when the
				// extracted content is thin or missing. Inline `data:` URLs are
				// skipped: they *are* the content, and they are kilobytes long.
				const hasPreviewUrl = selection.previewUrl.length > 0
					&& selection.previewUrl.indexOf("data:") !== 0;
				if (hasPreviewUrl) lines.push("預覽地址: " + selection.previewUrl);
				const cached = contents.get(selection.templateId);
				if (cached !== undefined && cached.text.length > 0) {
					lines.push("模板案例內容(生成檔案時可參考):");
					lines.push(cached.text);
				} else if (hasPreviewUrl) {
					lines.push("(案例內容未能自動取出，需要時可抓取上面的預覽地址查看完整範例)");
				} else {
					lines.push("(模板案例內容暫不可用)");
				}
			}
			if (lines.length === 0) {
				lastInjection = { at: Date.now(), sessionId, chars: 0, reason: "empty", via };
				return "";
			}
			const text = promptSafe("以下是使用者在輸入區選中的場景/分支/模板資料,請把它當作本次對話的背景上下文:\n"
				+ lines.join("\n"));
			lastInjection = { at: Date.now(), sessionId, chars: text.length, reason: "rendered", via };
			return text;
		}

		/**
		 * One line of user-facing transparency, returned to the client so the
		 * pet's tooltip can state what will be injected and how the last
		 * assembly went (zh-TW, matching the rest of the UI).
		 * @param sessionId - the session the tip is about.
		 * @param selection - the stored selection, or null.
		 * @returns the tooltip line.
		 */
		function injectionTip(sessionId, selection) {
			if (selection === undefined || selection === null) {
				return "未選場景/模板：模型上下文不會帶入這些資料。";
			}
			const parts = [];
			if (selection.scenarioName) parts.push("場景「" + selection.scenarioName + "」");
			if (selection.branchName) parts.push("分支「" + selection.branchName + "」");
			if (selection.templateTitle) parts.push("模板「" + selection.templateTitle + "」");
			let tip = "會注入模型上下文：" + (parts.length > 0 ? parts.join(" · ") : "(空)");
			if (selection.templateId) {
				const cached = contents.get(selection.templateId);
				if (cached !== undefined && cached.text.length > 0) {
					tip += "（案例 " + cached.text.length + " 字，來源 " + (cached.source === "remote" ? "API" : "內建範例") + "）";
				} else {
					tip += "（案例內容未取到：" + (cached !== undefined ? cached.source : "n/a") + "，已附預覽地址）";
				}
			}
			let last;
			if (lastInjection.reason === "idle") {
				last = "還沒跑過組裝，下一條訊息時注入";
			} else if (lastInjection.reason === "rendered" && lastInjection.sessionId === sessionId) {
				last = "已注入 " + lastInjection.chars + " 字（" + lastInjection.via + "）";
			} else if (lastInjection.reason === "rendered") {
				last = "上次注入的是別的會話";
			} else if (lastInjection.reason === "no-selection") {
				last = "上次組裝時本會話還沒有選中資料（已記錄 " + selections.size + " 個會話）";
			} else {
				last = "未注入（" + lastInjection.reason + "）";
			}
			return tip + "\n上次組裝：" + last;
		}

		/**
		 * Route handler: one selection sync per composer change.
		 * @param req - the HTTP request.
		 * @param res - the HTTP response.
		 */
		async function handleSelection(req, res) {
			const send = (status, payload) => {
				res.statusCode = status;
				res.setHeader("content-type", "application/json; charset=utf-8");
				res.setHeader("cache-control", "no-store");
				res.end(JSON.stringify(payload));
			};
			if (req.method !== "POST") {
				send(405, { ok: false, reason: "method not allowed" });
				return;
			}
			let body;
			try {
				body = await readBody(req);
			} catch (err) {
				send(413, { ok: false, reason: err && err.message ? err.message : "body rejected" });
				return;
			}
			let payload;
			try {
				payload = JSON.parse(body);
			} catch (err) {
				send(400, { ok: false, reason: "invalid json" });
				return;
			}
			const sessionId = str(payload && payload.sessionId);
			if (sessionId.length === 0) {
				send(400, { ok: false, reason: "missing sessionId" });
				return;
			}
			const raw = payload && payload.selection ? payload.selection : null;
			if (raw === null || (!str(raw.scenarioId) && !str(raw.templateId) && !str(raw.branchId))) {
				selections.delete(sessionId);
				send(200, { ok: true, cleared: true, tip: injectionTip(sessionId, null) });
				return;
			}
			const selection = {
				scenarioId: str(raw.scenarioId),
				scenarioName: str(raw.scenarioName),
				scenarioDescription: str(raw.scenarioDescription),
				branchId: str(raw.branchId),
				branchName: str(raw.branchName),
				templateId: str(raw.templateId),
				templateTitle: str(raw.templateTitle),
				previewUrl: str(raw.previewUrl),
			};
			selections.set(sessionId, selection);
			try {
				await ensureTemplateContent(selection);
			} catch (err) {
				console.error("[scene-template] template content failed:", err && err.message ? err.message : err);
			}
			send(200, { ok: true, tip: injectionTip(sessionId, selection) });
		}

		// ⚠️ 服務一律走 `ctx.inject`，**不能**用 apply 當下的 `ctx.get`。
		//
		// 這個坑讓整條路由靜默地不註冊：沒有例外、沒有錯誤，只有一個 404 ——
		// 而且連既有的 `/scene-template/selection` 也一直是壞的（實測：GET 404、
		// POST 405、沒有 content-type，那是框架自己的處理器在答，不是這裡的
		// handler）。`ctx.get` 在 apply 當下可能拿到尚未就緒的對象，於是
		// `webServer.register` 從來沒被呼叫到。同樣的結論 ntfy-teams 也踩過。
		//
		// `ctx.inject` 會等服務就緒之後才跑回呼，是唯一可靠的做法。
		if (typeof ctx.inject !== "function") {
			console.error("[scene-template] ctx.inject unavailable; routes and prompt context cannot be registered");
			return;
		}

		ctx.inject(["systemPrompt"], (scope) => {
			const systemPrompt = scope.systemPrompt;
			if (systemPrompt === undefined) {
				console.error("[scene-template] systemPrompt service unavailable; the selection cannot be injected");
				return;
			}
			ctx.effect(() => systemPrompt.context({
				name: CONTEXT_NAME,
				order: CONTEXT_ORDER,
				text: selectionContextText,
			}), "scene-template: selection prompt context");
		});

		ctx.inject(["webServer"], (scope) => {
			const webServer = scope.webServer;
			if (webServer === undefined) {
				console.error("[scene-template] webServer service unavailable; the client cannot report its selection");
				return;
			}
			// Log the success: without it, a route that failed to register and a
			// route that registered fine are indistinguishable (both just get a
			// 404 from the framework), which is exactly what made this bug silent.
			console.log("[scene-template] registering routes: " + ROUTE_PATH + ", " + MASK_KEY_PATH);

			ctx.effect(() => webServer.register({
				kind: "exact",
				path: ROUTE_PATH,
				handler: handleSelection,
			}), "scene-template: selection route");

			// The client needs the masked key for every scene API POST body.
			// Only GET; the response carries the masked form and never the raw key.
			ctx.effect(() => webServer.register({
				kind: "exact",
				path: MASK_KEY_PATH,
				handler: (req, res) => {
					const send = (status, payload) => {
						res.statusCode = status;
						res.setHeader("content-type", "application/json; charset=utf-8");
						res.setHeader("cache-control", "no-store");
						res.end(JSON.stringify(payload));
					};
					if (req.method !== "GET") {
						send(405, { ok: false, error: "只接受 GET" });
						return;
					}
					const result = maskedCredential({});
					if (!result.ok) {
						// Say *where* it looked, otherwise the only symptom is "it silently
						// sends no apiKey".
						send(503, { ok: false, error: result.error });
						return;
					}
					send(200, { ok: true, maskKey: result.masked, ref: result.ref, source: result.source });
				},
			}), "scene-template: mask-key route");
		});
	},
	/** Offline test surface: the mask helpers are pure and worth pinning. */
	__test: {
		MASK_KEY_PATH,
		MASK_KEY_REFS,
		credentialsFilePath,
		readCredentialRef,
		maskKey,
		maskedCredential,
		ROUTE_PATH,
	},
};
