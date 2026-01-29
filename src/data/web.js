const DEFAULT_PUBLIC_RPC = "=";

function nowMs() { return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now(); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function abortErr() {
	try {
		if (typeof DOMException !== "undefined") return new DOMException("Aborted", "AbortError");
	} catch {}
	const e = new Error("Aborted");
	e.name = "AbortError";
	return e;
}

function normalizeUrl(u) {
	if (!u) return "";
	return String(u).trim();
}

function isPublicSolanaRpc(httpUrl) {
	const u = normalizeUrl(httpUrl);
	if (!u) return true;
	return u === DEFAULT_PUBLIC_RPC || /api\.mainnet-beta\.solana\.com/i.test(u);
}

async function rpcHttp(httpUrl, method, params, { timeoutMs = 6_000, headers, signal } = {}) {
	const url = normalizeUrl(httpUrl);
	if (!url) throw new Error("rpc_http_missing_url");
	const body = { jsonrpc: "2.0", id: 1, method, params: params || [] };

	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	const sig = signal;
	const onAbort = () => ctrl.abort();
	try {
		if (sig) {
			if (sig.aborted) throw abortErr();
			sig.addEventListener("abort", onAbort, { once: true });
		}
		const r = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", ...(headers || {}) },
			body: JSON.stringify(body),
			signal: ctrl.signal,
		});
		if (!r.ok) throw new Error(`rpc_http_${r.status}`);
		const json = await r.json();
		if (json?.error) throw new Error(json.error?.message || "rpc_http_error");
		return json?.result;
	} finally {
		clearTimeout(t);
		if (sig) sig.removeEventListener("abort", onAbort);
	}
}

function createSolanaRpcWs(wsUrl, {
	logger = console,
	timeoutMs = 8_000,
} = {}) {
	const url = normalizeUrl(wsUrl);
	if (!url) throw new Error("rpc_ws_missing_url");
	if (typeof WebSocket === "undefined") throw new Error("rpc_ws_no_websocket");

	let ws = null;
	let closed = false;
	let nextId = 1;
	const inflight = new Map(); // id -> {resolve,reject,t}
	const subs = new Map(); // subId -> onNotify

	function safeLog(level, msg) {
		try { logger?.[level]?.(msg); } catch {}
	}

	function open() {
		if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
		closed = false;
		ws = new WebSocket(url);
		ws.onopen = () => safeLog("info", `[solana-ws] open ${url}`);
		ws.onerror = () => {};
		ws.onclose = () => {
			closed = true;
			// Reject inflight requests
			for (const [id, rec] of inflight.entries()) {
				clearTimeout(rec.t);
				rec.reject(new Error("rpc_ws_closed"));
				inflight.delete(id);
			}
			// Keep subscriptions registered so caller can decide to reconnect.
			safeLog("info", `[solana-ws] closed ${url}`);
		};
		ws.onmessage = (ev) => {
			let msg;
			try { msg = JSON.parse(ev.data); } catch { return; }

			// Response
			if (msg && typeof msg.id !== "undefined") {
				const rec = inflight.get(msg.id);
				if (!rec) return;
				clearTimeout(rec.t);
				inflight.delete(msg.id);
				if (msg.error) rec.reject(new Error(msg.error?.message || "rpc_ws_error"));
				else rec.resolve(msg.result);
				return;
			}

			// Notification
			const subId = msg?.params?.subscription;
			if (subId == null) return;
			const onNotify = subs.get(subId);
			if (!onNotify) return;
			try { onNotify(msg.params?.result, msg); } catch {}
		};
	}

	function close() {
		if (!ws) return;
		try { ws.close(); } catch {}
		ws = null;
		closed = true;
	}

	function sendRaw(obj) {
		if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("rpc_ws_not_open");
		ws.send(JSON.stringify(obj));
	}

	function waitOpen({ signal } = {}) {
		if (!ws) open();
		if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => reject(new Error("rpc_ws_open_timeout")), timeoutMs);
			let done = false;
			const onAbort = () => {
				if (done) return;
				done = true;
				clearTimeout(t);
				reject(abortErr());
			};
			if (signal) {
				if (signal.aborted) return onAbort();
				signal.addEventListener("abort", onAbort, { once: true });
			}

			const poll = async () => {
				while (!done) {
					if (!ws) { await sleep(10); continue; }
					if (ws.readyState === WebSocket.OPEN) {
						done = true;
						clearTimeout(t);
						if (signal) signal.removeEventListener("abort", onAbort);
						resolve();
						return;
					}
					if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
						done = true;
						clearTimeout(t);
						if (signal) signal.removeEventListener("abort", onAbort);
						reject(new Error("rpc_ws_closed"));
						return;
					}
					await sleep(25);
				}
			};
			poll();
		});
	}

	async function call(method, params, { signal } = {}) {
		if (closed) throw new Error("rpc_ws_closed");
		await waitOpen({ signal });
		const id = nextId++;
		const req = { jsonrpc: "2.0", id, method, params: params || [] };
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => {
				inflight.delete(id);
				reject(new Error("rpc_ws_timeout"));
			}, timeoutMs);
			inflight.set(id, { resolve, reject, t });
			try { sendRaw(req); } catch (e) {
				clearTimeout(t);
				inflight.delete(id);
				reject(e);
			}
		});
	}

	async function subscribe(subscribeMethod, subscribeParams, onNotify, { signal } = {}) {
		const subId = await call(subscribeMethod, subscribeParams, { signal });
		subs.set(subId, onNotify);
		return subId;
	}

	async function unsubscribe(unsubscribeMethod, subId, { signal } = {}) {
		try {
			await call(unsubscribeMethod, [subId], { signal });
		} finally {
			subs.delete(subId);
		}
	}

	return {
		open,
		close,
		call,
		subscribe,
		unsubscribe,
		get isOpen() { return !!ws && ws.readyState === WebSocket.OPEN; },
		get url() { return url; },
	};
}

