import { createDex } from "../lib/dex.js";
import {
	SOL_MINT,
	TX_FEE_BUFFER_LAMPORTS,
	MIN_SELL_CHUNK_SOL,
	SMALL_SELL_FEE_FLOOR,
	EDGE_TX_FEE_ESTIMATE_LAMPORTS,
	MIN_QUOTE_RAW_AMOUNT,
	MAX_CONSEC_SWAP_400,
	ROUTER_COOLDOWN_MS,
	MINT_RUG_BLACKLIST_MS,
	SPLIT_FRACTIONS,
	FEE_ATAS,
	AUTO_CFG,
} from "../lib/constants.js";
import { rpcWait, rpcBackoffLeft, markRpcStress } from "../lib/rpcThrottle.js";
import { loadSplToken } from "../../../../core/solana/splToken.js";

let _web3Promise;
let _bs58Promise;
let _connPromise;

async function importWithFallback(urls) {
	let lastErr;
	for (const url of urls) {
		try {
			return await import(url);
		} catch (e) {
			lastErr = e;
		}
	}
	throw lastErr || new Error("IMPORT_FAILED");
}

export async function loadWeb3() {
	if (_web3Promise) return _web3Promise;
	_web3Promise = (async () =>
		importWithFallback([
			"https://cdn.jsdelivr.net/npm/@solana/web3.js@1.95.4/+esm",
			"https://esm.sh/@solana/web3.js@1.95.4?bundle",
		]))();
	return _web3Promise;
}

async function loadBs58() {
	if (_bs58Promise) return _bs58Promise;
	_bs58Promise = (async () =>
		importWithFallback([
			"https://cdn.jsdelivr.net/npm/bs58@6.0.0/+esm",
			"https://esm.sh/bs58@6.0.0?bundle",
		]))();
	return _bs58Promise;
}

async function getBs58() {
	const mod = await loadBs58();
	if (
		mod?.default &&
		typeof mod.default.decode === "function" &&
		typeof mod.default.encode === "function"
	) {
		return mod.default;
	}
	if (typeof mod?.decode === "function" && typeof mod?.encode === "function") {
		return mod;
	}
	return mod?.default || mod;
}

const AUTO_LS_KEY = "fdv_auto_bot_v1";
const FOLLOW_LS_KEY = "fdv_follow_bot_v1";

function _readAutoStateRaw() {
	try {
		return typeof localStorage !== "undefined" ? localStorage.getItem(AUTO_LS_KEY) : null;
	} catch {
		return null;
	}
}

function _readFollowStateRaw() {
	try {
		return typeof localStorage !== "undefined" ? localStorage.getItem(FOLLOW_LS_KEY) : null;
	} catch {
		return null;
	}
}

function _writeFollowStateRaw(obj) {
	try {
		if (typeof localStorage === "undefined") return false;
		localStorage.setItem(FOLLOW_LS_KEY, JSON.stringify(obj || {}));
		return true;
	} catch {
		return false;
	}
}

function getExistingAutoWalletMeta() {
	try {
		const raw = _readAutoStateRaw();
		const parsed = raw ? JSON.parse(raw) || {} : {};
		const keys = Object.keys(parsed || {});
		const importantKeys = [
			"autoWalletPub",
			"autoWalletSecret",
			"secretKeyB58",
			"secretKey",
			"sk",
			"secretKeyBytes",
			"secretKeyArray",
		];
		const hasImportant = new Set(importantKeys.filter((k) => k in (parsed || {})));
		return {
			hasSecret:
				!!String(
					parsed?.autoWalletSecret ||
						parsed?.secretKeyB58 ||
						parsed?.secretKey ||
						parsed?.sk ||
						"",
				).trim() ||
				Array.isArray(parsed?.secretKeyBytes) ||
				Array.isArray(parsed?.secretKeyArray),
			autoWalletPub: String(parsed?.autoWalletPub || "").trim(),
			keys: [...Array.from(hasImportant), ...keys.filter((k) => !hasImportant.has(k)).slice(0, 40)],
			rawLen: typeof raw === "string" ? raw.length : 0,
		};
	} catch {
		return { hasSecret: false, autoWalletPub: "", keys: [] };
	}
}

async function debugAutoWalletLoad(log) {
	try {
		const meta = getExistingAutoWalletMeta();
		log(
			`Auto wallet cache: rawLen=${meta.rawLen || 0} hasSecret=${!!meta.hasSecret} pub=${
				meta.autoWalletPub ? meta.autoWalletPub.slice(0, 6) + "…" : "(none)"
			}`,
			"help",
		);
		const raw = _readAutoStateRaw();
		if (!raw) {
			log("Auto wallet cache read: localStorage missing/blocked or key not set.", "warn");
			return;
		}
		const parsed = JSON.parse(raw) || {};
		const skStr = String(
			parsed?.autoWalletSecret || parsed?.secretKeyB58 || parsed?.secretKey || parsed?.sk || "",
		).trim();
		if (!skStr && !Array.isArray(parsed?.secretKeyBytes) && !Array.isArray(parsed?.secretKeyArray)) {
			log("Auto wallet secret missing in cache (no autoWalletSecret/secretKeyB58/secretKey/sk).", "warn");
			return;
		}

		const bs58 = await getBs58();
		const { Keypair } = await loadWeb3();

		let secretBytes;
		if (Array.isArray(parsed?.secretKeyBytes)) secretBytes = Uint8Array.from(parsed.secretKeyBytes);
		else if (Array.isArray(parsed?.secretKeyArray)) secretBytes = Uint8Array.from(parsed.secretKeyArray);
		else secretBytes = bs58.decode(skStr);

		const kp = Keypair.fromSecretKey(secretBytes);
		const derivedPub = kp.publicKey.toBase58();
		if (meta.autoWalletPub && derivedPub !== meta.autoWalletPub) {
			log(
				`Auto wallet pub mismatch: cache pub=${meta.autoWalletPub.slice(0, 6)}… derived pub=${derivedPub.slice(0, 6)}…`,
				"warn",
			);
		} else {
			log(`Auto wallet loaded OK: ${derivedPub.slice(0, 6)}…`, "ok");
		}
	} catch (e) {
		log(`Auto wallet load debug failed: ${String(e?.message || e || "")}`, "error");
	}
}

