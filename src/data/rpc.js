function nowMs() {
	try {
		if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
	} catch {}
	return Date.now();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function safeJsonParse(s, fallback = null) {
	try { return JSON.parse(String(s || '')); } catch { return fallback; }
}

function readU32LE(u8, offset) {
	try {
		const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
		return dv.getUint32(offset, true);
	} catch {
		return 0;
	}
}

function readU64LE(u8, offset) {
	try {
		// Prefer native BigInt if available.
		const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
		const lo = BigInt(dv.getUint32(offset, true));
		const hi = BigInt(dv.getUint32(offset + 4, true));
		return (hi << 32n) | lo;
	} catch {
		return 0n;
	}
}

function bytesToBase58Like(u8) {
	// We only need a stable string for debug/log comparisons.
	// Avoid bundling a base58 implementation here.
	try {
		return `bytes:${u8.length}:${Array.from(u8.slice(0, 4)).join('.')}`;
	} catch {
		return '';
	}
}

function base64ToU8(b64) {
	const s = String(b64 || '');
	if (!s) return new Uint8Array();

	// Browser
	try {
		if (typeof atob === 'function') {
			const bin = atob(s);
			const out = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
			return out;
		}
	} catch {}

	// Node-ish
	try {
		// eslint-disable-next-line no-undef
		if (typeof Buffer !== 'undefined') {
			// eslint-disable-next-line no-undef
			return new Uint8Array(Buffer.from(s, 'base64'));
		}
	} catch {}

	return new Uint8Array();
}

function summarizeRpcShape(json) {
	try {
		const hasError = !!json?.error;
		const res = json?.result;
		const val = res?.value;
		const data = val?.data;

		const data0 = Array.isArray(data) ? data[0] : null;
		const enc = Array.isArray(data) ? data[1] : null;

		return {
			jsonrpc: json?.jsonrpc,
			idType: typeof json?.id,
			hasError,
			errorCode: json?.error?.code,
			errorMessage: json?.error?.message,
			resultKeys: res && typeof res === 'object' ? Object.keys(res).slice(0, 12) : [],
			valueKeys: val && typeof val === 'object' ? Object.keys(val).slice(0, 12) : [],
			dataKind: Array.isArray(data) ? 'tuple' : (data == null ? 'null' : typeof data),
			encoding: typeof enc === 'string' ? enc : null,
			dataLen: typeof data0 === 'string' ? data0.length : null,
		};
	} catch {
		return { err: 'summarize_failed' };
	}
}

function shouldDebugRpcMint() {
	try {
		const g = (typeof window !== 'undefined') ? window : globalThis;
		if (g && g._fdvDebugRpcMintSampler) return true;
	} catch {}
	try {
		if (typeof localStorage !== 'undefined') {
			const v = String(localStorage.getItem('fdv_debug_rpc_mint') || '').trim();
			return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
		}
	} catch {}
	return false;
}

export function getRpcConfigFromStorage() {
	try {
		if (typeof localStorage === 'undefined') return { rpcUrl: '', rpcHeaders: {} };
		const rpcUrl = String(localStorage.getItem('fdv_rpc_url') || '').trim();
		const rpcHeadersRaw = String(localStorage.getItem('fdv_rpc_headers') || '{}');
		const rpcHeaders = safeJsonParse(rpcHeadersRaw, {}) || {};
		return { rpcUrl, rpcHeaders };
	} catch {
		return { rpcUrl: '', rpcHeaders: {} };
	}
}

async function withTimeout(promiseFactory, timeoutMs, signal) {
	const ms = Number(timeoutMs || 0);
	if (!Number.isFinite(ms) || ms <= 0) return promiseFactory(signal);

	const ac = new AbortController();
	const onAbort = () => {
		try { ac.abort(); } catch {}
	};
	try {
		if (signal && typeof signal.addEventListener === 'function') {
			signal.addEventListener('abort', onAbort, { once: true });
		}
	} catch {}

	const timer = setTimeout(() => {
		try { ac.abort(); } catch {}
	}, ms);

	try {
		return await promiseFactory(ac.signal);
	} finally {
		clearTimeout(timer);
		try {
			if (signal && typeof signal.removeEventListener === 'function') {
				signal.removeEventListener('abort', onAbort);
			}
		} catch {}
	}
}

async function rpcFetch({ rpcUrl, rpcHeaders, body, signal }) {
	const url = String(rpcUrl || '').trim();
	if (!url) throw new Error('missing_rpc_url');

	const headers = {
		'content-type': 'application/json',
		...(rpcHeaders && typeof rpcHeaders === 'object' ? rpcHeaders : {}),
	};

	const res = await fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal,
	});

	const txt = await res.text().catch(() => '');
	let json = null;
	try { json = txt ? JSON.parse(txt) : null; } catch { json = null; }

	if (!res.ok) {
		const msg = json?.error?.message || `HTTP_${res.status}`;
		const e = new Error(msg);
		e.status = res.status;
		e.rpc = json;
		throw e;
	}
	if (json?.error) {
		const e = new Error(String(json.error.message || 'rpc_error'));
		e.code = json.error.code;
		e.rpc = json;
		throw e;
	}

	return json;
}

