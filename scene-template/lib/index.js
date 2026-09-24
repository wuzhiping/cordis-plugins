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

/** Exact route the browser bundle POSTs its selection to. */
const ROUTE_PATH = "/plugins/scene-template/selection";
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

module.exports = {
	name: "scene-template",
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

		const systemPrompt = ctx.get("systemPrompt");
		if (systemPrompt === undefined) {
			console.error("[scene-template] systemPrompt service unavailable; the selection cannot be injected");
		} else {
			ctx.effect(() => systemPrompt.context({
				name: CONTEXT_NAME,
				order: CONTEXT_ORDER,
				text: selectionContextText,
			}), "scene-template: selection prompt context");
		}

		const webServer = ctx.get("webServer");
		if (webServer === undefined) {
			console.error("[scene-template] webServer service unavailable; the client cannot report its selection");
		} else {
			ctx.effect(() => webServer.register({
				kind: "exact",
				path: ROUTE_PATH,
				handler: handleSelection,
			}), "scene-template: selection route");
		}
	},
};