async function getAutoKeypair() {
	try {
		const raw = _readAutoStateRaw();
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		const skB58 =
			parsed?.autoWalletSecret || parsed?.secretKeyB58 || parsed?.secretKey || parsed?.sk;

		const bs58 = await getBs58();
		const { Keypair } = await loadWeb3();

		if (Array.isArray(parsed?.secretKeyBytes)) return Keypair.fromSecretKey(Uint8Array.from(parsed.secretKeyBytes));
		if (Array.isArray(parsed?.secretKeyArray)) return Keypair.fromSecretKey(Uint8Array.from(parsed.secretKeyArray));

		if (typeof skB58 === "string") {
			const s = skB58.trim();
			if (!s) return null;
			if (s.startsWith("[") && s.endsWith("]")) {
				try {
					const arr = JSON.parse(s);
					if (Array.isArray(arr)) return Keypair.fromSecretKey(Uint8Array.from(arr));
				} catch {}
			}
			const secretKey = bs58.decode(s);
			return Keypair.fromSecretKey(secretKey);
		}
		return null;
	} catch {
		return null;
	}
}

async function isValidPubkeyStr(s) {
	try {
		const { PublicKey } = await loadWeb3();
		new PublicKey(String(s));
		return true;
	} catch {
		return false;
	}
}

function currentRpcUrl() {
	const fromState = state?.rpcUrl ? String(state.rpcUrl) : "";
	const fromLs = typeof localStorage !== "undefined" ? String(localStorage.getItem("fdv_rpc_url") || "") : "";
	return (fromState || fromLs || "https://api.mainnet-beta.solana.com").trim();
}

function currentRpcHeaders() {
	const h = state?.rpcHeaders ? state.rpcHeaders : null;
	if (h && typeof h === "object") return h;
	try {
		const raw = typeof localStorage !== "undefined" ? localStorage.getItem("fdv_rpc_headers") : "";
		if (!raw) return {};
		const parsed = JSON.parse(String(raw));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

async function getConn() {
	const url = currentRpcUrl();
	if (_connPromise && _connPromise._url === url) return _connPromise;
	const { Connection } = await loadWeb3();
	const headers = currentRpcHeaders();
	const conn = new Connection(url, {
		commitment: "confirmed",
		wsEndpoint: undefined,
		httpHeaders: headers && Object.keys(headers).length ? headers : undefined,
	});
	conn._url = url;
	_connPromise = Promise.resolve(conn);
	_connPromise._url = url;
	return conn;
}

async function confirmSig(sig, opts = {}) {
	const conn = await getConn();
	const commitment = opts.commitment || "confirmed";
	const timeoutMs = Number(opts.timeoutMs || 20_000);

	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const st = await conn.getSignatureStatus(sig, { searchTransactionHistory: true });
			const cs = st?.value?.confirmationStatus;
			if (st?.value && !st.value.err) {
				if (commitment === "processed") return true;
				if (commitment === "confirmed" && (cs === "confirmed" || cs === "finalized")) return true;
				if (commitment === "finalized" && cs === "finalized") return true;
			}
		} catch {}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error("CONFIRM_TIMEOUT");
}

async function tokenAccountRentLamports() {
	try {
		const conn = await getConn();
		return await conn.getMinimumBalanceForRentExemption(165);
	} catch {
		return 0;
	}
}

async function _detectTokenProgramIdForMint(mintStr) {
	try {
		if (!mintStr) return null;
		const { PublicKey } = await loadWeb3();
		const conn = await getConn();
		const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await loadSplToken();
		const mintPk = new PublicKey(mintStr);
		const ai = await conn.getAccountInfo(mintPk, "confirmed");
		if (!ai?.owner) return null;

		const ownerStr = ai.owner.toBase58 ? ai.owner.toBase58() : String(ai.owner);
		const pid1 = TOKEN_PROGRAM_ID?.toBase58 ? TOKEN_PROGRAM_ID.toBase58() : String(TOKEN_PROGRAM_ID || "");
		const pid2 = TOKEN_2022_PROGRAM_ID?.toBase58 ? TOKEN_2022_PROGRAM_ID.toBase58() : String(TOKEN_2022_PROGRAM_ID || "");
		if (pid2 && ownerStr === pid2) return TOKEN_2022_PROGRAM_ID;
		if (pid1 && ownerStr === pid1) return TOKEN_PROGRAM_ID;
		return null;
	} catch {
		return null;
	}
}

async function _tokenAccountRentLamportsForMint(mintStr) {
	try {
		const conn = await getConn();
		const base = await tokenAccountRentLamports();

		// Token-2022 token accounts can be larger (extensions), so rent can exceed 165-byte account rent.
		const pid = await _detectTokenProgramIdForMint(mintStr);
		const { TOKEN_2022_PROGRAM_ID } = await loadSplToken();
		const is2022 = !!(pid && TOKEN_2022_PROGRAM_ID && pid.toBase58 && TOKEN_2022_PROGRAM_ID.toBase58 && pid.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58());
		if (!is2022) return base;

		const enlarged = await conn.getMinimumBalanceForRentExemption(300);
		const n1 = Number(base || 0);
		const n2 = Number(enlarged || 0);
		return Math.max(Number.isFinite(n1) ? n1 : 0, Number.isFinite(n2) ? n2 : 0);
	} catch {
		return await tokenAccountRentLamports();
	}
}

async function requiredAtaLamportsForSwap(ownerStr, _inMint, outMint) {
	try {
		if (!ownerStr || !outMint || outMint === SOL_MINT) return 0;
		const { PublicKey } = await loadWeb3();
		const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await loadSplToken();
		const conn = await getConn();
		const owner = new PublicKey(ownerStr);
		const mint = new PublicKey(outMint);

		const detectedPid = await _detectTokenProgramIdForMint(outMint);
		const candidatePids = detectedPid
			? [detectedPid]
			: [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].filter(Boolean);

		for (const pid of candidatePids) {
			try {
				const ataAny = await getAssociatedTokenAddress(mint, owner, false, pid);
				const ata = typeof ataAny === "string" ? new PublicKey(ataAny) : ataAny;
				if (!ata) continue;
				const ai = await conn.getAccountInfo(ata, "confirmed");
				if (ai) return 0;
			} catch {}
		}

		return await _tokenAccountRentLamportsForMint(outMint);
	} catch {
		return 0;
	}
}

async function requiredWsolAtaRentLamportsIfMissing(ownerStr) {
	try {
		if (!ownerStr) return 0;
		const { PublicKey } = await loadWeb3();
		const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await loadSplToken();
		const conn = await getConn();
		const owner = new PublicKey(ownerStr);
		const mint = new PublicKey(SOL_MINT);
		const pids = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].filter(Boolean);
		for (const pid of pids) {
			try {
				const ataAny = await getAssociatedTokenAddress(mint, owner, false, pid);
				const ata = typeof ataAny === "string" ? new PublicKey(ataAny) : ataAny;
				if (!ata) continue;
				const ai = await conn.getAccountInfo(ata, "confirmed");
				if (ai) return 0;
			} catch {}
		}
		return await tokenAccountRentLamports();
	} catch {
		return 0;
	}
}