// Cache keyed by `${rpcUrl}|${mint}`.
const _mintCache = new Map();

export async function sampleMintRpc(
	mint,
	{
		rpcUrl,
		rpcHeaders,
		commitment = 'processed',
		timeoutMs = 900,
		cacheMs = 250,
		signal,
		debug,
		retries = 0,
		retryDelayMs = 40,
	} = {}
) {
	// console.log('[sampleMintRpc] start', { mint, rpcUrl });	
	const id = String(mint || '').trim();
	const url = String(rpcUrl || '').trim();
	const dbg = (debug != null) ? !!debug : shouldDebugRpcMint();
	if (!id) return { ok: false, error: 'missing_mint' };
	if (!url) return { ok: false, error: 'missing_rpc_url' };

	const key = `${url}|${id}`;
	const t = nowMs();
	const cached = _mintCache.get(key);
	if (cached && cached.res && (t - Number(cached.at || 0)) <= Math.max(0, Number(cacheMs || 0))) {
		return { ...cached.res, cache: { hit: true, ageMs: t - Number(cached.at || 0) } };
	}
	if (cached && cached.pending) {
		try {
			return await cached.pending;
		} catch {
			// fall through
		}
	}

	const runOnce = async () => {
		const t0 = nowMs();
		const body = {
			jsonrpc: '2.0',
			id: Math.floor(Math.random() * 1e9),
			method: 'getAccountInfo',
			params: [id, { encoding: 'base64', commitment }],
		};

		const json = await withTimeout(
			(sig) => rpcFetch({ rpcUrl: url, rpcHeaders, body, signal: sig }),
			timeoutMs,
			signal
		);

		const shape = summarizeRpcShape(json);
		const val = json?.result?.value;
		const data = val?.data;
		const b64 = Array.isArray(data) ? data[0] : null;
		const u8 = base64ToU8(b64);

		const dataLen = u8.length;
		const mintAuthOpt = dataLen >= 4 ? readU32LE(u8, 0) : 0;
		const freezeAuthOpt = dataLen >= 50 ? readU32LE(u8, 46) : 0;
		const supplyRaw = dataLen >= 44 ? readU64LE(u8, 36) : 0n;
		const decimals = dataLen >= 45 ? Number(u8[44] || 0) : null;
		const isInitialized = dataLen >= 46 ? !!u8[45] : null;

		const mintAuthority = (mintAuthOpt !== 0 && dataLen >= 36)
			? bytesToBase58Like(u8.slice(4, 36))
			: null;
		const freezeAuthority = (freezeAuthOpt !== 0 && dataLen >= 82)
			? bytesToBase58Like(u8.slice(50, 82))
			: null;

		const owner = String(val?.owner || '');

		const res = {
			ok: true,
			mint: id,
			rpcUrl: url,
			slot: Number(json?.result?.context?.slot || 0) || null,
			lamports: Number(val?.lamports || 0) || 0,
			owner,
			parsed: {
				supplyRaw: supplyRaw.toString(),
				decimals,
				isInitialized,
				mintAuthority,
				freezeAuthority,
				flags: {
					hasMintAuthority: !!mintAuthority,
					hasFreezeAuthority: !!freezeAuthority,
				},
				dataLen,
			},
			timing: {
				ms: Math.max(0, nowMs() - t0),
			},
			debug: dbg ? { shape } : undefined,
		};

		// console.log('[sampleMintRpc] success', { mint: id, slot: res.slot, timingMs: res.timing.ms });

		

		if (dbg) {
			try {
				// Avoid printing headers or full raw blobs.
				console.debug('[rpc][mint] sample ok', { mint: id, slot: res.slot, ms: res.timing.ms, parsed: res.parsed, shape });
			} catch {}
		}

		_mintCache.set(key, { at: nowMs(), res, pending: null });
		return { ...res, cache: { hit: false, ageMs: 0 } };
	};

	const pending = (async () => {
		let attempt = 0;
		// tiny retry can help for transient 429/502; keep it very small to preserve "fast" intent.
		while (true) {
			try {
				return await runOnce();
			} catch (e) {
				const msg = String(e?.message || e);
				const status = Number(e?.status || 0) || null;
				if (dbg) {
					try {
						console.debug('[rpc][mint] sample fail', { mint: id, status, msg, shape: summarizeRpcShape(e?.rpc) });
					} catch {}
				}
				if (attempt >= Math.max(0, Number(retries || 0))) {
					const out = { ok: false, mint: id, rpcUrl: url, error: msg || 'rpc_fail', status, timing: { ms: 0 } };
					_mintCache.set(key, { at: nowMs(), res: out, pending: null });
					return out;
				}
				attempt++;
				await sleep(Math.max(0, Number(retryDelayMs || 0)));
			}
		}
	})();

	_mintCache.set(key, { at: t, res: null, pending });
	return pending;
}

