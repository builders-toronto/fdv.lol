const REF_KEY = "fdv.ref.v1";
const REF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_LOG_MEM_LINES = 800;

function _bufferLog(msg, type = "info") {
	if (!_isBrowser()) return;
	try {
		const g = window;
		if (!g._fdvLogBuffer) g._fdvLogBuffer = [];
		const line = `[${new Date().toLocaleTimeString()}] ${String(msg || "")}`;
		g._fdvLogBuffer.push(line);
		if (g._fdvLogBuffer.length > MAX_LOG_MEM_LINES) {
			g._fdvLogBuffer.splice(0, g._fdvLogBuffer.length - Math.floor(MAX_LOG_MEM_LINES * 0.9));
		}
		if (g._fdvLogToConsole && typeof console !== "undefined") {
			const t = String(type || "info").toLowerCase();
			if (t.startsWith("war") && console.warn) console.warn(line);
			else if ((t.startsWith("err") || t.startsWith("fail")) && console.error) console.error(line);
			else if (console.log) console.log(line);
		}
	} catch {}
}

function _shortPk(pk) {
	try {
		const s = String(pk || "");
		if (s.length <= 12) return s;
		return `${s.slice(0, 4)}…${s.slice(-4)}`;
	} catch {
		return "";
	}
}

function _now() {
	try { return Date.now(); } catch { return 0; }
}

function _isBrowser() {
	return typeof window !== "undefined" && typeof document !== "undefined";
}

const _B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const _B58_MAP = (() => {
	const m = Object.create(null);
	for (let i = 0; i < _B58_ALPHABET.length; i++) m[_B58_ALPHABET[i]] = i;
	return m;
})();

function _base58DecodeBytes(str) {
	const s = String(str || "").trim();
	if (!s) return null;
	// Quick reject: Solana pubkeys are base58 and typically 32..44 chars.
	if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return null;

	let zeros = 0;
	while (zeros < s.length && s[zeros] === "1") zeros++;

	// Big-endian base256 in a byte array.
	let bytes = [0];
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		const v = _B58_MAP[c];
		if (v == null) return null;
		let carry = v;
		for (let j = 0; j < bytes.length; j++) {
			const x = bytes[j] * 58 + carry;
			bytes[j] = x & 0xff;
			carry = x >> 8;
		}
		while (carry > 0) {
			bytes.push(carry & 0xff);
			carry = carry >> 8;
		}
	}

	// Add leading zeros.
	for (let k = 0; k < zeros; k++) bytes.push(0);

	// Reverse (currently little-endian).
	bytes = bytes.reverse();
	return new Uint8Array(bytes);
}

function _isValidSolPubkey(v) {
	const bytes = _base58DecodeBytes(v);
	return !!bytes && bytes.length === 32;
}

function _readStored() {
	if (!_isBrowser()) return null;
	try {
		const raw = window.localStorage?.getItem(REF_KEY);
		if (!raw) return null;
		const obj = JSON.parse(raw);
		if (!obj || typeof obj !== "object") return null;
		if (!obj.ref || !_isValidSolPubkey(obj.ref)) return null;
		const expAt = Number(obj.expAt || 0);
		if (!Number.isFinite(expAt) || expAt <= 0) return null;
		return { ref: String(obj.ref), expAt };
	} catch {
		return null;
	}
}

function _writeStored(ref, expAt) {
	if (!_isBrowser()) return false;
	try {
		window.localStorage?.setItem(REF_KEY, JSON.stringify({ ref: String(ref), expAt: Number(expAt) }));
		return true;
	} catch {
		return false;
	}
}

export function clearReferral() {
	if (!_isBrowser()) return;
	try { window.localStorage?.removeItem(REF_KEY); } catch {}
	try { delete window.__fdvReferral; } catch {}
}

export function getActiveReferral(nowTs = _now()) {
	if (!_isBrowser()) return null;
	try {
		const mem = window.__fdvReferral;
		if (mem?.ref && _isValidSolPubkey(mem.ref) && Number(mem.expAt || 0) > nowTs) return { ref: String(mem.ref), expAt: Number(mem.expAt) };
	} catch {}

	const st = _readStored();
	if (!st) return null;
	if (Number(st.expAt || 0) <= nowTs) {
		clearReferral();
		return null;
	}
	try { window.__fdvReferral = st; } catch {}
	return st;
}

export function setReferral(ref, { ttlMs = REF_TTL_MS, nowTs = _now() } = {}) {
	if (!_isBrowser()) return null;
	const s = String(ref || "").trim();
	if (!_isValidSolPubkey(s)) return null;
	const expAt = nowTs + Math.max(1, Number(ttlMs || REF_TTL_MS));
	const obj = { ref: s, expAt };
	_writeStored(s, expAt);
	try { window.__fdvReferral = obj; } catch {}
	return obj;
}

export function captureReferralFromUrl({ stripParam = true } = {}) {
	if (!_isBrowser()) return null;
	try {
		const url = new URL(window.location.href);
		const ref = url.searchParams.get("ref") || url.searchParams.get("r") || "";
		const hadParam = !!ref;
		const stored = setReferral(ref);

		try {
			if (hadParam && !window.__fdvReferralCaptureLogged) {
				window.__fdvReferralCaptureLogged = true;
				if (stored?.ref) _bufferLog(`Referral captured: ${_shortPk(stored.ref)} (active 30 days)`);
				else _bufferLog(`Referral ignored: invalid address`, "warn");
			}
		} catch {}

		if (stored && stripParam) {
			try {
				url.searchParams.delete("ref");
				url.searchParams.delete("r");
				const next = url.pathname + (url.searchParams.toString() ? `?${url.searchParams.toString()}` : "") + (url.hash || "");
				window.history?.replaceState?.({}, "", next);
			} catch {}
		}
		return stored;
	} catch {
		return null;
	}
}

export function referralQueryParam({ nowTs = _now() } = {}) {
	const r = getActiveReferral(nowTs);
	return r?.ref ? `ref=${encodeURIComponent(r.ref)}` : "";
}

