import { createDex } from "../lib/dex.js";
import {
	preflightBuyLiquidity,
	DEFAULT_BUY_EXIT_CHECK_FRACTION,
	DEFAULT_BUY_MAX_PRICE_IMPACT_PCT,
} from "../lib/liquidity.js";
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
	RUG_FORCE_SELL_SEVERITY,
	SPLIT_FRACTIONS,
	FEE_ATAS,
	AUTO_CFG,
} from "../lib/constants.js";
import { rpcWait, rpcBackoffLeft, markRpcStress } from "../lib/rpcThrottle.js";
import { createDustCacheStore } from "../lib/stores/dustCacheStore.js";
import { setBotRunning } from "../lib/autoLed.js";
import { loadSplToken } from "../../../../core/solana/splToken.js";
import { getRugSignalForMint } from "../../../meme/metrics/kpi/pumping.js";
import { importFromUrlWithFallback } from "../../../../utils/netImport.js";

let _web3Promise;
let _bs58Promise;
let _connPromise;

export async function loadWeb3() {
	try {
		if (typeof window !== "undefined" && window.solanaWeb3) return window.solanaWeb3;
		if (typeof window !== "undefined" && window._fdvAutoDepsPromise) {
			const deps = await window._fdvAutoDepsPromise.catch(() => null);
			if (deps?.web3) return deps.web3;
		}
	} catch {}
	if (_web3Promise) return _web3Promise;
	_web3Promise = (async () =>
		importFromUrlWithFallback([
			"https://cdn.jsdelivr.net/npm/@solana/web3.js@1.95.4/+esm",
			"https://esm.sh/@solana/web3.js@1.95.4?bundle",
		], { cacheKey: "fdv:follow:web3@1.95.4" }))();
	return _web3Promise;
}

async function loadBs58() {
	try {
		if (typeof window !== "undefined" && window._fdvBs58Module) return window._fdvBs58Module;
		if (typeof window !== "undefined" && window._fdvAutoDepsPromise) {
			const deps = await window._fdvAutoDepsPromise.catch(() => null);
			if (deps?.bs58) return { default: deps.bs58 };
		}
		if (typeof window !== "undefined" && window.bs58) return { default: window.bs58 };
	} catch {}
	if (_bs58Promise) return _bs58Promise;
	_bs58Promise = (async () =>
		importFromUrlWithFallback([
			"https://cdn.jsdelivr.net/npm/bs58@6.0.0/+esm",
			"https://esm.sh/bs58@6.0.0?bundle",
		], { cacheKey: "fdv:follow:bs58@6.0.0" }))();
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

const NO_ROUTE_SELL_TRIES = 5;
const DUST_CACHE_KEY_PREFIX = "fdv_dust_";

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
		let totalRaw = 0n;
		let decimals = null;
		for (const it of v) {
			const amt = it?.account?.data?.parsed?.info?.tokenAmount;
			const ui = Number(amt?.uiAmount);
			if (Number.isFinite(ui)) totalUi += ui;
			try {
				const rawStr = String(amt?.amount || "");
				if (rawStr) totalRaw += BigInt(rawStr);
			} catch {}
			const d = Number(amt?.decimals);
			if (Number.isFinite(d)) decimals = d;
		}
		if (!Number.isFinite(totalUi)) totalUi = 0;
		return {
			sizeUi: totalUi,
			decimals: Number.isFinite(decimals) ? decimals : await safeGetDecimalsFast(mintStr),
			sizeRaw: totalRaw.toString(),
		};
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

async function unwrapWsolIfAny(signerOrOwner) {
	try {
		const { PublicKey, Transaction, TransactionInstruction } = await loadWeb3();
		const conn = await getConn();

		let ownerPk = null;
		let signer = null;
		try {
			if (signerOrOwner?.publicKey) {
				ownerPk = signerOrOwner.publicKey instanceof PublicKey
					? signerOrOwner.publicKey
					: new PublicKey(
						signerOrOwner.publicKey.toBase58 ? signerOrOwner.publicKey.toBase58() : signerOrOwner.publicKey
					);
				signer = signerOrOwner;
			} else if (typeof signerOrOwner === "string" && (await isValidPubkeyStr(signerOrOwner))) {
				ownerPk = new PublicKey(signerOrOwner);
			} else if (signerOrOwner && typeof signerOrOwner.toBase58 === "function") {
				ownerPk = new PublicKey(signerOrOwner.toBase58());
				signer = signerOrOwner;
			}
		} catch {}
		if (!ownerPk) return false;

		const canSign = !!(
			signer && (typeof signer.sign === "function" || (signer.secretKey && signer.secretKey.length > 0))
		);
		if (!canSign) return false;

		if (!window._fdvUnwrapInflight) window._fdvUnwrapInflight = new Map();
		const ownerStr = ownerPk.toBase58();
		if (window._fdvUnwrapInflight.get(ownerStr)) return false;
		window._fdvUnwrapInflight.set(ownerStr, true);

		try {
			const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createCloseAccountInstruction, getAssociatedTokenAddress } =
				await loadSplToken();
			const progs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].filter(Boolean);

			const atapks = [];
			for (const pid of progs) {
				try {
					const mint = new PublicKey(SOL_MINT);
					const ataAny = await getAssociatedTokenAddress(mint, ownerPk, true, pid);
					const ata = typeof ataAny === "string" ? new PublicKey(ataAny) : ataAny;
					if (ata) atapks.push({ pid, ata });
				} catch {}
			}

			const ixs = [];
			for (const { pid, ata } of atapks) {
				try {
					const ai = await conn.getAccountInfo(ata, "processed").catch((e) => {
						markRpcStress?.(e, 1500);
						return null;
					});
					if (!ai) continue;
					if (typeof createCloseAccountInstruction === "function") {
						ixs.push(createCloseAccountInstruction(ata, ownerPk, ownerPk, [], pid));
					} else {
						ixs.push(
							new TransactionInstruction({
								programId: pid,
								keys: [
									{ pubkey: ata, isSigner: false, isWritable: true },
									{ pubkey: ownerPk, isSigner: false, isWritable: true },
									{ pubkey: ownerPk, isSigner: true, isWritable: false },
								],
								data: Uint8Array.of(9),
							})
						);
					}
				} catch (e) {
					markRpcStress?.(e, 1500);
				}
			}
			if (!ixs.length) return false;

			const tx = new Transaction();
			for (const ix of ixs) tx.add(ix);
			tx.feePayer = ownerPk;
			tx.recentBlockhash = (await conn.getLatestBlockhash("processed")).blockhash;
			tx.sign(signer);
			const sig = await conn.sendRawTransaction(tx.serialize(), {
				preflightCommitment: "processed",
				maxRetries: 2,
			});
			log(`WSOL unwrap sent: ${sig}`, "help");
			return true;
		} finally {
			window._fdvUnwrapInflight.delete(ownerStr);
		}
	} catch (e) {
		if (!/Invalid public key input/i.test(String(e?.message || e))) {
			log(`WSOL unwrap failed: ${String(e?.message || e)}`, "warn");
		}
		return false;
	}
}