function getPlatformFeeBps() {
	return 1;
}

async function safeGetDecimalsFast(mint) {
	if (!mint) return 6;
	if (mint === SOL_MINT) return 9;
	try {
		const { PublicKey } = await loadWeb3();
		const conn = await getConn();
		const info = await conn.getParsedAccountInfo(new PublicKey(mint), "confirmed");
		const d = Number(info?.value?.data?.parsed?.info?.decimals);
		return Number.isFinite(d) ? d : 6;
	} catch {
		return 6;
	}
}

function getCfg() {
	return AUTO_CFG;
}

async function getTokenBalanceUiByMint(ownerPkOrStr, mintStr) {
	try {
		if (!ownerPkOrStr || !mintStr || mintStr === SOL_MINT) return { sizeUi: 0, decimals: 0 };
		const { PublicKey } = await loadWeb3();
		const conn = await getConn();
		const owner = typeof ownerPkOrStr === "string" ? new PublicKey(ownerPkOrStr) : ownerPkOrStr;
		const mint = new PublicKey(mintStr);

		const res = await conn.getParsedTokenAccountsByOwner(owner, { mint }, "confirmed");
		const v = res?.value || [];
		let totalUi = 0;
		let decimals = null;
		for (const it of v) {
			const amt = it?.account?.data?.parsed?.info?.tokenAmount;
			const ui = Number(amt?.uiAmount);
			if (Number.isFinite(ui)) totalUi += ui;
			const d = Number(amt?.decimals);
			if (Number.isFinite(d)) decimals = d;
		}
		if (!Number.isFinite(totalUi)) totalUi = 0;
		return { sizeUi: totalUi, decimals: Number.isFinite(decimals) ? decimals : await safeGetDecimalsFast(mintStr) };
	} catch {
		return { sizeUi: 0, decimals: 0 };
	}
}

async function getSolBalanceUi(ownerPkOrStr) {
	try {
		if (!ownerPkOrStr) return 0;
		const { PublicKey } = await loadWeb3();
		const conn = await getConn();
		const owner = typeof ownerPkOrStr === "string" ? new PublicKey(ownerPkOrStr) : ownerPkOrStr;
		const lamports = await conn.getBalance(owner, "confirmed");
		const ui = Number(lamports || 0) / 1e9;
		return Number.isFinite(ui) ? ui : 0;
	} catch {
		return 0;
	}
}

