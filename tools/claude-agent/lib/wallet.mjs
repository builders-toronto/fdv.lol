// Decode the Solana keypair from a profile and expose RPC helpers.
//
// Safety-first MVP: we ONLY use the secret to derive the public key (so we can
// query balances). No signing or transaction submission happens in this module.

const B58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = (() => {
	const map = new Map();
	for (let i = 0; i < B58_ALPHA.length; i += 1) map.set(B58_ALPHA[i], i);
	return map;
})();

export function b58encode(bytes) {
	let n = 0n;
	for (const b of bytes) n = (n << 8n) | BigInt(b);
	let out = "";
	while (n > 0n) {
		out = B58_ALPHA[Number(n % 58n)] + out;
		n /= 58n;
	}
	for (const b of bytes) {
		if (b !== 0) break;
		out = "1" + out;
	}
	return out;
}

export function b58decode(str) {
	const s = String(str || "");
	let n = 0n;
	for (const ch of s) {
		const v = B58_INDEX.get(ch);
		if (v === undefined) throw new Error(`Invalid base58 character: ${ch}`);
		n = n * 58n + BigInt(v);
	}
	// Count leading zeros (encoded as '1').
	let leadingZeros = 0;
	for (const ch of s) {
		if (ch !== "1") break;
		leadingZeros += 1;
	}
	const hex = n.toString(16);
	const paddedHex = hex.length % 2 ? "0" + hex : hex;
	const body = paddedHex === "00" ? new Uint8Array(0) : Buffer.from(paddedHex, "hex");
	const out = new Uint8Array(leadingZeros + body.length);
	out.set(body, leadingZeros);
	return out;
}

// Solana secret keys can arrive as either a base58 string (64 bytes) or a JSON
// byte-array stringified — both forms appear in the wild.
export function decodePubkeyFromSecret(secret) {
	const s = String(secret || "").trim();
	if (!s) throw new Error("wallet.secret is empty");
	let bytes;
	if (s.startsWith("[") && s.endsWith("]")) {
		const arr = JSON.parse(s);
		if (!Array.isArray(arr) || arr.length !== 64) {
			throw new Error("wallet.secret JSON array must be 64 bytes");
		}
		bytes = new Uint8Array(arr);
	} else {
		bytes = b58decode(s);
		if (bytes.length !== 64) {
			throw new Error(`wallet.secret base58 must decode to 64 bytes, got ${bytes.length}`);
		}
	}
	// Solana keypair layout: [seed(32) || pubkey(32)].
	const pubkeyBytes = bytes.subarray(32);
	return b58encode(pubkeyBytes);
}

export function deriveWalletPubkey(profile) {
	const secret = profile?.wallet?.secret || profile?.autoWalletSecret || "";
	if (!secret) throw new Error("Profile is missing wallet.secret");
	return decodePubkeyFromSecret(secret);
}

// Minimal Solana JSON-RPC client (no @solana/web3.js dependency).
export function createRpcClient({ url, headers = {}, fetchFn }) {
	const _fetch = typeof fetchFn === "function" ? fetchFn : (typeof fetch !== "undefined" ? fetch : null);
	if (!_fetch) throw new Error("fetch unavailable");
	const baseHeaders = { "Content-Type": "application/json", ...(headers || {}) };
	let nextId = 1;

	async function call(method, params = []) {
		const body = JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params });
		const resp = await _fetch(url, { method: "POST", headers: baseHeaders, body });
		if (!resp.ok) {
			const txt = await resp.text().catch(() => "");
			throw new Error(`RPC HTTP ${resp.status}: ${txt.slice(0, 200)}`);
		}
		const json = await resp.json();
		if (json?.error) throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
		return json?.result;
	}

	return {
		call,
		async getSolBalanceLamports(pubkey) {
			const result = await call("getBalance", [pubkey, { commitment: "confirmed" }]);
			return Number(result?.value ?? 0);
		},
		async getTokenAccountsByOwner(pubkey) {
			const result = await call("getTokenAccountsByOwner", [
				pubkey,
				{ programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
				{ encoding: "jsonParsed", commitment: "confirmed" },
			]);
			const list = Array.isArray(result?.value) ? result.value : [];
			const out = [];
			for (const acct of list) {
				try {
					const info = acct?.account?.data?.parsed?.info;
					if (!info) continue;
					const amount = info?.tokenAmount;
					const uiAmount = Number(amount?.uiAmount ?? 0);
					if (!Number.isFinite(uiAmount) || uiAmount <= 0) continue;
					out.push({
						mint: String(info.mint || ""),
						uiAmount,
						decimals: Number(amount?.decimals ?? 0),
						amountRaw: String(amount?.amount || "0"),
					});
				} catch {}
			}
			return out;
		},
	};
}

export function lamportsToSol(lamports) {
	return Number(lamports || 0) / 1_000_000_000;
}