async function listNonSolTokenMintsWithBalance(ownerPkOrStr) {
	try {
		if (!ownerPkOrStr) return [];
		const { PublicKey } = await loadWeb3();
		const conn = await getConn();
		const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await loadSplToken();
		const owner = typeof ownerPkOrStr === "string" ? new PublicKey(ownerPkOrStr) : ownerPkOrStr;

		const progs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].filter(Boolean);
		const totals = new Map();
		for (const pid of progs) {
			let res;
			try {
				res = await conn.getParsedTokenAccountsByOwner(owner, { programId: pid }, "confirmed");
			} catch (e) {
				markRpcStress?.(e, 1500);
				continue;
			}
			const vals = Array.isArray(res?.value) ? res.value : [];
			for (const it of vals) {
				const info = it?.account?.data?.parsed?.info;
				const mint = String(info?.mint || "");
				if (!mint || mint === SOL_MINT) continue;
				const amt = info?.tokenAmount;
				const ui = Number(amt?.uiAmount);
				if (!(ui > 0)) continue;
				const prev = totals.get(mint);
				const decimals = Number(amt?.decimals);
				if (prev) {
					prev.ui += ui;
					if (!Number.isFinite(prev.decimals) && Number.isFinite(decimals)) prev.decimals = decimals;
				} else {
					totals.set(mint, { mint, ui, decimals: Number.isFinite(decimals) ? decimals : undefined });
				}
			}
		}

		return [...totals.values()].sort((a, b) => Number(b.ui || 0) - Number(a.ui || 0));
	} catch {
		return [];
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
		unwrapWsolIfAny,
		rpcWait,
		rpcBackoffLeft,
		markRpcStress,

		getCfg,
		isValidPubkeyStr,

		getPlatformFeeBps,
		tokenAccountRentLamports,
		requiredAtaLamportsForSwap,
		requiredOutAtaRentIfMissing: async () => 0,
		shouldAttachFeeForSell: ({ mint } = {}) => {
			try {
				const m = String(mint || "");
				return !!(m && state?.forceFeeSellMint && String(state.forceFeeSellMint) === m);
			} catch {
				return false;
			}
		},
		minSellNotionalSol: () => 0,
		safeGetDecimalsFast,

		confirmSig,
		setMintBlacklist,
	});
	return _dex;
}

// UI + logging
const MAX_LOG_ENTRIES = 120;
let logEl, startBtn, stopBtn;
let targetEl, buyPctEl, maxHoldEl, pollEl;
let statusEl, rpcEl, activeEl;