export async function validatePremiumSolanaRpc({
	httpUrl,
	wsUrl,
	headers,
	maxHttpRttMs = 1_250,
	maxWsRttMs = 1_250,
	timeoutMs = 6_000,
	signal,
} = {}) {
	const http = normalizeUrl(httpUrl);
	const ws = normalizeUrl(wsUrl);

	if (!http || !ws) {
		return { ok: false, reason: "missing_rpc", detail: "Both httpUrl and wsUrl are required" };
	}
	if (isPublicSolanaRpc(http)) {
		return { ok: false, reason: "public_rpc_disallowed", detail: "Public RPC is not considered premium" };
	}

	// HTTP sanity + RTT
	try {
		const t0 = nowMs();
		const health = await rpcHttp(http, "getHealth", [], { timeoutMs, headers, signal });
		const httpRtt = nowMs() - t0;
		if (String(health || "").toLowerCase() !== "ok") {
			return { ok: false, reason: "rpc_unhealthy", detail: `getHealth=${String(health)}` };
		}
		if (httpRtt > maxHttpRttMs) {
			return { ok: false, reason: "http_slow", detail: `rtt=${Math.round(httpRtt)}ms` };
		}
	} catch (e) {
		return { ok: false, reason: "http_failed", detail: String(e?.message || e || "") };
	}

	// WS sanity + RTT
	try {
		const wsClient = createSolanaRpcWs(ws, { timeoutMs });
		wsClient.open();
		const t0 = nowMs();
		await wsClient.call("getVersion", []);
		const wsRtt = nowMs() - t0;
		wsClient.close();
		if (wsRtt > maxWsRttMs) {
			return { ok: false, reason: "ws_slow", detail: `rtt=${Math.round(wsRtt)}ms` };
		}
	} catch (e) {
		return { ok: false, reason: "ws_failed", detail: String(e?.message || e || "") };
	}

	return { ok: true };
}

export function createSolanaPremiumParser({
	httpUrl,
	wsUrl,
	commitment = "processed",
	headers,
	premium = false,
	logger = console,
} = {}) {
	const http = normalizeUrl(httpUrl);
	const ws = normalizeUrl(wsUrl);

	let wsClient = null;
	let running = false;
	let slotSubId = null;
	const logSubIds = new Set();

	const handlers = {
		slot: new Set(),
		log: new Set(),
		error: new Set(),
		status: new Set(),
	};

	function emit(type, payload) {
		const set = handlers[type];
		if (!set) return;
		for (const fn of set) {
			try { fn(payload); } catch {}
		}
	}

	function on(type, fn) {
		if (!handlers[type]) throw new Error(`unknown_event:${type}`);
		handlers[type].add(fn);
		return () => handlers[type].delete(fn);
	}

	async function start({
		subscribeSlots = true,
		logMentions = [],
		signal,
	} = {}) {
		if (running) return { enabled: true };
		if (!premium) return { enabled: false, reason: "premium_required" };
		const v = await validatePremiumSolanaRpc({ httpUrl: http, wsUrl: ws, headers, signal });
		if (!v.ok) return { enabled: false, reason: v.reason, detail: v.detail };

		wsClient = createSolanaRpcWs(ws, { logger });
		wsClient.open();
		running = true;
		emit("status", { running: true });

		try {
			if (subscribeSlots) {
				slotSubId = await wsClient.subscribe(
					"slotSubscribe",
					[],
					(result) => emit("slot", result),
					{ signal }
				);
			}

			for (const m of (Array.isArray(logMentions) ? logMentions : [])) {
				const mention = String(m || "").trim();
				if (!mention) continue;
				const subId = await wsClient.subscribe(
					"logsSubscribe",
					[{ mentions: [mention] }, { commitment }],
					(result) => emit("log", { mention, result }),
					{ signal }
				);
				logSubIds.add(subId);
			}
			return { enabled: true };
		} catch (e) {
			emit("error", e);
			await stop();
			return { enabled: false, reason: "start_failed", detail: String(e?.message || e || "") };
		}
	}

	async function stop() {
		if (!running) return;
		running = false;
		try {
			if (wsClient) {
				for (const id of logSubIds) {
					try { await wsClient.unsubscribe("logsUnsubscribe", id); } catch {}
				}
				logSubIds.clear();
				if (slotSubId != null) {
					try { await wsClient.unsubscribe("slotUnsubscribe", slotSubId); } catch {}
					slotSubId = null;
				}
				wsClient.close();
			}
		} finally {
			wsClient = null;
			emit("status", { running: false });
		}
	}

	// Convenience helper for downstream code (optional).
	async function fetchTransaction(signature, {
		maxSupportedTransactionVersion = 0,
		commitment: c = "confirmed",
		signal,
	} = {}) {
		if (!http) throw new Error("rpc_http_missing_url");
		return rpcHttp(http, "getTransaction", [
			signature,
			{ maxSupportedTransactionVersion, commitment: c, encoding: "jsonParsed" }
		], { headers, signal });
	}

	return {
		kind: "solana-premium-parser",
		get configured() { return !!http && !!ws; },
		get enabled() { return !!premium; },
		get running() { return running; },
		start,
		stop,
		on,
		fetchTransaction,
	};
}