let _dex;
function getDex() {
	if (_dex) return _dex;
	_dex = createDex({
		SOL_MINT,
		MIN_QUOTE_RAW_AMOUNT,
		MIN_SELL_CHUNK_SOL,
		MAX_CONSEC_SWAP_400,
		ROUTER_COOLDOWN_MS,
		TX_FEE_BUFFER_LAMPORTS,
		EDGE_TX_FEE_ESTIMATE_LAMPORTS,
		SMALL_SELL_FEE_FLOOR,
		SPLIT_FRACTIONS,
		MINT_RUG_BLACKLIST_MS,
		FEE_ATAS,

		now: () => Date.now(),
		log: (m, t) => log(m, t),
		logObj: (l, o) => logObj(l, o),
		getState: () => state,

		getConn,
		loadWeb3,
		loadSplToken,
		rpcWait,
		rpcBackoffLeft,
		markRpcStress,

		getCfg,
		isValidPubkeyStr,

		getPlatformFeeBps,
		tokenAccountRentLamports,
		requiredAtaLamportsForSwap,
		requiredOutAtaRentIfMissing: async () => 0,
		shouldAttachFeeForSell: () => false,
		minSellNotionalSol: () => 0,
		safeGetDecimalsFast,

		confirmSig,
	});
	return _dex;
}

// UI + logging
const MAX_LOG_ENTRIES = 120;
let logEl, startBtn, stopBtn;
let targetEl, buySolEl, slipEl, pollEl;
let statusEl, rpcEl, activeEl;

function log(msg, type = "info") {
	try {
		const line = `[${new Date().toLocaleTimeString()}] ${String(msg ?? "")}`;
		if (logEl) {
			const div = document.createElement("div");
			div.textContent = line;
			div.className = `fdv-log-line ${type}`;
			logEl.appendChild(div);
			while (logEl.children.length > MAX_LOG_ENTRIES) logEl.removeChild(logEl.firstChild);
			logEl.scrollTop = logEl.scrollHeight;
		}
	} catch {}
}

function logObj(label, obj) {
	try {
		log(`${label}: ${JSON.stringify(obj)}`, "help");
	} catch {}
}

function clampNum(n, min, max, fallback = min) {
	const v = Number(n);
	if (!Number.isFinite(v)) return fallback;
	return Math.max(min, Math.min(max, v));
}

// Follow state
let state = {
	enabled: false,
	targetWallet: "",
	activeMint: "",
	lastSig: "",
	pollMs: 1500,
	buySol: 0.1,
	slippageBps: 250,
	rpcUrl: "",
	rpcHeaders: {},
	pendingAction: "", // "buy" | "sell" | ""
	pendingSig: "",
	pendingAttempts: 0,
	pendingLastTryAt: 0,
	pendingSince: 0,
	lastActionAttempt: 0,
};

function loadState() {
	try {
		const raw = _readFollowStateRaw();
		if (!raw) return;
		const parsed = JSON.parse(raw) || {};
		state = {
			...state,
			...parsed,
			enabled: false, // never auto-run
		};
	} catch {}
}

function saveState() {
	_writeFollowStateRaw({
		targetWallet: String(state.targetWallet || "").trim(),
		activeMint: String(state.activeMint || "").trim(),
		lastSig: String(state.lastSig || "").trim(),
		pollMs: Number(state.pollMs || 1500),
		buySol: Number(state.buySol || 0.1),
		slippageBps: Number(state.slippageBps || 250),
		rpcUrl: String(state.rpcUrl || "").trim(),
		rpcHeaders: state.rpcHeaders && typeof state.rpcHeaders === "object" ? state.rpcHeaders : {},
		pendingAction: String(state.pendingAction || ""),
		pendingSig: String(state.pendingSig || ""),
		pendingAttempts: Number(state.pendingAttempts || 0),
		pendingLastTryAt: Number(state.pendingLastTryAt || 0),
		pendingSince: Number(state.pendingSince || 0),
	});
}

const PENDING_MAX_MS = 240_000;
const PENDING_RETRY_GAP_MS = 25_000;
const PENDING_MAX_ATTEMPTS = 2;

// Only ever deploy a portion of the wallet into a followed mint.
// Leaving SOL behind ensures we can pay fees / swap out later.
const FOLLOW_BUY_MAX_FRACTION_OF_SOL = 0.7;

async function _getSigStatus(sig) {
	try {
		const conn = await getConn();
		const st = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
		return st?.value?.[0] || null;
	} catch {
		return null;
	}
}