function log(msg, type = "info") {
	try {
		const line = `[${new Date().toLocaleTimeString()}] ${String(msg ?? "")}`;
		try {
			// Headless/CLI: allow mirroring to stdout.
			const wantConsole = !!(typeof window !== "undefined" && window._fdvLogToConsole);
			const nodeLike = typeof process !== "undefined" && !!process?.stdout;
			if ((wantConsole || (nodeLike && !logEl)) && line) {
				if (String(type || "").toLowerCase().startsWith("err")) console.error(line);
				else if (String(type || "").toLowerCase().startsWith("war")) console.warn(line);
				else console.log(line);
			}
		} catch {}
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

function _isNodeLike() {
	try {
		return typeof process !== "undefined" && !!process?.versions?.node;
	} catch {
		return false;
	}
}

function _applyRpcOptsToStateAndStorage({ rpcUrl, rpcHeaders } = {}) {
	try {
		if (rpcUrl != null) {
			const u = String(rpcUrl || "").trim();
			state.rpcUrl = u;
			try {
				if (typeof localStorage !== "undefined") localStorage.setItem("fdv_rpc_url", u);
			} catch {}
		}
		if (rpcHeaders != null) {
			const h = rpcHeaders && typeof rpcHeaders === "object" ? rpcHeaders : {};
			state.rpcHeaders = h;
			try {
				if (typeof localStorage !== "undefined") localStorage.setItem("fdv_rpc_headers", JSON.stringify(h));
			} catch {}
		}
	} catch {}
}

function __fdvCli_applyFollowConfig(cfg = {}) {
	try {
		loadState();
		if (cfg?.targetWallet != null) state.targetWallet = String(cfg.targetWallet || "").trim();
		if (cfg?.buyPct != null) state.buyPct = clampBuyPct(cfg.buyPct, state.buyPct);
		if (cfg?.maxHoldMin != null) state.maxHoldMin = clampMaxHoldMin(cfg.maxHoldMin, state.maxHoldMin);
		if (cfg?.pollMs != null) state.pollMs = Math.floor(clampNum(cfg.pollMs, 250, 60_000, state.pollMs || 1500));
		_applyRpcOptsToStateAndStorage({ rpcUrl: cfg?.rpcUrl, rpcHeaders: cfg?.rpcHeaders });
		saveState();
		return true;
	} catch {
		return false;
	}
}

async function __fdvCli_startFollow(cfg = {}) {
	// Headless start: do not depend on DOM inputs.
	if (!_isNodeLike()) {
		// Still allow in browser, but this is intended for CLI.
	}
	try {
		if (cfg?.logToConsole) {
			try { window._fdvLogToConsole = true; } catch {}
		}
	} catch {}

	loadState();
	__fdvCli_applyFollowConfig(cfg);

	const target = String(cfg?.targetWallet ?? state.targetWallet ?? "").trim();
	if (!target) {
		log("Target wallet is required.", "error");
		return 2;
	}
	if (!(await isValidPubkeyStr(target))) {
		log("Target wallet pubkey invalid.", "error");
		return 2;
	}

	// Basic auto wallet sanity before starting
	const autoKp = await getAutoKeypair();
	if (!autoKp) {
		log("No auto wallet configured. Set/import it in the Auto tab first.", "error");
		await debugAutoWalletLoad(log);
		return 3;
	}
	try {
		await getConn();
	} catch (e) {
		log(`RPC error: ${String(e?.message || e || "")}`, "error");
		return 3;
	}

	state.targetWallet = target;
	state.buyPct = clampBuyPct(cfg?.buyPct, state.buyPct);
	state.maxHoldMin = clampMaxHoldMin(cfg?.maxHoldMin, state.maxHoldMin);
	state.pollMs = Math.floor(clampNum(cfg?.pollMs, 250, 60_000, state.pollMs || 1500));
	state.pendingAction = "";
	state.pendingSig = "";
	state.pendingSince = 0;
	state.lastActionAttempt = 0;

	const persistedMint = String(state.activeMint || "").trim();
	if (persistedMint) {
		const hasPos = await _autoHasTokenBalance(persistedMint);
		if (!hasPos) {
			_clearActivePositionState();
			state.pendingAction = "";
			state.pendingSig = "";
			state.pendingAttempts = 0;
			state.pendingLastTryAt = 0;
			state.pendingSince = 0;
			state.lastActionAttempt = 0;
		}
	}
	if (state.entryMint && state.entryMint !== state.activeMint) {
		state.entryMint = "";
		state.entrySol = 0;
		state.entryAt = 0;
	}

	try {
		const { PublicKey } = await loadWeb3();
		const conn = await getConn();
		const pk = new PublicKey(target);
		const recent = await conn.getSignaturesForAddress(pk, { limit: 25 }, "confirmed");
		const list = Array.isArray(recent) ? recent : [];
		const newest = String(list?.[0]?.signature || "");
		state.lastSig = newest || "";

		// Always try to find the latest buy from target; only overwrite if we don't already
		// have an actual open position in the auto wallet.
		{
			const hasPos = state.activeMint ? await _autoHasTokenBalance(state.activeMint) : false;
			if (!hasPos) {
				const b = await _findLatestBuyMintFromTarget(target, { limit: 200 });
				if (b) {
					if (isMintInAutoDustCache(b)) {
						log(`Startup: latest buy is in dust cache; skipping: ${b.slice(0, 6)}…`, "warn");
					} else {
					state.activeMint = b;
					state.pendingSince = Date.now();
					state.lastActionAttempt = 0;
					log(`Startup: latest buy to follow is ${b} (from parsed txs)`, "help");
					}
				}
			}
		}

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
					if (isMintInAutoDustCache(b)) {
						log(`Startup: buy mint is in dust cache; skipping: ${b.slice(0, 6)}…`, "warn");
						continue;
					}
					if (isMintBlacklisted(b)) continue;
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
	try { setBotRunning('follow', true); } catch {}
	updateUI();
	log(
		`Follow started (headless). Target=${target.slice(0, 6)}… Auto=${autoKp.publicKey.toBase58().slice(0, 6)}…`,
		"ok",
	);
	if (state.activeMint) {
		log(`Following mint: ${state.activeMint}`, "ok");
		state.entryMint = state.activeMint;
		state.entrySol = 0;
		state.entryAt = Date.now();
		saveState();
		const r = await mirrorBuy(state.activeMint);
		if (Number(r?.spentSol || 0) > 0) {
			state.entrySol = Number(r.spentSol);
			state.entryAt = Date.now();
			saveState();
		}
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
	return 0;
}

async function __fdvCli_stopFollow() {
	try {
		await stopFollowBot();
		return 0;
	} catch (e) {
		log(`Stop error: ${String(e?.message || e || "")}`, "error");
		return 3;
	}
}

export const __fdvCli_applyConfig = __fdvCli_applyFollowConfig;
export const __fdvCli_start = __fdvCli_startFollow;
export const __fdvCli_stop = __fdvCli_stopFollow;

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

function setMintBlacklist(mint, ms = MINT_RUG_BLACKLIST_MS) {
	try {
		const m = String(mint || "").trim();
		if (!m) return false;
		if (!window._fdvMintBlacklist) window._fdvMintBlacklist = new Map();
		const map = window._fdvMintBlacklist;
		const prev = map.get(m) || null;
		const until = Date.now() + Math.max(5_000, Number(ms || 0));
		map.set(m, { until, count: Number(prev?.count || 0) + 1 });
		return true;
	} catch {
		return false;
	}
}

function isMintBlacklisted(mint) {
	try {
		const m = String(mint || "").trim();
		if (!m) return false;
		const map = window._fdvMintBlacklist;
		if (!map || typeof map.get !== "function") return false;
		const rec = map.get(m);
		if (!rec) return false;
		const until = Number(rec?.until || 0);
		if (!(until > Date.now())) {
			try { map.delete(m); } catch {}
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

// Follow state
let state = {
	enabled: false,
	targetWallet: "",
	activeMint: "",
	entryMint: "",
	entrySol: 0,
	entryAt: 0,
	forceFeeSellMint: "",
	queuedMint: "",
	queuedSig: "",
	queuedAt: 0,
	lastSig: "",
	pollMs: 1500,
	buyPct: 25,
	maxHoldMin: 5,
	rpcUrl: "",
	rpcHeaders: {},
	pendingAction: "", // "buy" | "sell" | ""
	pendingSig: "",
	pendingAttempts: 0,
	pendingLastTryAt: 0,
	pendingSince: 0,
	lastActionAttempt: 0,
};

let _dustStore;
function _getDustStore() {
	if (_dustStore) return _dustStore;
	_dustStore = createDustCacheStore({ keyPrefix: DUST_CACHE_KEY_PREFIX, log });
	return _dustStore;
}

function _getAutoOwnerPubGuess() {
	try {
		const meta = getExistingAutoWalletMeta();
		return String(meta?.autoWalletPub || "").trim();
	} catch {
		return "";
	}
}

function isMintInAutoDustCache(mint, ownerPubkeyStr = "") {
	try {
		const owner = String(ownerPubkeyStr || "").trim() || _getAutoOwnerPubGuess();
		const m = String(mint || "").trim();
		if (!owner || !m) return false;
		return !!_getDustStore().isMintInDustCache(owner, m);
	} catch {
		return false;
	}
}

function addMintToAutoDustCache({ ownerPubkeyStr, mint, sizeUi, decimals } = {}) {
	try {
		const owner = String(ownerPubkeyStr || "").trim();
		const m = String(mint || "").trim();
		if (!owner || !m) return false;
		_getDustStore().addToDustCache(owner, m, Number(sizeUi || 0), Number.isFinite(decimals) ? decimals : 6);
		return true;
	} catch {
		return false;
	}
}

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

		// Migration: older state used fixed SOL buy size (buySol). We now use buyPct.
		const maxPct = Math.floor(FOLLOW_BUY_MAX_FRACTION_OF_SOL * 100);
		if (!Number.isFinite(Number(state.buyPct))) state.buyPct = 10;
		state.buyPct = clampNum(state.buyPct, 10, maxPct, 25);

		state.maxHoldMin = clampMaxHoldMin(state.maxHoldMin, 5);
	} catch {}
}

function saveState() {
	_writeFollowStateRaw({
		targetWallet: String(state.targetWallet || "").trim(),
		activeMint: String(state.activeMint || "").trim(),
		entryMint: String(state.entryMint || "").trim(),
		entrySol: Number(state.entrySol || 0),
		entryAt: Number(state.entryAt || 0),
		queuedMint: String(state.queuedMint || "").trim(),
		queuedSig: String(state.queuedSig || "").trim(),
		queuedAt: Number(state.queuedAt || 0),
		lastSig: String(state.lastSig || "").trim(),
		pollMs: Number(state.pollMs || 1500),
		buyPct: Number(state.buyPct || 25),
		maxHoldMin: Number(state.maxHoldMin || 5),
		rpcUrl: String(state.rpcUrl || "").trim(),
		rpcHeaders: state.rpcHeaders && typeof state.rpcHeaders === "object" ? state.rpcHeaders : {},
		pendingAction: String(state.pendingAction || ""),
		pendingSig: String(state.pendingSig || ""),
		pendingAttempts: Number(state.pendingAttempts || 0),
		pendingLastTryAt: Number(state.pendingLastTryAt || 0),
		pendingSince: Number(state.pendingSince || 0),
	});
}

const TAKE_PROFIT_BPS = 1000; // +10%

const RECYCLE_HOLD_MAX_MIN = 1500; // 25 hours

function clampMaxHoldMin(minsLike, fallbackMin = 5) {
	return clampNum(minsLike, 1, RECYCLE_HOLD_MAX_MIN, fallbackMin);
}

function getMaxHoldMs() {
	return clampMaxHoldMin(state.maxHoldMin, 5) * 60_000;
}

function _clearActivePositionState() {
	state.activeMint = "";
	state.entryMint = "";
	state.entrySol = 0;
	state.entryAt = 0;
	state.forceFeeSellMint = "";
}

function _queueNextMint(mint, sig) {
	const m = String(mint || "").trim();
	if (!m || m === state.activeMint) return false;
	if (state.queuedMint === m) return false;
	if (isMintInAutoDustCache(m)) {
		log(`Queued mint is in dust cache; ignoring: ${m.slice(0, 6)}…`, "warn");
		return false;
	}
	state.queuedMint = m;
	state.queuedSig = String(sig || "").trim();
	state.queuedAt = Date.now();
	saveState();
	log(`Queued next mint from target: ${m.slice(0, 6)}…`, "help");
	return true;
}

async function _startQueuedMintIfAny() {
	try {
		if (!state.enabled) return false;
		if (state.pendingAction) return false;
		if (state.activeMint) return false;
		const m = String(state.queuedMint || "").trim();
		if (!m) return false;
		if (isMintInAutoDustCache(m)) {
			log(`Queued mint is in dust cache; skipping: ${m.slice(0, 6)}…`, "warn");
			state.queuedMint = "";
			state.queuedSig = "";
			state.queuedAt = 0;
			saveState();
			updateUI();
			return false;
		}
		if (isMintBlacklisted(m)) {
			log(`Queued mint is blacklisted; skipping: ${m.slice(0, 6)}…`, "warn");
			state.queuedMint = "";
			state.queuedSig = "";
			state.queuedAt = 0;
			saveState();
			updateUI();
			return false;
		}

		state.activeMint = m;
		state.entryMint = m;
		state.entrySol = 0;
		state.entryAt = Date.now();
		state.queuedMint = "";
		state.queuedSig = "";
		state.queuedAt = 0;
		saveState();
		updateUI();
		log(`Starting queued follow: ${m}`, "ok");

		const r = await mirrorBuy(m);
		if (Number(r?.spentSol || 0) > 0) {
			state.entrySol = Number(r.spentSol);
			state.entryAt = Date.now();
			saveState();
		}
		if (r?.blocked) {
			log(`Queued BUY blocked (${String(r?.reason || "").slice(0, 80)}). Clearing and continuing.`, "warn");
			_clearActivePositionState();
			state.pendingAction = "";
			state.pendingSig = "";
			state.pendingAttempts = 0;
			state.pendingLastTryAt = 0;
			state.pendingSince = 0;
			saveState();
			updateUI();
			_kickPollSoon(250);
			return false;
		}
		if (!r?.ok) {
			state.pendingAction = "buy";
			state.pendingSig = String(r?.sig || "");
			state.pendingAttempts = 0;
			state.pendingLastTryAt = Date.now();
			state.pendingSince = Date.now();
			saveState();
			updateUI();
		}
		return true;
	} catch {
		return false;
	}
}

const PENDING_MAX_MS = 240_000;
const PENDING_RETRY_GAP_MS = 5_000;
const PENDING_MAX_ATTEMPTS = 4;

const FOLLOW_BUY_MAX_FRACTION_OF_SOL = 0.7;

const FOLLOW_BUY_MIN_PCT = 10;
const FOLLOW_BUY_MAX_PCT = Math.floor(FOLLOW_BUY_MAX_FRACTION_OF_SOL * 100);

function clampBuyPct(pctLike, fallbackPct = 25) {
	return clampNum(pctLike, FOLLOW_BUY_MIN_PCT, FOLLOW_BUY_MAX_PCT, fallbackPct);
}

function getBuyFraction() {
	return clampBuyPct(state.buyPct, 25) / 100;
}

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
		if (!sig) {
			const elapsed = Date.now() - Number(state.pendingSince || 0);
			if (elapsed > 1500) {
				log("Pending BUY has no signature (likely blocked). Clearing.", "warn");
				state.pendingAction = "";
				state.pendingSig = "";
				state.pendingAttempts = 0;
				state.pendingLastTryAt = 0;
				state.pendingSince = 0;
				_clearActivePositionState();
				saveState();
				updateUI();
				await _startQueuedMintIfAny();
				_kickPollSoon(250);
			}
			return false;
		}

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
			if (!state.entryMint || state.entryMint !== state.activeMint) {
				state.entryMint = String(state.activeMint || "");
				state.entrySol = 0;
				state.entryAt = Date.now();
			}
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
			_clearActivePositionState();
			saveState();
			updateUI();
			await _startQueuedMintIfAny();
			_kickPollSoon(250);
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
				_clearActivePositionState();
				saveState();
				updateUI();
				await _startQueuedMintIfAny();
				_kickPollSoon(250);
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
				_clearActivePositionState();
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
		_clearActivePositionState();
		saveState();
		updateUI();
		await _startQueuedMintIfAny();
		_kickPollSoon(250);
		return true;
	} catch {
		return false;
	}
}

async function _maybeTakeProfit() {
	try {
		if (!state.enabled) return false;
		if (!state.activeMint) return false;
		if (state.pendingAction) return false;
		if (!state.entryMint || state.entryMint !== state.activeMint) return false;
		const entrySol = Number(state.entrySol || 0);
		if (!(entrySol > 0)) return false;

		const autoKp = await getAutoKeypair();
		if (!autoKp) return false;
		const ownerStr = autoKp.publicKey.toBase58();

		// Dust mints are managed only via the Auto Trader UI; ignore them here.
		if (isMintInAutoDustCache(state.activeMint, ownerStr)) {
			log(`Take-profit ignored (dust): ${String(state.activeMint || "").slice(0, 6)}…`, "warn");
			_clearActivePositionState();
			state.pendingAction = "";
			state.pendingSig = "";
			state.pendingAttempts = 0;
			state.pendingLastTryAt = 0;
			state.pendingSince = 0;
			saveState();
			updateUI();
			_kickPollSoon(250);
			return true;
		}

		const bal = await getTokenBalanceUiByMint(ownerStr, state.activeMint);
		const amountUi = Number(bal?.sizeUi || 0);
		if (!(amountUi > 0)) return false;

		const rawStr = String(bal?.sizeRaw || "");
		if (!rawStr) return false;

		const q = await getDex().quoteGeneric(state.activeMint, SOL_MINT, rawStr, 50);
		const outLamports = Number(q?.outAmount || 0);
		if (!(outLamports > 0)) return false;
		const outSol = outLamports / 1e9;

		const targetSol = entrySol * (1 + TAKE_PROFIT_BPS / 10_000);
		if (outSol + 1e-12 < targetSol) return false;

		const soldMint = String(state.activeMint || "");
		log(
			`Take-profit hit: estOut≈${outSol.toFixed(4)} SOL (entry≈${entrySol.toFixed(4)} SOL, target≈${targetSol.toFixed(4)} SOL). Selling…`,
			"ok",
		);

		state.forceFeeSellMint = soldMint;

		const r = await mirrorSell(state.activeMint);
		if (r?.ok === true || r?.noRoute || r?.dust) {
			log("Take-profit SELL complete. Ready for next target mint.", "ok");
			_clearActivePositionState();
			state.pendingAction = "";
			state.pendingSig = "";
			state.pendingAttempts = 0;
			state.pendingLastTryAt = 0;
			state.pendingSince = 0;
			saveState();
			updateUI();
			await _syncLastSigToNewest(state.targetWallet);
			const startedQueued = await _startQueuedMintIfAny();
			if (!startedQueued) await _syncToTargetOpenMintAfterExit(soldMint);
			_kickPollSoon(250);
			return true;
		}

		state.pendingAction = "sell";
		state.pendingSig = String(r?.sig || "");
		state.pendingAttempts = 0;
		state.pendingLastTryAt = Date.now();
		state.pendingSince = Date.now();
		saveState();
		updateUI();
		return false;
	} catch {
		return false;
	}
}

async function _maybeRugExit() {
	try {
		if (!state.enabled) return false;
		if (!state.activeMint) return false;
		if (state.pendingAction) return false;

		const mint = String(state.activeMint || "").trim();
		if (!mint) return false;

		// Dust mints are managed only via the Auto Trader UI; ignore them here.
		try {
			const autoKp = await getAutoKeypair();
			const ownerStr = autoKp?.publicKey?.toBase58?.() || "";
			if (ownerStr && isMintInAutoDustCache(mint, ownerStr)) {
				log(`Rug exit ignored (dust): ${mint.slice(0, 6)}…`, "warn");
				_clearActivePositionState();
				state.pendingAction = "";
				state.pendingSig = "";
				state.pendingAttempts = 0;
				state.pendingLastTryAt = 0;
				state.pendingSince = 0;
				saveState();
				updateUI();
				_kickPollSoon(250);
				return true;
			}
		} catch {}

		const sig = getRugSignalForMint?.(mint);
		if (!sig) return false;
		const sev = Number(sig?.sev ?? 0);
		const thr = Number(RUG_FORCE_SELL_SEVERITY ?? 0);

		if (!sig?.rugged) return false;

		if (!(sev >= thr)) {
			setMintBlacklist(mint, MINT_RUG_BLACKLIST_MS);
			log(
				`Rug soft-flag for ${mint.slice(0, 6)}… sev=${sev.toFixed(2)} < ${thr.toFixed(2)} — staged blacklist, no forced sell.`,
				"warn",
			);
			return false;
		}

		setMintBlacklist(mint, MINT_RUG_BLACKLIST_MS);
		log(
			`Rug detected for ${mint.slice(0, 6)}… sev=${sev.toFixed(2)} (thr=${thr.toFixed(2)}). Forcing SELL and blacklisting 30m.`,
			"error",
		);

		const r = await mirrorSell(mint);
		if (r?.ok === true || r?.noRoute || r?.dust) {
			_clearActivePositionState();
			state.pendingAction = "";
			state.pendingSig = "";
			state.pendingAttempts = 0;
			state.pendingLastTryAt = 0;
			state.pendingSince = 0;
			saveState();
			updateUI();
			await _syncLastSigToNewest(state.targetWallet);
			await _startQueuedMintIfAny();
			_kickPollSoon(250);
			return true;
		}

		state.pendingAction = "sell";
		state.pendingSig = String(r?.sig || "");
		state.pendingAttempts = 0;
		state.pendingLastTryAt = Date.now();
		state.pendingSince = Date.now();
		saveState();
		updateUI();
		return false;
	} catch {
		return false;
	}
}

async function _maybeRecycleExit() {
	try {
		if (!state.enabled) return false;
		if (!state.activeMint) return false;
		if (state.pendingAction) return false;
		if (!state.entryMint || state.entryMint !== state.activeMint) return false;
		const entryAt = Number(state.entryAt || 0);
		if (!(entryAt > 0)) return false;
		const elapsed = Date.now() - entryAt;
		if (elapsed < getMaxHoldMs()) return false;

		const mint = String(state.activeMint || "").trim();
		if (!mint) return false;

		// Dust mints are managed only via the Auto Trader UI; ignore them here.
		try {
			const autoKp = await getAutoKeypair();
			const ownerStr = autoKp?.publicKey?.toBase58?.() || "";
			if (ownerStr && isMintInAutoDustCache(mint, ownerStr)) {
				log(`Recycle ignored (dust): ${mint.slice(0, 6)}…`, "warn");
				_clearActivePositionState();
				state.pendingAction = "";
				state.pendingSig = "";
				state.pendingAttempts = 0;
				state.pendingLastTryAt = 0;
				state.pendingSince = 0;
				saveState();
				updateUI();
				_kickPollSoon(250);
				return true;
			}
		} catch {}

		// If balance is already gone, just clear and continue.
		const autoKp = await getAutoKeypair();
		if (autoKp) {
			const ownerStr = autoKp.publicKey.toBase58();
			const bal = await getTokenBalanceUiByMint(ownerStr, mint);
			if (!(Number(bal?.sizeUi || 0) > 0)) {
				log(`Recycle: position already empty for ${mint.slice(0, 6)}…; clearing.`, "help");
				const soldMint = mint;
				_clearActivePositionState();
				state.pendingAction = "";
				state.pendingSig = "";
				state.pendingAttempts = 0;
				state.pendingLastTryAt = 0;
				state.pendingSince = 0;
				saveState();
				updateUI();
				await _syncLastSigToNewest(state.targetWallet);
				const startedQueued = await _startQueuedMintIfAny();
				if (!startedQueued) await _syncToTargetOpenMintAfterExit(soldMint);
				_kickPollSoon(250);
				return true;
			}
		}

		const mins = Math.max(0, Math.round(elapsed / 60_000));
		log(`Recycle: held ${mint.slice(0, 6)}… for ${mins}m; selling…`, "warn");

		const soldMint = mint;
		const r = await mirrorSell(mint);
		if (r?.ok === true || r?.noRoute || r?.dust) {
			log("Recycle SELL complete. Ready for next target mint.", "ok");
			_clearActivePositionState();
			state.pendingAction = "";
			state.pendingSig = "";
			state.pendingAttempts = 0;
			state.pendingLastTryAt = 0;
			state.pendingSince = 0;
			saveState();
			updateUI();
			await _syncLastSigToNewest(state.targetWallet);
			const startedQueued = await _startQueuedMintIfAny();
			if (!startedQueued) await _syncToTargetOpenMintAfterExit(soldMint);
			_kickPollSoon(250);
			return true;
		}

		state.pendingAction = "sell";
		state.pendingSig = String(r?.sig || "");
		state.pendingAttempts = 0;
		state.pendingLastTryAt = Date.now();
		state.pendingSince = Date.now();
		saveState();
		updateUI();
		return false;
	} catch {
		return false;
	}
}

function updateUI() {
	try {
		if (targetEl) targetEl.value = String(state.targetWallet || "");
		if (buyPctEl) buyPctEl.value = String(state.buyPct ?? "");
		if (maxHoldEl) maxHoldEl.value = String(clampMaxHoldMin(state.maxHoldMin, 5));
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
let _kickTimer = null;

function delay(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function _kickPollSoon(ms = 250) {
	try {
		if (!state.enabled) return;
		if (_kickTimer) return;
		_kickTimer = setTimeout(() => {
			_kickTimer = null;
			pollOnce().catch(() => {});
		}, Math.max(0, Number(ms || 0)));
	} catch {}
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
		return { buy, sell, sig, deltas };
	} catch (e) {
		markRpcStress?.(e, 1500);
		return null;
	}
}

async function classifyTargetSwap(sig, targetOwnerStr) {
	const info = await extractBuySellForTarget(sig, targetOwnerStr);
	if (!info) return null;

	const { buy, sell, deltas } = info;

	// If we're following a mint, detect *that specific mint's* sell delta,
	// even if it isn't the largest negative delta (partial sells, etc.).
	if (state.activeMint && deltas && typeof deltas.get === "function") {
		const d = Number(deltas.get(state.activeMint) || 0);
		if (d < -1e-12) {
			return { type: "sell", mint: state.activeMint, deltaUi: d, sig };
		}
	}

	if (state.activeMint && sell?.mint === state.activeMint) {
		return { type: "sell", mint: sell.mint, deltaUi: sell.delta, sig };
	}
	if (state.activeMint && buy?.mint && buy.mint !== state.activeMint) {
		return { type: "buy-next", mint: buy.mint, deltaUi: buy.delta, sig };
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

async function _syncLastSigToNewest(targetPkStr) {
	try {
		const target = String(targetPkStr || "").trim();
		if (!target) return false;
		const { PublicKey } = await loadWeb3();
		const conn = await getConn();
		const pk = new PublicKey(target);
		const recent = await conn.getSignaturesForAddress(pk, { limit: 1 }, "confirmed");
		const list = Array.isArray(recent) ? recent : [];
		const newest = String(list?.[0]?.signature || "");
		if (!newest) return false;
		state.lastSig = newest;
		saveState();
		return true;
	} catch {
		return false;
	}
}

function _extractBuySellFromParsedTx(parsedTx, targetOwnerStr) {
	try {
		const pre = _sumTokenBalances(parsedTx?.meta?.preTokenBalances, targetOwnerStr);
		const post = _sumTokenBalances(parsedTx?.meta?.postTokenBalances, targetOwnerStr);
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
		return { buy, sell, deltas };
	} catch {
		return null;
	}
}

async function _findLatestOpenBuyMintFromTarget(targetPkStr, opts = {}) {
	try {
		const target = String(targetPkStr || "").trim();
		if (!target) return "";
		if (!(await isValidPubkeyStr(target))) return "";

		const avoid = String(opts.avoidMint || "").trim();
		// Back-compat: older callers pass opts.limit. Treat it as max signatures to scan.
		const maxSignatures = Math.max(10, Math.min(5000, Number(opts.maxSignatures ?? opts.limit ?? 250)));
		const pageSize = Math.max(10, Math.min(1000, Number(opts.pageSize || 200)));
		const maxPages = Math.max(1, Math.min(50, Number(opts.maxPages || Math.ceil(maxSignatures / pageSize))));
		const { PublicKey } = await loadWeb3();
		const conn = await getConn();
		const pk = new PublicKey(target);

		let before = String(opts.before || "").trim() || undefined;
		let scanned = 0;

		// Newest-first scan: record sells we see in newer txs, then pick the first buy not sold afterwards.
		const soldMints = new Set();
		const chunkSize = 20;
		for (let page = 0; page < maxPages && scanned < maxSignatures; page++) {
			let sigs;
			try {
				sigs = await conn.getSignaturesForAddress(pk, { limit: pageSize, before }, "confirmed");
			} catch (e) {
				markRpcStress?.(e, 1500);
				return "";
			}
			const list = Array.isArray(sigs) ? sigs : [];
			if (!list.length) break;
			scanned += list.length;

			for (let i = 0; i < list.length; i += chunkSize) {
				const chunk = list
					.slice(i, i + chunkSize)
					.map((x) => String(x?.signature || ""))
					.filter(Boolean);
				if (!chunk.length) continue;

				let parsed;
				try {
					parsed = await conn.getParsedTransactions(chunk, {
						commitment: "confirmed",
						maxSupportedTransactionVersion: 0,
					});
				} catch (e) {
					markRpcStress?.(e, 1500);
					parsed = null;
				}

				const txs = Array.isArray(parsed) ? parsed : [];
				for (const tx of txs) {
					if (!tx || tx?.meta?.err) continue;
					const info = _extractBuySellFromParsedTx(tx, target);
					if (!info) continue;
					const s = String(info.sell?.mint || "").trim();
					const b = String(info.buy?.mint || "").trim();
					if (s) soldMints.add(s);
					if (!b) continue;
					if (soldMints.has(b)) continue;
					if (avoid && b === avoid) continue;
					if (b === SOL_MINT) continue;
					if (isMintBlacklisted(b)) continue;
					if (!(await isValidPubkeyStr(b))) continue;
					return b;
				}
			}

			// Cursor to older history
			before = String(list[list.length - 1]?.signature || "").trim() || before;
			if (!before) break;
		}

		return "";
	} catch {
		return "";
	}
}

async function _findLatestBuyMintFromTarget(targetPkStr, opts = {}) {
	try {
		const target = String(targetPkStr || "").trim();
		if (!target) return "";
		if (!(await isValidPubkeyStr(target))) return "";

		const avoid = String(opts.avoidMint || "").trim();
		const maxSignatures = Math.max(10, Math.min(5000, Number(opts.maxSignatures ?? opts.limit ?? 250)));
		const pageSize = Math.max(10, Math.min(1000, Number(opts.pageSize || 200)));
		const maxPages = Math.max(1, Math.min(50, Number(opts.maxPages || Math.ceil(maxSignatures / pageSize))));
		const { PublicKey } = await loadWeb3();
		const conn = await getConn();
		const pk = new PublicKey(target);

		let before = String(opts.before || "").trim() || undefined;
		let scanned = 0;

		const chunkSize = 20;
		for (let page = 0; page < maxPages && scanned < maxSignatures; page++) {
			let sigs;
			try {
				sigs = await conn.getSignaturesForAddress(pk, { limit: pageSize, before }, "confirmed");
			} catch (e) {
				markRpcStress?.(e, 1500);
				return "";
			}
			const list = Array.isArray(sigs) ? sigs : [];
			if (!list.length) break;
			scanned += list.length;

			for (let i = 0; i < list.length; i += chunkSize) {
				const chunk = list
					.slice(i, i + chunkSize)
					.map((x) => String(x?.signature || ""))
					.filter(Boolean);
				if (!chunk.length) continue;

				let parsed;
				try {
					parsed = await conn.getParsedTransactions(chunk, {
						commitment: "confirmed",
						maxSupportedTransactionVersion: 0,
					});
				} catch (e) {
					markRpcStress?.(e, 1500);
					parsed = null;
				}

				const txs = Array.isArray(parsed) ? parsed : [];
				for (const tx of txs) {
					if (!tx || tx?.meta?.err) continue;
					const info = _extractBuySellFromParsedTx(tx, target);
					const b = String(info?.buy?.mint || "").trim();
					if (!b) continue;
					if (avoid && b === avoid) continue;
					if (b === SOL_MINT) continue;
					if (isMintBlacklisted(b)) continue;
					if (!(await isValidPubkeyStr(b))) continue;
					return b;
				}
			}

			before = String(list[list.length - 1]?.signature || "").trim() || before;
			if (!before) break;
		}

		return "";
	} catch {
		return "";
	}
}

async function _syncToTargetOpenMintAfterExit(avoidMint) {
	try {
		if (!state.enabled) return false;
		if (state.pendingAction) return false;
		if (state.activeMint) return false;
		const target = String(state.targetWallet || "").trim();
		if (!target) return false;

		// Best-effort: find the most recent target buy mint from parsed transactions.
		const b = await _findLatestBuyMintFromTarget(target, { avoidMint, limit: 200 });
		if (!b) return false;

		state.activeMint = b;
		state.entryMint = b;
		state.entrySol = 0;
		state.entryAt = Date.now();
		state.pendingSince = Date.now();
		state.lastActionAttempt = 0;
		state.pendingAction = "";
		state.pendingSig = "";
		state.pendingAttempts = 0;
		state.pendingLastTryAt = 0;
		saveState();
		updateUI();
		log(`Resync: target currently in ${b.slice(0, 6)}…; mirroring buy…`, "help");

		const r = await mirrorBuy(b);
		if (Number(r?.spentSol || 0) > 0) {
			state.entrySol = Number(r.spentSol);
			state.entryAt = Date.now();
			saveState();
		}
		if (r?.blocked) {
			log(`Resync BUY blocked (${String(r?.reason || "").slice(0, 80)}). Clearing; will keep watching target.`, "warn");
			_clearActivePositionState();
			state.pendingAction = "";
			state.pendingSig = "";
			state.pendingAttempts = 0;
			state.pendingLastTryAt = 0;
			state.pendingSince = 0;
			saveState();
			updateUI();
			return false;
		}
		if (!r?.ok) {
			state.pendingAction = "buy";
			state.pendingSig = String(r?.sig || "");
			state.pendingAttempts = 0;
			state.pendingLastTryAt = Date.now();
			state.pendingSince = Date.now();
			saveState();
			updateUI();
		}
		return true;
	} catch {
		return false;
	}
}

async function _autoHasTokenBalance(mintStr) {
	try {
		const mint = String(mintStr || "").trim();
		if (!mint) return false;
		if (mint === SOL_MINT) return false;
		const autoKp = await getAutoKeypair();
		if (!autoKp) return false;
		const ownerStr = autoKp.publicKey.toBase58();
		const bal = await getTokenBalanceUiByMint(ownerStr, mint);
		return Number(bal?.sizeUi || 0) > 0;
	} catch {
		return false;
	}
}

const DYN_SLIP_MIN_BPS = 50;
const DYN_SLIP_MAX_BPS = 2500;

function getDynamicSlippageBps(kind = "buy") {
	const attempts = Math.max(0, Number(state?.pendingAttempts || 0) | 0);
	const base = kind === "sell" ? 300 : 250;
	const slip = base + attempts * 200;
	return Math.floor(clampNum(slip, DYN_SLIP_MIN_BPS, DYN_SLIP_MAX_BPS, base));
}

async function mirrorBuy(mint) {
	if (isMintBlacklisted(mint)) {
		log(`BUY blocked: mint is blacklisted (${String(mint || "").slice(0, 6)}…)`, "warn");
		return { ok: false, sig: "", spentSol: 0, blocked: true, reason: "blacklisted" };
	}

	const slip = getDynamicSlippageBps("buy");
	const autoKp = await getAutoKeypair();
	if (!autoKp) {
		log("No auto wallet configured. Set/import it in the Auto tab first.", "error");
		await debugAutoWalletLoad(log);
		return { ok: false, sig: "", spentSol: 0, blocked: true, reason: "no-auto-wallet" };
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
	const desiredSol = Math.max(0, Number(solBalUi || 0) * getBuyFraction());
	const maxByFractionSol = Math.max(0, Number(solBalUi || 0) * FOLLOW_BUY_MAX_FRACTION_OF_SOL);
	const buySol = Math.min(desiredSol, maxSpendSol, maxByFractionSol);
	if (!(buySol >= 0.001)) {
		log(
			`BUY skipped: insufficient SOL. balance=${solBalUi.toFixed(4)} reserve≈${(reserveLamports / 1e9).toFixed(4)} spendable≈${maxSpendSol.toFixed(4)} cap70%≈${maxByFractionSol.toFixed(4)}`,
			"error",
		);
		return { ok: false, sig: "", spentSol: 0, blocked: true, reason: "insufficient-sol" };
	}
	if (buySol + 1e-9 < desiredSol) {
		const pct = Math.round(getBuyFraction() * 100);
		log(
			`BUY capped: desired≈${pct}% (${desiredSol.toFixed(4)} SOL), spending=${buySol.toFixed(4)} SOL (balance=${solBalUi.toFixed(4)} SOL, cap70%=${maxByFractionSol.toFixed(4)} SOL)`,
			"help",
		);
	}

	// Liquidity sanity check (quote must exist and price impact must be reasonable)
	{
		const chk = await preflightBuyLiquidity({
			dex: getDex(),
			solMint: SOL_MINT,
			mint,
			inputSol: buySol,
			slippageBps: slip,
			maxPriceImpactPct: DEFAULT_BUY_MAX_PRICE_IMPACT_PCT,
			exitCheckFraction: DEFAULT_BUY_EXIT_CHECK_FRACTION,
		});
		if (!chk?.ok) {
			const why = String(chk?.reason || "");
			if (why === "high-impact" || why === "exit-high-impact") {
				const piPct = Number(chk?.priceImpactPct || 0) * 100;
				log(
					`BUY blocked: low liquidity/high impact for ${String(mint || "").slice(0, 6)}… (impact≈${piPct.toFixed(1)}%)`,
					"warn",
				);
			} else {
				log(
					`BUY blocked: no viable liquidity/route for ${String(mint || "").slice(0, 6)}… (${why || "no-route"})`,
					"warn",
				);
			}
			return { ok: false, sig: "", spentSol: 0, blocked: true, reason: why || "no-route" };
		}
	}

	log(`Mirror BUY ${mint.slice(0, 6)}… for ~${buySol.toFixed(4)} SOL`, "ok");
	const res = await getDex().buyWithConfirm(
		{ signer: autoKp, mint, solUi: buySol, slippageBps: slip },
		{ retries: 1, confirmMs: 45_000 },
	);

	if (res?.ok) {
		log(`BUY ok: ${res.sig}`, "ok");
		return { ok: true, sig: res.sig, spentSol: buySol };
	}
	if (res?.insufficient) {
		log(`BUY failed (insufficient SOL): ${res.msg || ""}`, "error");
		return { ok: false, sig: res?.sig || "", spentSol: 0 };
	}
	if (res?.noRoute) {
		log(`BUY failed (no route): ${res.msg || ""}`, "warn");
		return { ok: false, sig: res?.sig || "", spentSol: 0 };
	}
	log(`BUY submitted but not confirmed yet: ${res?.sig || "(no sig)"}`, "warn");
	return { ok: false, sig: res?.sig || "", spentSol: buySol };
}

async function mirrorSell(mint, { noRouteTries = NO_ROUTE_SELL_TRIES, dustOnNoRoute = true } = {}) {
    const slip = getDynamicSlippageBps("sell");
	const autoKp = await getAutoKeypair();
	if (!autoKp) {
		log("No auto wallet configured. Set/import it in the Auto tab first.", "error");
		await debugAutoWalletLoad(log);
		return { ok: false, sig: "" };
	}
	const _isNoRouteRes = (res) => {
		if (!res) return false;
		if (res?.noRoute) return true;
		const code = String(res?.code || "").toUpperCase();
		if (code === "NO_ROUTE") return true;
		const msg = String(res?.msg || res?.error || res?.reason || "");
		return /COULD_NOT_FIND_ANY_ROUTE|NO_ROUTE|Could not find any route|Below min notional/i.test(msg);
	};
	const ownerStr = autoKp.publicKey.toBase58();
	const bal = await getTokenBalanceUiByMint(ownerStr, mint);
	const amountUi = Number(bal?.sizeUi || 0);
	if (!(amountUi > 0)) {
		log(`No balance to sell for ${mint.slice(0, 6)}… (already empty).`, "warn");
		return { ok: true, sig: "" };
	}
	if (isMintInAutoDustCache(mint, ownerStr)) {
		log(`SELL skipped: mint is in dust cache (${mint.slice(0, 6)}…).`, "warn");
		return { ok: true, sig: "", dust: true, skipped: true };
	}

	const decimals = Number.isFinite(Number(bal?.decimals)) ? Number(bal.decimals) : 6;

	const tries = Math.max(1, Number(noRouteTries || NO_ROUTE_SELL_TRIES) | 0);
	let lastRes = null;
	for (let attempt = 1; attempt <= tries; attempt++) {
		log(
			`Mirror SELL ${mint.slice(0, 6)}… amount=${amountUi.toFixed(6)} (try ${attempt}/${tries})`,
			"ok",
		);
		const res = await getDex().sellWithConfirm(
			{ signer: autoKp, mint, amountUi, slippageBps: slip },
			{ retries: 1, confirmMs: 30_000 },
		);
		lastRes = res;

		if (res?.ok) {
			log(`SELL ok: ${res.sig}`, "ok");
			return { ok: true, sig: res.sig };
		}
		if (res?.insufficient) {
			log(`SELL failed (fees/lamports): ${res.msg || ""}`, "error");
			return { ok: false, sig: res?.sig || "" };
		}
		if (_isNoRouteRes(res)) {
			log(`SELL failed (no route): ${res.msg || ""}`, "warn");
			if (attempt < tries) {
				await delay(500);
				continue;
			}

			if (dustOnNoRoute) {
				// Move to dust cache so the auto trader UI can manage/sell it later.
				try {
					addMintToAutoDustCache({ ownerPubkeyStr: ownerStr, mint, sizeUi: amountUi, decimals });
					log(`Moved ${mint.slice(0, 6)}… to dust cache after ${tries} no-route try(ies).`, "warn");
				} catch {}
				return { ok: true, sig: res?.sig || "", noRoute: true, dusted: true, dust: true, skipped: true, msg: res?.msg || "" };
			}

			return { ok: false, sig: res?.sig || "", noRoute: true, dusted: false, msg: res?.msg || "" };
		}
		log(`SELL submitted but not confirmed yet: ${res?.sig || "(no sig)"}`, "warn");
		return { ok: false, sig: res?.sig || "" };
	}

	const fallbackSig = String(lastRes?.sig || "");
	return { ok: false, sig: fallbackSig };
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

		// Process target txs first (e.g., sell signals) so we don't get stuck
		// doing take-profit quoting while missing a target exit.
		const sigs = await fetchNewSignatures(target);
		for (const sig of sigs) {
			const evt = await classifyTargetSwap(sig, target);
			if (!evt) continue;

			if (evt.type === "buy-next") {
				if (isMintBlacklisted(evt.mint)) {
					log(`Target BUY-next ignored (blacklisted): ${evt.mint.slice(0, 6)}…`, "warn");
					continue;
				}
				if (isMintInAutoDustCache(evt.mint)) {
					log(`Target BUY-next ignored (dust): ${evt.mint.slice(0, 6)}…`, "warn");
					continue;
				}
				_queueNextMint(evt.mint, evt.sig);
				continue;
			}

			if (evt.type === "buy") {
				if (state.activeMint) {
					log(`Ignoring BUY ${evt.mint.slice(0, 6)}… (already following ${state.activeMint.slice(0, 6)}…)`, "help");
					continue;
				}
				if (isMintBlacklisted(evt.mint)) {
					log(`Target BUY ignored (blacklisted): ${evt.mint.slice(0, 6)}…`, "warn");
					continue;
				}
				if (isMintInAutoDustCache(evt.mint)) {
					log(`Target BUY ignored (dust): ${evt.mint.slice(0, 6)}…`, "warn");
					continue;
				}
				state.activeMint = evt.mint;
				state.entryMint = evt.mint;
				state.entrySol = 0;
				state.entryAt = Date.now();
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
				if (Number(r?.spentSol || 0) > 0) {
					state.entrySol = Number(r.spentSol);
					state.entryAt = Date.now();
					saveState();
				}
				if (r?.blocked) {
					log(`Target BUY blocked (${String(r?.reason || "").slice(0, 80)}). Clearing and continuing.`, "warn");
					_clearActivePositionState();
					state.pendingAction = "";
					state.pendingSig = "";
					state.pendingAttempts = 0;
					state.pendingLastTryAt = 0;
					state.pendingSince = 0;
					saveState();
					updateUI();
					await _startQueuedMintIfAny();
					_kickPollSoon(250);
					continue;
				}
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
				if (r?.ok === true || r?.noRoute || r?.dust) {
					_clearActivePositionState();
					state.pendingAction = "";
					state.pendingSig = "";
					state.pendingAttempts = 0;
					state.pendingLastTryAt = 0;
					state.pendingSince = 0;
				} else {
					state.pendingAction = "sell";
					state.pendingSig = String(r?.sig || "");
					state.pendingAttempts = 0;
					state.pendingLastTryAt = Date.now();
					state.pendingSince = Date.now();
				}
				saveState();
				updateUI();
				if (r?.ok === true || r?.noRoute || r?.dust) {
					await _startQueuedMintIfAny();
				}
			}
		}

		// Rug check (auto-bot parity): blacklist + force exit on severe rugs.
		await _maybeRugExit();

		// Time-based recycle exit.
		await _maybeRecycleExit();

		// take-profit check (can trigger even if target has no new tx)
		await _maybeTakeProfit();
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
	state.buyPct = clampBuyPct(buyPctEl?.value, state.buyPct);
	state.maxHoldMin = clampMaxHoldMin(maxHoldEl?.value, state.maxHoldMin);
	state.pollMs = Math.floor(clampNum(pollEl?.value, 250, 60_000, 1500));
	state.pendingAction = "";
	state.pendingSig = "";
	state.pendingSince = 0;
	state.lastActionAttempt = 0;

	const persistedMint = String(state.activeMint || "").trim();
	if (persistedMint) {
		const hasPos = await _autoHasTokenBalance(persistedMint);
		if (!hasPos) {
			_clearActivePositionState();
			state.pendingAction = "";
			state.pendingSig = "";
			state.pendingAttempts = 0;
			state.pendingLastTryAt = 0;
			state.pendingSince = 0;
			state.lastActionAttempt = 0;
		}
	}
	if (state.entryMint && state.entryMint !== state.activeMint) {
		state.entryMint = "";
		state.entrySol = 0;
		state.entryAt = 0;
	}

	try {
		const { PublicKey } = await loadWeb3();
		const conn = await getConn();
		const pk = new PublicKey(target);
		const recent = await conn.getSignaturesForAddress(pk, { limit: 25 }, "confirmed");
		const list = Array.isArray(recent) ? recent : [];
		const newest = String(list?.[0]?.signature || "");
		state.lastSig = newest || "";

		// Always try to find the latest buy from target; only overwrite if we don't already
		// have an actual open position in the auto wallet.
		{
			const hasPos = state.activeMint ? await _autoHasTokenBalance(state.activeMint) : false;
			if (!hasPos) {
				const b = await _findLatestBuyMintFromTarget(target, { limit: 200 });
				if (b) {
					if (isMintInAutoDustCache(b)) {
						log(`Startup: latest buy is in dust cache; skipping: ${b.slice(0, 6)}…`, "warn");
					} else {
					state.activeMint = b;
					state.pendingSince = Date.now();
					state.lastActionAttempt = 0;
					log(`Startup: latest buy to follow is ${b} (from parsed txs)`, "help");
					}
				}
			}
		}

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
					if (isMintInAutoDustCache(b)) {
						log(`Startup: buy mint is in dust cache; skipping: ${b.slice(0, 6)}…`, "warn");
						continue;
					}
					if (isMintBlacklisted(b)) continue;
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
	try { setBotRunning('follow', true); } catch {}
	updateUI();
	log(`Follow started. Target=${target.slice(0, 6)}… Auto=${autoKp.publicKey.toBase58().slice(0, 6)}…`, "ok");
	if (state.activeMint) {
		log(`Following mint: ${state.activeMint}`, "ok");
		state.entryMint = state.activeMint;
		state.entrySol = 0;
		state.entryAt = Date.now();
		saveState();
		const r = await mirrorBuy(state.activeMint);
		if (Number(r?.spentSol || 0) > 0) {
			state.entrySol = Number(r.spentSol);
			state.entryAt = Date.now();
			saveState();
		}
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
	try { setBotRunning('follow', false); } catch {}
	state.enabled = false;
	if (_timer) {
		clearInterval(_timer);
		_timer = null;
	}

	state.pendingAction = "";
	state.pendingSig = "";
	saveState();
	updateUI();

	if (window._fdvFollowStopLiquidateInflight) {
		log("Follow stopped.", "warn");
		return;
	}
	window._fdvFollowStopLiquidateInflight = true;

	try {
		// Best-effort: wait briefly for any in-flight poll to finish so we don't race swaps.
		const waitStart = Date.now();
		while (_pollInFlight && Date.now() - waitStart < 2000) {
			await delay(50);
		}

		const autoKp = await getAutoKeypair();
		if (!autoKp) {
			log("Follow stopped.", "warn");
			return;
		}
		const ownerStr = autoKp.publicKey.toBase58();
		log("Stop: liquidating all token balances back to SOL…", "warn");

		const mints = await listNonSolTokenMintsWithBalance(ownerStr);
		if (!mints.length) {
			log("Stop: no token balances to sell.", "help");
		} else {
			log(`Stop: selling ${mints.length} token(s)…`, "help");
			for (const it of mints) {
				const mint = String(it?.mint || "");
				if (!mint || mint === SOL_MINT) continue;
				if (isMintInAutoDustCache(mint, ownerStr)) {
					log(`Stop: skipping dust mint ${mint.slice(0, 6)}…`, "warn");
					continue;
				}
				try {
					const r = await mirrorSell(mint, { noRouteTries: 1, dustOnNoRoute: true });
					if (!r?.ok) {
						log(`Stop: sell failed for ${mint.slice(0, 6)}… (keeping position).`, "warn");
					}
				} catch (e) {
					log(`Stop: sell error for ${mint.slice(0, 6)}…: ${String(e?.message || e || "")}`, "warn");
				}
				await delay(150);
			}
		}

		try {
			await unwrapWsolIfAny(autoKp);
		} catch {}
		try {
			await getDex().closeAllEmptyAtas(autoKp);
		} catch {}

		_clearActivePositionState();
		state.pendingAction = "";
		state.pendingSig = "";
		state.pendingAttempts = 0;
		state.pendingLastTryAt = 0;
		saveState();
		updateUI();
		log("Follow stopped.", "warn");
	} finally {
		window._fdvFollowStopLiquidateInflight = false;
	}
}

export function initFollowWidget(container = document.body) {
	loadState();
	try {
		if (typeof window !== "undefined") {
			window.__fdvFollowMoveToDust = async (mint) => {
				try {
					const autoKp = await getAutoKeypair();
					if (!autoKp) return false;
					const ownerStr = autoKp.publicKey.toBase58();
					const bal = await getTokenBalanceUiByMint(ownerStr, String(mint || ""));
					return addMintToAutoDustCache({
						ownerPubkeyStr: ownerStr,
						mint: String(mint || "").trim(),
						sizeUi: Number(bal?.sizeUi || 0),
						decimals: Number.isFinite(Number(bal?.decimals)) ? Number(bal.decimals) : 6,
					});
				} catch {
					return false;
				}
			};
			window.__fdvFollowIsDust = (mint) => isMintInAutoDustCache(mint);
		}
	} catch {}

	const wrap = document.createElement("div");
	wrap.className = "fdv-follow-wrap";
	wrap.innerHTML = `
		<div class="fdv-tab-content active" data-tab-content="follow">
			<div class="fdv-grid">
				<label>Target Wallet <input id="follow-target" type="text" placeholder="Wallet pubkey"></label>
				<label>Buy % (${FOLLOW_BUY_MIN_PCT}–${FOLLOW_BUY_MAX_PCT}%) <input id="follow-buy-pct" type="number" min="${FOLLOW_BUY_MIN_PCT}" max="${FOLLOW_BUY_MAX_PCT}" step="1"></label>
				<label>Max Hold (min, ≤${RECYCLE_HOLD_MAX_MIN}) <input id="follow-max-hold" type="number" min="1" max="${RECYCLE_HOLD_MAX_MIN}" step="1"></label>
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
	buyPctEl = document.getElementById("follow-buy-pct");
	maxHoldEl = document.getElementById("follow-max-hold");
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
	for (const el of [targetEl, buyPctEl, maxHoldEl, pollEl]) {
		el?.addEventListener("change", () => {
			if (state.enabled) return;
			state.targetWallet = String(targetEl?.value || "").trim();
			state.buyPct = clampBuyPct(buyPctEl?.value, state.buyPct);
			state.maxHoldMin = clampMaxHoldMin(maxHoldEl?.value, state.maxHoldMin);
			state.pollMs = Math.floor(clampNum(pollEl?.value, 250, 60_000, state.pollMs));
			saveState();
			updateUI();
		});
	}
}
