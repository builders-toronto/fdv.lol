import { importFromUrlWithFallback } from "../../../../../utils/netImport.js";
import { FDV_LEDGER_BASE } from "../../../../../config/env.js";

let _naclPromise = null;

async function loadNacl() {
	if (_naclPromise) return _naclPromise;
	const urls = [
		"https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/+esm",
		"https://esm.sh/tweetnacl@1.0.3?bundle",
	];
	_naclPromise = importFromUrlWithFallback(urls, { cacheKey: "fdv:nacl@1.0.3" }).then((m) => m?.default || m);
	return _naclPromise;
}

function pickBaseUrl() {
	try {
		const w = typeof window !== "undefined" ? window : null;
		const override = w && (w.FDV_LEDGER_BASE || w.__FDV_LEDGER_BASE);
		return String(override || FDV_LEDGER_BASE || "").trim();
	} catch {
		return String(FDV_LEDGER_BASE || "").trim();
	}
}

function mkRegisterMessage(pubkey, ts, nonce) {
	return `fdv.lol:register:${pubkey}:${ts}:${nonce}`;
}

function mkReportMessage(pubkey, ts, nonce, payload) {
	return `fdv.lol:report:${pubkey}:${ts}:${nonce}:${payload}`;
}

function stableStringify(value) {
	const seen = new WeakSet();
	const helper = (v) => {
		if (v === null) return "null";
		const t = typeof v;
		if (t === "number") return Number.isFinite(v) ? String(v) : "null";
		if (t === "boolean") return v ? "true" : "false";
		if (t === "string") return JSON.stringify(v);
		if (t === "bigint") return JSON.stringify(String(v));
		if (t === "undefined" || t === "function" || t === "symbol") return "null";
		if (Array.isArray(v)) return `[${v.map((x) => helper(x)).join(",")}]`;
		if (t === "object") {
			if (seen.has(v)) return "null";
			seen.add(v);
			const keys = Object.keys(v).sort();
			const parts = [];
			for (const k of keys) {
				const val = v[k];
				if (typeof val === "undefined" || typeof val === "function" || typeof val === "symbol") continue;
				parts.push(`${JSON.stringify(k)}:${helper(val)}`);
			}
			return `{${parts.join(",")}}`;
		}
		return "null";
	};
	return helper(value);
}

function randNonce(len = 12) {
	try {
		const a = new Uint8Array(len);
		crypto.getRandomValues(a);
		return Array.from(a)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	} catch {
		return String(Math.random()).slice(2) + String(Date.now());
	}
}

function clampInt(v, lo, hi) {
	v = Number(v);
	if (!Number.isFinite(v)) v = lo;
	return Math.max(lo, Math.min(hi, Math.floor(v)));
}

export async function registerFdvWallet({ pubkey, keypair, bs58 } = {}) {
	try {
		const base = pickBaseUrl();
		const basePrefix = base ? base.replace(/\/$/, "") : "";
		const pk = String(pubkey || keypair?.publicKey?.toBase58?.() || "").trim();
		if (!pk) return { ok: false, error: "NO_PUBKEY" };
		if (!keypair?.secretKey || !keypair?.secretKey?.length) return { ok: false, error: "NO_KEYPAIR" };

		const b58 = bs58?.default || bs58;
		if (!b58 || typeof b58.encode !== "function") return { ok: false, error: "NO_BS58" };

		const nacl = await loadNacl();
		const ts = Date.now();
		const nonce = randNonce(clampInt(12, 6, 32));
		const msg = mkRegisterMessage(pk, ts, nonce);
		const msgBytes = new TextEncoder().encode(msg);
		const sigBytes = nacl.sign.detached(msgBytes, keypair.secretKey);
		const sig = b58.encode(sigBytes);

		const r = await fetch(`${basePrefix}/api/ledger/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ pubkey: pk, ts, nonce, sig }),
		});
		if (!r.ok) {
			const j = await r.json().catch(() => null);
			return { ok: false, status: r.status, error: j?.error || "HTTP_FAIL", reason: j?.reason || "" };
		}
		return await r.json().catch(() => ({ ok: true }));
	} catch (e) {
		return { ok: false, error: "ERR", message: String(e?.message || e || "") };
	}
}

export async function reportFdvStats({ pubkey, keypair, bs58, metrics, kind } = {}) {
	try {
		const base = pickBaseUrl();
		const basePrefix = base ? base.replace(/\/$/, "") : "";
		const pk = String(pubkey || keypair?.publicKey?.toBase58?.() || "").trim();
		if (!pk) return { ok: false, error: "NO_PUBKEY" };
		if (!keypair?.secretKey || !keypair?.secretKey?.length) return { ok: false, error: "NO_KEYPAIR" };

		const b58 = bs58?.default || bs58;
		if (!b58 || typeof b58.encode !== "function") return { ok: false, error: "NO_BS58" };

		const mIn = (metrics && typeof metrics === "object") ? metrics : {};
		let kindStr = String((kind ?? mIn.kind) ?? "auto");
		kindStr = kindStr.replace(/\s+/g, " ").trim();
		if (kindStr.length > 32) kindStr = kindStr.slice(0, 32);
		if (!kindStr) kindStr = "auto";
		const m = { ...mIn, kind: kindStr };

		const nacl = await loadNacl();
		const ts = Date.now();
		const nonce = randNonce(clampInt(12, 6, 32));
		const payload = stableStringify(m);
		if (payload.length > 4000) return { ok: false, error: "PAYLOAD_TOO_LARGE" };
		const msg = mkReportMessage(pk, ts, nonce, payload);
		const msgBytes = new TextEncoder().encode(msg);
		const sigBytes = nacl.sign.detached(msgBytes, keypair.secretKey);
		const sig = b58.encode(sigBytes);

		const r = await fetch(`${basePrefix}/api/ledger/report`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ pubkey: pk, ts, nonce, sig, payload }),
		});
		if (!r.ok) {
			const j = await r.json().catch(() => null);
			return { ok: false, status: r.status, error: j?.error || "HTTP_FAIL", reason: j?.reason || "" };
		}
		return await r.json().catch(() => ({ ok: true }));
	} catch (e) {
		return { ok: false, error: "ERR", message: String(e?.message || e || "") };
	}
}