async function _checkPendingBuy() {
	try {
		if (state.pendingAction !== "buy" || !state.activeMint) return false;
		const sig = String(state.pendingSig || "");
		if (!sig) return false;

		const autoKp = await getAutoKeypair();
		if (!autoKp) return false;

		const ownerStr = autoKp.publicKey.toBase58();
		// Balance is authoritative: if tokens arrived, consider the buy successful even if the sig is hard to confirm.
		const bal0 = await getTokenBalanceUiByMint(ownerStr, state.activeMint);
		if (Number(bal0?.sizeUi || 0) > 0) {
			log(`Pending BUY resolved by balance: ${Number(bal0.sizeUi).toFixed(6)}`, "ok");
			state.pendingAction = "";
			state.pendingSig = "";
			state.pendingAttempts = 0;
			state.pendingLastTryAt = 0;
			saveState();
			updateUI();
			return true;
		}

		const elapsed = Date.now() - Number(state.pendingSince || 0);
		const st = await _getSigStatus(sig);
		if (st && st.err) {
			log(`Pending BUY failed on-chain: ${JSON.stringify(st.err).slice(0, 180)}`, "warn");
			// Allow reattempt
			state.pendingSig = "";
		}

		// If it's taking too long or status is missing, try once or twice to re-send.
		const canRetry =
			(state.pendingAttempts || 0) < PENDING_MAX_ATTEMPTS &&
			(Date.now() - Number(state.pendingLastTryAt || 0)) > PENDING_RETRY_GAP_MS;

		const looksStuck = !st || st.confirmationStatus !== "confirmed" && st.confirmationStatus !== "finalized";
		if (canRetry && looksStuck && elapsed > 30_000) {
			state.pendingAttempts = Number(state.pendingAttempts || 0) + 1;
			state.pendingLastTryAt = Date.now();
			saveState();
			updateUI();
			log(`Pending BUY still not confirmed; retrying (attempt ${state.pendingAttempts}/${PENDING_MAX_ATTEMPTS})…`, "help");
			const r = await mirrorBuy(state.activeMint);
			if (r?.sig) {
				state.pendingSig = String(r.sig);
				state.pendingSince = Date.now();
				saveState();
				updateUI();
			}
		}

		if (elapsed > PENDING_MAX_MS) {
			log(`Pending BUY expired (${(PENDING_MAX_MS / 1000) | 0}s). Clearing.`, "warn");
			state.pendingAction = "";
			state.pendingSig = "";
			state.pendingAttempts = 0;
			state.pendingLastTryAt = 0;
			state.activeMint = "";
			saveState();
			updateUI();
			return false;
		}
		log("Pending BUY: waiting for confirm/balance…", "help");
		return false;
	} catch {
		return false;
	}
}

async function _checkPendingSell() {
	try {
		if (state.pendingAction !== "sell" || !state.activeMint) return false;
		const sig = String(state.pendingSig || "");
		if (!sig) return false;

		const autoKp = await getAutoKeypair();
		if (autoKp) {
			const ownerStr = autoKp.publicKey.toBase58();
			const bal0 = await getTokenBalanceUiByMint(ownerStr, state.activeMint);
			if (!(Number(bal0?.sizeUi || 0) > 0)) {
				log("Pending SELL resolved by balance (now empty).", "ok");
				state.pendingAction = "";
				state.pendingSig = "";
				state.pendingAttempts = 0;
				state.pendingLastTryAt = 0;
				state.activeMint = "";
				saveState();
				updateUI();
				return true;
			}
		}

		const elapsed = Date.now() - Number(state.pendingSince || 0);
		const st = await _getSigStatus(sig);
		const confirmed = !!st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized");
		if (!confirmed) {
			if (Date.now() - Number(state.pendingSince || 0) > PENDING_MAX_MS) {
				log(`Pending SELL expired (${(PENDING_MAX_MS / 1000) | 0}s). Clearing.`, "warn");
				state.pendingAction = "";
				state.pendingSig = "";
				state.pendingAttempts = 0;
				state.pendingLastTryAt = 0;
				state.activeMint = "";
				saveState();
				updateUI();
			}
			return false;
		}
		log("Pending SELL confirmed.", "ok");
		state.pendingAction = "";
		state.pendingSig = "";
		state.pendingAttempts = 0;
		state.pendingLastTryAt = 0;
		state.activeMint = "";
		saveState();
		updateUI();
		return true;
	} catch {
		return false;
	}
}

function updateUI() {
	try {
		if (targetEl) targetEl.value = String(state.targetWallet || "");
		if (buySolEl) buySolEl.value = String(state.buySol ?? "");
		if (slipEl) slipEl.value = String(state.slippageBps ?? "");
		if (pollEl) pollEl.value = String(state.pollMs ?? "");
		if (activeEl) activeEl.textContent = state.activeMint ? state.activeMint : "(none)";
		if (statusEl) {
			statusEl.textContent = state.enabled
				? `Running${state.pendingAction ? ` (pending ${state.pendingAction})` : ""}`
				: "Stopped";
		}
		if (rpcEl) rpcEl.textContent = `RPC: ${currentRpcUrl()}`;
		if (startBtn) startBtn.disabled = !!state.enabled;
		if (stopBtn) stopBtn.disabled = !state.enabled;
	} catch {}
}

let _timer = null;
let _pollInFlight = false;

function delay(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function _sumTokenBalances(arr, ownerStr) {
	const out = new Map();
	const a = Array.isArray(arr) ? arr : [];
	for (const it of a) {
		const mint = String(it?.mint || "");
		if (!mint) continue;
		const owner = String(it?.owner || "");
		if (!owner || owner !== ownerStr) continue;
		const ui =
			Number(it?.uiTokenAmount?.uiAmount) ||
			Number(it?.uiTokenAmount?.uiAmountString) ||
			0;
		const prev = out.get(mint) || 0;
		out.set(mint, prev + ui);
	}
	return out;
}

function _pickLargestDelta(mintToDelta, predicate) {
	let best = null;
	for (const [mint, delta] of mintToDelta.entries()) {
		const d = Number(delta || 0);
		if (!predicate(mint, d)) continue;
		if (!best || Math.abs(d) > Math.abs(best.delta)) best = { mint, delta: d };
	}
	return best;
}

async function extractBuySellForTarget(sig, targetOwnerStr) {
	try {
		const conn = await getConn();
		const tx = await conn.getTransaction(sig, {
			commitment: "confirmed",
			maxSupportedTransactionVersion: 0,
		});
		if (!tx || tx?.meta?.err) return null;

		const pre = _sumTokenBalances(tx?.meta?.preTokenBalances, targetOwnerStr);
		const post = _sumTokenBalances(tx?.meta?.postTokenBalances, targetOwnerStr);
		const mints = new Set([...pre.keys(), ...post.keys()]);
		if (!mints.size) return null;

		const deltas = new Map();
		for (const m of mints) {
			const d = (post.get(m) || 0) - (pre.get(m) || 0);
			if (Math.abs(d) > 1e-12) deltas.set(m, d);
		}
		if (!deltas.size) return null;

		const buy = _pickLargestDelta(deltas, (mint, d) => d > 0 && mint !== SOL_MINT);
		const sell = _pickLargestDelta(deltas, (mint, d) => d < 0 && mint !== SOL_MINT);
		return { buy, sell, sig };
	} catch (e) {
		markRpcStress?.(e, 1500);
		return null;
	}
}

async function classifyTargetSwap(sig, targetOwnerStr) {
	const info = await extractBuySellForTarget(sig, targetOwnerStr);
	if (!info) return null;

	const { buy, sell } = info;

	if (state.activeMint && sell?.mint === state.activeMint) {
		return { type: "sell", mint: sell.mint, deltaUi: sell.delta, sig };
	}
	if (!state.activeMint && buy) {
		return { type: "buy", mint: buy.mint, deltaUi: buy.delta, sig };
	}

	// Otherwise, ignore.
	return null;
}

async function fetchNewSignatures(targetPkStr) {
	const { PublicKey } = await loadWeb3();
	const conn = await getConn();
	const pk = new PublicKey(targetPkStr);
	const sigs = await conn.getSignaturesForAddress(pk, { limit: 25 }, "confirmed");
	const list = Array.isArray(sigs) ? sigs : [];
	if (!list.length) return [];

	const last = String(state.lastSig || "");
	if (!last) {
		state.lastSig = String(list[0]?.signature || "");
		saveState();
		return [];
	}

	const idx = list.findIndex((x) => String(x?.signature || "") === last);
	if (idx === 0) return [];

	const slice = idx > 0 ? list.slice(0, idx) : list;
	const ordered = slice
		.map((x) => String(x?.signature || ""))
		.filter(Boolean)
		.reverse();

	// update lastSig to newest we saw
	const newest = String(list[0]?.signature || "");
	if (newest) {
		state.lastSig = newest;
		saveState();
	}

	return ordered;
}

async function mirrorBuy(mint) {
	const desiredSol = clampNum(state.buySol, 0.001, 20, 0.1);
	const slip = Math.floor(clampNum(state.slippageBps, 10, 20_000, 250));
	const autoKp = await getAutoKeypair();
	if (!autoKp) {
		log("No auto wallet configured. Set/import it in the Auto tab first.", "error");
		await debugAutoWalletLoad(log);
		return { ok: false, sig: "" };
	}

	const ownerStr = autoKp.publicKey.toBase58();
	const solBalUi = await getSolBalanceUi(autoKp.publicKey);
	const ataRentLamports = await requiredAtaLamportsForSwap(ownerStr, SOL_MINT, mint);
	const wsolAtaRentLamports = await requiredWsolAtaRentLamportsIfMissing(ownerStr);
	const reserveLamports =
		Number(TX_FEE_BUFFER_LAMPORTS || 0) +
		Number(EDGE_TX_FEE_ESTIMATE_LAMPORTS || 0) +
		Number(ataRentLamports || 0) +
		Number(wsolAtaRentLamports || 0);
	const maxSpendSol = Math.max(0, solBalUi - reserveLamports / 1e9);
	const maxByFractionSol = Math.max(0, Number(solBalUi || 0) * FOLLOW_BUY_MAX_FRACTION_OF_SOL);
	const buySol = Math.min(desiredSol, maxSpendSol, maxByFractionSol);
	if (!(buySol >= 0.001)) {
		log(
			`BUY skipped: insufficient SOL. balance=${solBalUi.toFixed(4)} reserve≈${(reserveLamports / 1e9).toFixed(4)} spendable≈${maxSpendSol.toFixed(4)} cap70%≈${maxByFractionSol.toFixed(4)}`,
			"error",
		);
		return { ok: false, sig: "" };
	}
	if (buySol + 1e-9 < desiredSol) {
		log(
			`BUY capped: desired=${desiredSol.toFixed(4)} SOL, spending=${buySol.toFixed(4)} SOL (balance=${solBalUi.toFixed(4)} SOL, cap70%=${maxByFractionSol.toFixed(4)} SOL)`,
			"help",
		);
	}

	log(`Mirror BUY ${mint.slice(0, 6)}… for ~${buySol.toFixed(4)} SOL`, "ok");
	const res = await getDex().executeSwapWithConfirm(
		{
			signer: autoKp,
			inputMint: SOL_MINT,
			outputMint: mint,
			amountUi: buySol,
			slippageBps: slip,
		},
		{ retries: 1, confirmMs: 45_000 },
	);

	if (res?.ok) {
		log(`BUY ok: ${res.sig}`, "ok");
		return { ok: true, sig: res.sig };
	}
	if (res?.insufficient) {
		log(`BUY failed (insufficient SOL): ${res.msg || ""}`, "error");
		return { ok: false, sig: res?.sig || "" };
	}
	if (res?.noRoute) {
		log(`BUY failed (no route): ${res.msg || ""}`, "warn");
		return { ok: false, sig: res?.sig || "" };
	}
	log(`BUY submitted but not confirmed yet: ${res?.sig || "(no sig)"}`, "warn");
	return { ok: false, sig: res?.sig || "" };
}

async function mirrorSell(mint) {
	const slip = Math.floor(clampNum(state.slippageBps, 10, 20_000, 250));
	const autoKp = await getAutoKeypair();
	if (!autoKp) {
		log("No auto wallet configured. Set/import it in the Auto tab first.", "error");
		await debugAutoWalletLoad(log);
		return { ok: false, sig: "" };
	}
	const ownerStr = autoKp.publicKey.toBase58();
	const bal = await getTokenBalanceUiByMint(ownerStr, mint);
	const amountUi = Number(bal?.sizeUi || 0);
	if (!(amountUi > 0)) {
		log(`No balance to sell for ${mint.slice(0, 6)}… (already empty).`, "warn");
		return { ok: true, sig: "" };
	}

	log(`Mirror SELL ${mint.slice(0, 6)}… amount=${amountUi.toFixed(6)}`, "ok");
	const res = await getDex().executeSwapWithConfirm(
		{
			signer: autoKp,
			inputMint: mint,
			outputMint: SOL_MINT,
			amountUi,
			slippageBps: slip,
		},
		{ retries: 1, confirmMs: 30_000 },
	);

	if (res?.ok) {
		log(`SELL ok: ${res.sig}`, "ok");
		try {
			await getDex().closeEmptyTokenAtas(autoKp, mint);
		} catch {}
		return { ok: true, sig: res.sig };
	}
	if (res?.insufficient) {
		log(`SELL failed (fees/lamports): ${res.msg || ""}`, "error");
		return { ok: false, sig: res?.sig || "" };
	}
	if (res?.noRoute) {
		log(`SELL failed (no route): ${res.msg || ""}`, "warn");
		return { ok: false, sig: res?.sig || "" };
	}
	log(`SELL submitted but not confirmed yet: ${res?.sig || "(no sig)"}`, "warn");
	return { ok: false, sig: res?.sig || "" };
}

async function pollOnce() {
	if (!state.enabled) return;
	if (_pollInFlight) return;
	_pollInFlight = true;
	try {
		const target = String(state.targetWallet || "").trim();
		if (!target) return;
		if (!(await isValidPubkeyStr(target))) {
			log("Target wallet pubkey invalid.", "error");
			return;
		}

		// pending confirm checks (no re-buy / re-sell spam)
		if (state.pendingAction) {
			await _checkPendingBuy();
			await _checkPendingSell();
		}

		const sigs = await fetchNewSignatures(target);
		if (!sigs.length) return;

		for (const sig of sigs) {
			const evt = await classifyTargetSwap(sig, target);
			if (!evt) continue;

			if (evt.type === "buy") {
				if (state.activeMint) {
					log(`Ignoring BUY ${evt.mint.slice(0, 6)}… (already following ${state.activeMint.slice(0, 6)}…)`, "help");
					continue;
				}
				state.activeMint = evt.mint;
				state.pendingSince = Date.now();
				state.lastActionAttempt = 0;
				state.pendingAction = "";
				state.pendingSig = "";
				state.pendingAttempts = 0;
				state.pendingLastTryAt = 0;
				saveState();
				updateUI();
				log(`Target BUY detected: ${evt.mint} (Δ ${evt.deltaUi.toFixed(6)})`, "ok");
				const r = await mirrorBuy(evt.mint);
				if (!r?.ok) {
					state.pendingAction = "buy";
					state.pendingSig = String(r?.sig || "");
					state.pendingAttempts = 0;
					state.pendingLastTryAt = Date.now();
					state.pendingSince = Date.now();
					saveState();
					updateUI();
				}
				updateUI();
				continue;
			}

			if (evt.type === "sell") {
				if (!state.activeMint || evt.mint !== state.activeMint) continue;
				log(`Target SELL detected: ${evt.mint} (Δ ${evt.deltaUi.toFixed(6)})`, "ok");
				const r = await mirrorSell(evt.mint);
				if (r?.ok === true) {
					state.activeMint = "";
					state.pendingAction = "";
					state.pendingSig = "";
					state.pendingAttempts = 0;
					state.pendingLastTryAt = 0;
				} else {
					state.pendingAction = "sell";
					state.pendingSig = String(r?.sig || "");
					state.pendingAttempts = 0;
					state.pendingLastTryAt = Date.now();
					state.pendingSince = Date.now();
				}
				saveState();
				updateUI();
			}
		}
	} catch (e) {
		const msg = String(e?.message || e || "");
		if (/403/.test(msg)) {
			log("RPC 403 Forbidden: configure RPC URL and headers in Auto settings.", "error");
			log(`RPC URL: ${currentRpcUrl()}`, "help");
		} else {
			log(`Poll error: ${msg}`, "error");
		}
	} finally {
		_pollInFlight = false;
	}
}

async function startFollowBot() {
	if (state.enabled) return;
	const target = String(targetEl?.value || "").trim();
	if (!target) {
		log("Target wallet is required.", "error");
		return;
	}
	if (!(await isValidPubkeyStr(target))) {
		log("Target wallet pubkey invalid.", "error");
		return;
	}

	// Basic auto wallet sanity before starting
	const autoKp = await getAutoKeypair();
	if (!autoKp) {
		log("No auto wallet configured. Set/import it in the Auto tab first.", "error");
		await debugAutoWalletLoad(log);
		return;
	}
	try {
		await getConn();
	} catch (e) {
		log(`RPC error: ${String(e?.message || e || "")}`, "error");
		return;
	}

	state.targetWallet = target;
	state.buySol = clampNum(buySolEl?.value, 0.001, 20, 0.1);
	state.slippageBps = Math.floor(clampNum(slipEl?.value, 10, 20_000, 250));
	state.pollMs = Math.floor(clampNum(pollEl?.value, 250, 60_000, 1500));
	state.pendingAction = "";
	state.pendingSig = "";
	state.pendingSince = 0;
	state.lastActionAttempt = 0;

	try {
		const { PublicKey } = await loadWeb3();
		const conn = await getConn();
		const pk = new PublicKey(target);
		const recent = await conn.getSignaturesForAddress(pk, { limit: 25 }, "confirmed");
		const list = Array.isArray(recent) ? recent : [];
		const newest = String(list?.[0]?.signature || "");
		state.lastSig = newest || "";

		if (!state.activeMint && list.length) {
			const soldMints = new Set();
			for (const rec of list) {
				const sig = String(rec?.signature || "");
				if (!sig) continue;
				const info = await extractBuySellForTarget(sig, target);
				if (!info) continue;
				const s = info.sell?.mint;
				const b = info.buy?.mint;
				if (s) soldMints.add(s);
				if (b && !soldMints.has(b)) {
					state.activeMint = b;
					state.pendingSince = Date.now();
					state.lastActionAttempt = 0;
					log(`Startup: latest buy to follow is ${b} (sig ${sig.slice(0, 8)}…)`, "help");
					break;
				}
			}
		}
	} catch {}

	saveState();

	state.enabled = true;
	updateUI();
	log(`Follow started. Target=${target.slice(0, 6)}… Auto=${autoKp.publicKey.toBase58().slice(0, 6)}…`, "ok");
	if (state.activeMint) {
		log(`Following mint: ${state.activeMint}`, "ok");
		const r = await mirrorBuy(state.activeMint);
		if (!r?.ok) {
			state.pendingAction = "buy";
			state.pendingSig = String(r?.sig || "");
			state.pendingSince = Date.now();
			saveState();
		}
	} else {
		log("Waiting for new target transactions…", "help");
	}

	if (_timer) clearInterval(_timer);
	_timer = setInterval(() => {
		pollOnce().catch(() => {});
	}, Math.max(250, Number(state.pollMs || 1500)));

	// quick first poll after start
	await delay(250);
	await pollOnce();
}

async function stopFollowBot() {
	state.enabled = false;
	if (_timer) {
		clearInterval(_timer);
		_timer = null;
	}
	state.pendingAction = "";
	state.pendingSig = "";
	saveState();
	updateUI();
	log("Follow stopped.", "warn");
}

export function initFollowWidget(container = document.body) {
	loadState();

	const wrap = document.createElement("div");
	wrap.className = "fdv-follow-wrap";
	wrap.innerHTML = `
		<div class="fdv-tab-content active" data-tab-content="follow">
			<div class="fdv-grid">
				<label>Target Wallet <input id="follow-target" type="text" placeholder="Wallet pubkey"></label>
				<label>Buy Amount (SOL) <input id="follow-buy-sol" type="number" min="0.001" step="0.001"></label>
				<label>Slippage (bps) <input id="follow-slip" type="number" min="10" max="20000" step="10"></label>
				<label>Poll (ms) <input id="follow-poll" type="number" min="250" max="60000" step="50"></label>
			</div>

			<div class="fdv-log" id="follow-log"></div>
            <div class="fdv-actions" style="margin-top:6px;">
				<div class="fdv-actions-left" style="display:flex; flex-direction:column; gap:4px;">
					<div class="fdv-rpc-text" id="follow-status"></div>
				</div>
                <div class="fdv-actions-right">
                    <button id="fdv-follow-start">Start</button>
                    <button id="fdv-follow-stop">Stop</button>
                </div>
			</div>

		</div>
	`;
	container.appendChild(wrap);

	targetEl = document.getElementById("follow-target");
	buySolEl = document.getElementById("follow-buy-sol");
	slipEl = document.getElementById("follow-slip");
	pollEl = document.getElementById("follow-poll");
	logEl = document.getElementById("follow-log");
	startBtn = document.getElementById("fdv-follow-start");
	stopBtn = document.getElementById("fdv-follow-stop");
	rpcEl = document.getElementById("follow-rpc");
	statusEl = document.getElementById("follow-status");
	activeEl = document.getElementById("follow-active");

	updateUI();

	startBtn.addEventListener("click", async () => {
		await startFollowBot();
	});
	stopBtn.addEventListener("click", async () => {
		await stopFollowBot();
	});

	// Persist edits when stopped
	for (const el of [targetEl, buySolEl, slipEl, pollEl]) {
		el?.addEventListener("change", () => {
			if (state.enabled) return;
			state.targetWallet = String(targetEl?.value || "").trim();
			state.buySol = clampNum(buySolEl?.value, 0.001, 20, state.buySol);
			state.slippageBps = Math.floor(clampNum(slipEl?.value, 10, 20_000, state.slippageBps));
			state.pollMs = Math.floor(clampNum(pollEl?.value, 250, 60_000, state.pollMs));
			saveState();
			updateUI();
		});
	}
}
