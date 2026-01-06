import { setBotRunning } from "../lib/autoLed.js";
import { createSolanaDepsLoader } from "../lib/solana/deps.js";
import { createConnectionGetter } from "../lib/solana/connection.js";
import { clamp, safeNum } from "../lib/util.js";
import { FEE_RESERVE_MIN, FEE_RESERVE_PCT, RUG_FORCE_SELL_SEVERITY, SOL_MINT } from "../lib/constants.js";
import { dex, getAutoTraderState } from "../trader/index.js";
import { getRugSignalForMint } from "../../../meme/metrics/kpi/pumping.js";

const HOLD_SINGLE_LS_KEY = "fdv_hold_bot_v1";
const HOLD_TABS_LS_KEY = "fdv_hold_tabs_v1";

const HOLD_MAX_TABS = 3;

const MAX_LOG_ENTRIES = 120;

const DEFAULTS = Object.freeze({
	enabled: false,
	mint: "",
	pollMs: 1500,
	buyPct: 25,
	profitPct: 5,
	repeatBuy: false,
	uptickEnabled: true,
});

const UPTICK_PROBE_SOL = 0.01; // fixed probe amount for "price" signal
const UPTICK_MIN_DROP_PCT = 0.25; // fewer tokens for same SOL => price uptick

const UPTICK_PROBE_MIN_INTERVAL_MS = 2500;
const HOLD_EXIT_QUOTE_MIN_INTERVAL_MS = 6000;

const HOLD_RUG_EXTREME_SEV = Math.max(1, Number(RUG_FORCE_SELL_SEVERITY ?? 0.7));

const HOLD_FAST_SWAPS = true;
const HOLD_BUY_CONFIRM_MS = 6000;
const HOLD_SELL_CONFIRM_MS = 6000;
const HOLD_EXIT_DEBIT_TIMEOUT_MS = 12_000;
const HOLD_EXIT_DEBIT_POLL_MS = 300;

const { loadWeb3, loadBs58 } = createSolanaDepsLoader({
	cacheKeyPrefix: "fdv:hold",
	web3Version: "1.95.4",
	bs58Version: "6.0.0",
});

function currentRpcUrl() {
	try {
		const fromLs = typeof localStorage !== "undefined" ? String(localStorage.getItem("fdv_rpc_url") || "") : "";
		return (fromLs || "https://api.mainnet-beta.solana.com").trim();
	} catch {
		return "https://api.mainnet-beta.solana.com";
	}
}

function currentRpcHeaders() {
	try {
		const raw = typeof localStorage !== "undefined" ? String(localStorage.getItem("fdv_rpc_headers") || "") : "";
		if (!raw) return undefined;
		const obj = JSON.parse(raw);
		if (!obj || typeof obj !== "object") return undefined;
		return obj;
	} catch {
		return undefined;
	}
}

const getConn = createConnectionGetter({
	loadWeb3,
	getRpcUrl: currentRpcUrl,
	getRpcHeaders: currentRpcHeaders,
	commitment: "confirmed",
});

function now() {
	return Date.now();
}

function _isNodeLike() {
	try {
		return typeof process !== "undefined" && !!process.versions?.node;
	} catch {
		return false;
	}
}

function _safeJsonParse(raw) {
	try {
		return JSON.parse(String(raw));
	} catch {
		return null;
	}
}

function _newBotId() {
	try {
		return `hb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	} catch {
		return `hb_${Date.now()}`;
	}
}

function _coerceState(obj) {
	const parsed = obj && typeof obj === "object" ? obj : {};
	return {
		...DEFAULTS,
		...parsed,
		pollMs: clamp(safeNum(parsed.pollMs, DEFAULTS.pollMs), 250, 60_000),
		buyPct: clamp(safeNum(parsed.buyPct, DEFAULTS.buyPct), 10, 70),
		profitPct: clamp(safeNum(parsed.profitPct, DEFAULTS.profitPct), 0.1, 500),
		repeatBuy: !!parsed.repeatBuy,
		uptickEnabled: !!parsed.uptickEnabled,
		mint: String(parsed.mint || "").trim(),
		enabled: !!parsed.enabled,
	};
}

function loadHoldTabsState() {
	try {
		if (typeof localStorage === "undefined") {
			const id = _newBotId();
			return {
				activeId: id,
				bots: [{ id, state: _coerceState(DEFAULTS) }],
			};
		}

		const rawTabs = localStorage.getItem(HOLD_TABS_LS_KEY);
		if (rawTabs) {
			const parsed = _safeJsonParse(rawTabs);
			const botsRaw = Array.isArray(parsed?.bots) ? parsed.bots : [];
			let bots = botsRaw
				.map((b) => ({ id: String(b?.id || "").trim(), state: _coerceState(b?.state || b) }))
				.filter((b) => !!b.id);
			if (bots.length > HOLD_MAX_TABS) bots = bots.slice(0, HOLD_MAX_TABS);
			if (bots.length) {
				const activeId = String(parsed?.activeId || bots[0].id);
				const cleaned = { activeId: bots.some((b) => b.id === activeId) ? activeId : bots[0].id, bots };
				try { localStorage.setItem(HOLD_TABS_LS_KEY, JSON.stringify(cleaned)); } catch {}
				return cleaned;
			}
		}

		// Migration from the old single-bot key.
		const rawSingle = localStorage.getItem(HOLD_SINGLE_LS_KEY);
		if (rawSingle) {
			const parsedSingle = _safeJsonParse(rawSingle);
			const id = _newBotId();
			const migrated = { activeId: id, bots: [{ id, state: _coerceState(parsedSingle || {}) }] };
			try {
				localStorage.setItem(HOLD_TABS_LS_KEY, JSON.stringify(migrated));
				localStorage.removeItem(HOLD_SINGLE_LS_KEY);
			} catch {}
			return migrated;
		}

		const id = _newBotId();
		return { activeId: id, bots: [{ id, state: _coerceState(DEFAULTS) }] };
	} catch {
		const id = _newBotId();
		return { activeId: id, bots: [{ id, state: _coerceState(DEFAULTS) }] };
	}
}

function saveHoldTabsState(tabsState) {
	try {
		if (typeof localStorage === "undefined") return;
		const activeId = String(tabsState?.activeId || "").trim();
		const bots = Array.isArray(tabsState?.bots) ? tabsState.bots : [];
		const cleaned = bots
			.map((b) => ({ id: String(b?.id || "").trim(), state: _coerceState(b?.state || b) }))
			.filter((b) => !!b.id);
		const payload = {
			activeId: cleaned.some((b) => b.id === activeId) ? activeId : (cleaned[0]?.id || ""),
			bots: cleaned,
		};
		localStorage.setItem(HOLD_TABS_LS_KEY, JSON.stringify(payload));
	} catch {}
}

function _shortMint(m) {
	const s = String(m || "");
	return s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

async function getAutoKeypair() {
	const st = getAutoTraderState();
	const sec = String(st?.autoWalletSecret || "").trim();
	if (!sec) throw new Error("Auto wallet secret missing (configure in Auto tab)");
	const { Keypair } = await loadWeb3();
	const bs58 = await loadBs58();
	const dec = (bs58?.decode ? bs58 : bs58?.default)?.decode;
	if (typeof dec !== "function") throw new Error("bs58 decode unavailable");
	const sk = dec(sec);
	return Keypair.fromSecretKey(sk);
}

function _getPosForMint(mint) {
	try {
		const st = getAutoTraderState();
		const p = st?.positions?.[mint];
		if (!p || typeof p !== "object") return null;
		const sizeUi = Number(p.sizeUi || 0);
		if (!(sizeUi > 0)) return null;
		return p;
	} catch {
		return null;
	}
}

function _toRawBig(amountUi, decimals = 6) {
	const d = Math.max(0, Math.min(12, Number(decimals || 0) | 0));
	const scale = Math.pow(10, d);
	const n = Number(amountUi || 0);
	if (!Number.isFinite(n) || n <= 0) return 0n;
	const raw = Math.floor(n * scale + 1e-9);
	try {
		return BigInt(raw);
	} catch {
		return 0n;
	}
}

async function _probeOutRaw(mint) {
	const inLamports = Math.floor(UPTICK_PROBE_SOL * 1e9);
	const q = await dex.quoteGeneric(SOL_MINT, mint, String(inLamports), 250);
	const out = q?.outAmount;
	if (!out) return null;
	try {
		return BigInt(out);
	} catch {
		return null;
	}
}

async function _shouldBuyOnUptick(mint, prevProbe) {
	try {
		if (prevProbe?.at && (now() - Number(prevProbe.at || 0) < UPTICK_PROBE_MIN_INTERVAL_MS)) {
			return { ok: false, reason: "COOLDOWN", nextProbe: prevProbe };
		}
	} catch {}
	const cur = await _probeOutRaw(mint);
	if (cur === null) return { ok: false, reason: "NO_QUOTE", nextProbe: { outRawBig: null, at: now() } };
	const nextProbe = { outRawBig: cur, at: now() };
	if (!prevProbe || prevProbe.outRawBig === null) return { ok: false, reason: "NEED_BASELINE", nextProbe };
	if (!(prevProbe.outRawBig > 0n)) return { ok: false, reason: "BAD_BASELINE", nextProbe };

	const drop = Number((prevProbe.outRawBig - cur) * 10000n / prevProbe.outRawBig) / 100;
	return { ok: drop >= UPTICK_MIN_DROP_PCT, dropPct: drop, prevOutRaw: prevProbe.outRawBig, curOutRaw: cur, nextProbe };
}

async function _estimateExitSolForPosition(mint, pos) {
	try {
		const decimals = Number.isFinite(pos?.decimals) ? Number(pos.decimals) : 6;
		const raw = _toRawBig(Number(pos.sizeUi || 0), decimals);
		if (!(raw > 0n)) return 0;
		const st = getAutoTraderState();
		const slip = Math.max(50, Math.min(2000, Number(st?.slippageBps || 250) | 0));
		const q = await dex.quoteGeneric(mint, SOL_MINT, raw.toString(), slip);
		const out = q?.outAmount;
		if (!out) return 0;
		const lamports = BigInt(out);
		return Number(lamports) / 1e9;
	} catch {
		return 0;
	}
}

async function _estimateExitSolFromUiAmount(mint, sizeUi, decimals = 6) {
	try {
		const raw = _toRawBig(Number(sizeUi || 0), Number.isFinite(decimals) ? Number(decimals) : 6);
		if (!(raw > 0n)) return 0;
		const st = getAutoTraderState();
		const slip = Math.max(50, Math.min(2000, Number(st?.slippageBps || 250) | 0));
		const q = await dex.quoteGeneric(mint, SOL_MINT, raw.toString(), slip);
		const out = q?.outAmount;
		if (!out) return 0;
		return Number(BigInt(out)) / 1e9;
	} catch {
		return 0;
	}
}

async function _getOwnerSolBalanceUi(ownerPubkey) {
	try {
		const conn = await getConn();
		const lamports = await conn.getBalance(ownerPubkey, "confirmed");
		return Math.max(0, Number(lamports || 0) / 1e9);
	} catch {
		return 0;
	}
}

function _reserveSol(balanceSol) {
	const bal = Math.max(0, Number(balanceSol || 0));
	const pct = Math.max(0, Math.min(0.5, Number(FEE_RESERVE_PCT || 0)));
	const min = Math.max(0, Number(FEE_RESERVE_MIN || 0));
	return Math.max(min, bal * pct);
}

function _upsertAutoPosFromCredit({ mint, sizeUi, decimals, addCostSol = 0 } = {}) {
	try {
		const m = String(mint || "").trim();
		const s = Number(sizeUi || 0);
		if (!m || !(s > 0)) return false;
		const dRaw = Number(decimals);
		const d = Number.isFinite(dRaw) ? dRaw : 6;
		const st = getAutoTraderState();
		st.positions = st.positions && typeof st.positions === "object" ? st.positions : {};
		const prev = st.positions[m] || { costSol: 0, hwmSol: 0, acquiredAt: now() };
		const add = Math.max(0, Number(addCostSol || 0));
		const pos = {
			...prev,
			sizeUi: s,
			decimals: d,
			awaitingSizeSync: false,
			lastSeenAt: now(),
		};
		if (add > 0) {
			pos.costSol = Number(pos.costSol || 0) + add;
			pos.hwmSol = Math.max(Number(pos.hwmSol || 0), add);
			pos.lastBuyAt = now();
			if (!Number(pos.acquiredAt || 0)) pos.acquiredAt = now();
		}
		st.positions[m] = pos;
		return true;
	} catch {
		return false;
	}
}

function _clearAutoPosForMint(mint) {
	try {
		const m = String(mint || "").trim();
		if (!m) return;
		const st = getAutoTraderState();
		if (!st?.positions || typeof st.positions !== "object") return;
		delete st.positions[m];
	} catch {}
}
function createHoldBotInstance({ id, initialState, onPersist, onAnyRunningChanged, onLabelChanged } = {}) {
	const botId = String(id || "").trim() || _newBotId();
	let state = _coerceState(initialState || {});

	let logEl;
	let startBtn;
	let stopBtn;
	let chartBtn;
	let mintEl;
	let pollEl;
	let buyPctEl;
	let profitEl;
	let repeatEl;
	let uptickEl;

	let _timer = null;
	let _tickInFlight = false;
	let _runNonce = 0;
	let _acceptLogs = true;
	let _lastProbe = null; // { outRawBig, at }
	let _lastExitQuote = null; // { mint, sizeUi, decimals, solUi, at }
	let _rugStopPending = false;
	let _pendingEntry = null; // { mint, sig, at, until, ownerStr, addCostSol, lastReconAt, lastCreditProbeAt }
	let _pendingExit = null; // { mint, sig, at, ownerStr, prevSizeUi }
	let _cycle = null; // { mint, ownerStr, costSol, sizeUi, decimals, enteredAt, lastSeenAt }

	const _traceLast = new Map();

	function _persist() {
		try {
			if (typeof onPersist === "function") onPersist(botId, { ...state });
		} catch {}
	}

	function _emitAnyRunning() {
		try {
			if (typeof onAnyRunningChanged === "function") onAnyRunningChanged();
		} catch {}
	}

	function _emitLabelChanged() {
		try {
			if (typeof onLabelChanged === "function") onLabelChanged(botId);
		} catch {}
	}

	function log(msg, type = "info", force = false) {
		try {
			if (!_acceptLogs && !force) return;
			const line = `[${new Date().toLocaleTimeString()}] ${String(msg ?? "")}`;
			try {
				const wantConsole = !!(typeof window !== "undefined" && window._fdvLogToConsole);
				const nodeLike = typeof process !== "undefined" && !!process?.stdout;
				if ((wantConsole || (nodeLike && !logEl)) && line) {
					const t = String(type || "").toLowerCase();
					if (t.startsWith("err")) console.error(line);
					else if (t.startsWith("war")) console.warn(line);
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

	function traceOnce(key, msg, everyMs = 6000, type = "info") {
		try {
			const k = String(key || "");
			const last = Number(_traceLast.get(k) || 0);
			if (now() - last < everyMs) return;
			_traceLast.set(k, now());
			log(msg, type);
		} catch {
			log(msg, type);
		}
	}

	function _hasActiveCycleForMint(mint) {
		try {
			const m = String(mint || "").trim();
			if (!m) return false;
			return !!(_cycle && _cycle.mint === m && Number(_cycle.costSol || 0) > 0);
		} catch {
			return false;
		}
	}

	function _setCycleFromCredit({ mint, ownerStr, costSol, sizeUi, decimals } = {}) {
		try {
			const m = String(mint || "").trim();
			const o = String(ownerStr || "").trim();
			const c = Math.max(0, Number(costSol || 0));
			const s = Math.max(0, Number(sizeUi || 0));
			const d = Number.isFinite(Number(decimals)) ? Number(decimals) : 6;
			if (!m || !(c > 0) || !(s > 0)) return false;
			_cycle = { mint: m, ownerStr: o, costSol: c, sizeUi: s, decimals: d, enteredAt: now(), lastSeenAt: now() };
			return true;
		} catch {
			return false;
		}
	}

	function _clearCycle(reason = "") {
		try {
			_cycle = null;
			if (reason) log(String(reason), "help");
		} catch {}
	}

	async function _tryReconcilePendingEntry(p) {
		try {
			if (!p || typeof p !== "object") return;
			const ownerStr = String(p.ownerStr || "").trim();
			const mint = String(p.mint || "").trim();
			if (!ownerStr || !mint) return;
			const t = now();
			const lastRecon = Number(p.lastReconAt || 0);
			if (t - lastRecon < 2500) return;
			p.lastReconAt = t;

			const lastProbe = Number(p.lastCreditProbeAt || 0);
			if (t - lastProbe >= 5500) {
				p.lastCreditProbeAt = t;
				const got = await dex.waitForTokenCredit(ownerStr, mint, { timeoutMs: 1800, pollMs: 250 });
				if (Number(got?.sizeUi || 0) > 0) {
					const alreadyApplied = !!p.costApplied;
					const addCostSol = alreadyApplied ? 0 : Number(p.addCostSol || 0);
					// Important: credit checks can race (this reconcile runs in background while the main tick is also awaiting
					// a credit). Mark cost as applied before upserting to avoid double-counting the cost basis.
					if (!alreadyApplied) p.costApplied = true;
					_setCycleFromCredit({ mint, ownerStr, costSol: Number(p.addCostSol || 0), sizeUi: got.sizeUi, decimals: got.decimals });
					_upsertAutoPosFromCredit({ mint, sizeUi: got.sizeUi, decimals: got.decimals, addCostSol });
				}
			}
		} catch {}
	}

	function _readUiToState() {
		state.mint = String(mintEl?.value || state.mint || "").trim();
		state.pollMs = clamp(safeNum(pollEl?.value, state.pollMs), 250, 60_000);
		state.buyPct = clamp(safeNum(buyPctEl?.value, state.buyPct), 10, 70);
		state.profitPct = clamp(safeNum(profitEl?.value, state.profitPct), 0.1, 500);
		state.repeatBuy = !!repeatEl?.checked;
		state.uptickEnabled = !!uptickEl?.checked;
		_emitLabelChanged();
		_persist();
	}

	function updateUI() {
		try {
			if (mintEl) mintEl.value = String(state.mint || "");
			if (pollEl) pollEl.value = String(state.pollMs || DEFAULTS.pollMs);
			if (buyPctEl) buyPctEl.value = String(state.buyPct || DEFAULTS.buyPct);
			if (profitEl) profitEl.value = String(state.profitPct || DEFAULTS.profitPct);
			if (repeatEl) repeatEl.checked = !!state.repeatBuy;
			if (uptickEl) uptickEl.checked = !!state.uptickEnabled;
			if (startBtn) startBtn.disabled = !!state.enabled;
			if (stopBtn) stopBtn.disabled = !state.enabled;
			if (chartBtn) chartBtn.disabled = !String(state.mint || "").trim();
		} catch {}
	}

	function _dexscreenerUrlForMint(mint) {
		const m = String(mint || "").trim();
		if (!m) return "";
		return `https://dexscreener.com/solana/${encodeURIComponent(m)}`;
	}

	async function tickOnce(runId) {
		if (!state.enabled) return;
		if (_tickInFlight) return;
		_tickInFlight = true;
		try {
			if (runId !== _runNonce) return;
			const mint = String(state.mint || "").trim();
			if (!mint) {
				log("Missing mint.", "warn");
				return;
			}

			// If a sell was already sent (fast mode), do not re-submit; wait for debit.
			try {
				const pe = _pendingExit;
				if (pe && pe.mint === mint) {
					const age = now() - Number(pe.at || 0);
					const left = Math.max(0, HOLD_EXIT_DEBIT_TIMEOUT_MS - age);
					traceOnce(
						`hold:${botId}:awaitDebit:${mint}`,
						`Sell sent; awaiting debit for ${_shortMint(mint)}… (${Math.ceil(left / 1000)}s window)`,
						2500,
						"help",
					);
					return;
				}
			} catch {}

			// EXTREME rug detection: block buys and force liquidation if already holding.
			let rugSig = null;
			let rugSev = 0;
			try {
				rugSig = getRugSignalForMint(mint);
				rugSev = Number(rugSig?.sev ?? rugSig?.severity ?? 0);
			} catch {
				rugSig = null;
				rugSev = 0;
			}

			const pos = _getPosForMint(mint);
			if (rugSig?.rugged && rugSev >= HOLD_RUG_EXTREME_SEV) {
				if (pos || _hasActiveCycleForMint(mint)) {
					traceOnce(
						`hold:${botId}:rug:liquidate:${mint}`,
						`EXTREME rug signal for ${_shortMint(mint)} sev=${rugSev.toFixed(2)} (thr=${HOLD_RUG_EXTREME_SEV.toFixed(2)}). Emergency liquidate…`,
						8000,
						"warn",
					);
					if (!_rugStopPending) {
						_rugStopPending = true;
						setTimeout(() => {
							try { _rugStopPending = false; } catch {}
							void stop({ liquidate: true });
						}, 0);
					}
					return;
				}
				traceOnce(
					`hold:${botId}:rug:blockBuy:${mint}`,
					`EXTREME rug signal for ${_shortMint(mint)} sev=${rugSev.toFixed(2)} (thr=${HOLD_RUG_EXTREME_SEV.toFixed(2)}). Blocking buys.`,
					9000,
					"warn",
				);
				return;
			}
			try {
				if (pos && _pendingEntry && _pendingEntry.mint === mint) {
					_pendingEntry = null;
				}
				if (!pos && _pendingEntry && _pendingEntry.mint === mint) {
					try { await _tryReconcilePendingEntry(_pendingEntry); } catch {}
					const pos2 = _getPosForMint(mint);
					if (pos2 || _hasActiveCycleForMint(mint)) {
						_pendingEntry = null;
					}
					if (_pendingEntry === null) {
						// Position appeared after reconciliation.
						return;
					}
					const left = Math.max(0, Number(_pendingEntry.until || 0) - now());
					if (left > 0) {
						traceOnce(
							`hold:${botId}:awaitCredit:${mint}`,
							`Buy submitted; awaiting position sync for ${_shortMint(mint)}… (${Math.ceil(left / 1000)}s left)${_pendingEntry.sig ? ` sig=${String(_pendingEntry.sig).slice(0, 6)}…` : ""}`,
							Math.max(2000, Math.min(9000, Number(state.pollMs || 1500) * 2)),
							"help",
						);
						return;
					}
					// Timed out waiting; allow another attempt.
					_pendingEntry = null;
				}
			} catch {}

			// If we have an active hold cycle, never attempt a new buy.
			if (!pos && _hasActiveCycleForMint(mint)) {
				// Refresh size occasionally (and detect manual sell -> clear cycle).
				try {
					const c = _cycle;
					if (c && c.ownerStr) {
						const got = await dex.waitForTokenCredit(c.ownerStr, mint, { timeoutMs: 900, pollMs: 250 });
						if (Number(got?.sizeUi || 0) > 0) {
							c.sizeUi = Number(got.sizeUi || c.sizeUi);
							if (Number.isFinite(got.decimals)) c.decimals = got.decimals;
							c.lastSeenAt = now();
						} else {
							// If we can't see a balance for a while, assume the position is gone.
							const age = now() - Number(c.lastSeenAt || c.enteredAt || 0);
							if (age > 20_000) {
								_clearCycle(`No token balance detected for ${_shortMint(mint)}; clearing cycle.`);
							}
						}
					}
				} catch {}
			}

			if (!pos && !_hasActiveCycleForMint(mint)) {
				// Not holding yet: optionally wait for an uptick.
				if (state.uptickEnabled) {
					const up = await _shouldBuyOnUptick(mint, _lastProbe);
					try {
						if (up && "nextProbe" in up) _lastProbe = up.nextProbe;
					} catch {}
					if (!up?.ok) {
						const drop = Number(up?.dropPct || 0);
						const reason = String(up?.reason || "");
						traceOnce(
							`hold:${botId}:waitUptick:${mint}`,
							`Waiting for uptick on ${_shortMint(mint)}… probe=${UPTICK_PROBE_SOL.toFixed(3)} SOL drop=${drop.toFixed(2)}% (min ${UPTICK_MIN_DROP_PCT.toFixed(2)}%)${reason ? ` (${reason})` : ""}`,
							Math.max(1500, Math.min(8000, Number(state.pollMs || 1500) * 2)),
							"help",
						);
						return;
					}
					log(
						`Uptick detected on ${_shortMint(mint)} (drop=${Number(up?.dropPct || 0).toFixed(2)}%); buying…`,
						"ok",
					);
				}

				const buyPct = clamp(safeNum(state.buyPct, DEFAULTS.buyPct), 10, 70) / 100;
				const st = getAutoTraderState();
				const slip = Math.max(50, Math.min(2000, Number(st?.slippageBps || 250) | 0));
				let kp;
				try {
					kp = await getAutoKeypair();
				} catch (e) {
					log(String(e?.message || e || "Wallet error"), "error");
					return;
				}

				const balSol = await _getOwnerSolBalanceUi(kp.publicKey);
				const reserve = _reserveSol(balSol);
				const spendable = Math.max(0, balSol - reserve);
				const buySol = Math.max(0, spendable * buyPct);
				if (!(buySol > 0)) {
					log(`No spendable SOL (bal=${balSol.toFixed(4)} SOL, reserve≈${reserve.toFixed(4)} SOL).`, "warn");
					return;
				}

				log(
					`Sizing buy: bal=${balSol.toFixed(4)} SOL reserve≈${reserve.toFixed(4)} SOL spendable≈${spendable.toFixed(4)} SOL pct=${(buyPct * 100).toFixed(0)}% => buy≈${buySol.toFixed(4)} SOL`,
					"help",
				);
				log(`Buying ${_shortMint(mint)}…`, "info");
				const res = await dex.buyWithConfirm(
					{ signer: kp, mint, solUi: buySol, slippageBps: slip },
					{ retries: 0, confirmMs: HOLD_BUY_CONFIRM_MS, fastConfirm: HOLD_FAST_SWAPS, closeWsolAta: false },
				);
				const ownerStr = (() => {
					try { return kp.publicKey.toBase58(); } catch { return ""; }
				})();
				try {
					if (res?.sig) {
						log(`Buy sent (${String(res.sig).slice(0, 8)}…); awaiting token credit…`, "help");
					}
				} catch {}
				try {
					if (res?.sig) {
						const autoSt = getAutoTraderState();
						const graceMs = Math.max(60_000, Number(autoSt?.pendingGraceMs || 120_000));
						_pendingEntry = {
							mint,
							sig: res.sig,
							at: now(),
							until: now() + graceMs,
							ownerStr,
							addCostSol: buySol,
							lastReconAt: 0,
							lastCreditProbeAt: 0,
						};
						traceOnce(
							`hold:${botId}:pendingEntry:${mint}`,
							`Buy placed for ${_shortMint(mint)}; waiting up to ${Math.ceil(graceMs / 1000)}s for position sync…`,
							3000,
							"help",
						);
						try { void _tryReconcilePendingEntry(_pendingEntry); } catch {}
					}
				} catch {}
				if (res?.ok) {
					log(`Buy sent/confirmed (${res.sig || "no-sig"}).`, "ok");
				} else {
					log(`Buy not confirmed yet (${res?.sig || "no-sig"}); will keep watching.`, "help");
				}

				try {
					if (ownerStr) {
						traceOnce(
							`hold:${botId}:creditWait:${mint}`,
							`Checking token credit for ${_shortMint(mint)} (up to ~8s)…`,
							2500,
							"help",
						);
						const got = await dex.waitForTokenCredit(ownerStr, mint, { timeoutMs: 1200, pollMs: 300 });
						if (Number(got?.sizeUi || 0) > 0) {
							_setCycleFromCredit({ mint, ownerStr, costSol: buySol, sizeUi: got.sizeUi, decimals: got.decimals });
							let addCostSol = buySol;
							try {
								if (_pendingEntry && _pendingEntry.mint === mint) {
									if (_pendingEntry.costApplied) addCostSol = 0;
									else _pendingEntry.costApplied = true;
								}
							} catch {}
							_upsertAutoPosFromCredit({ mint, sizeUi: got.sizeUi, decimals: got.decimals, addCostSol });
							log(
								`Buy credited for ${_shortMint(mint)}: size≈${Number(got.sizeUi).toFixed(6)} (dec=${Number(got.decimals || 0) || 6}).`,
								"ok",
							);
							_pendingEntry = null;
						} else {
							traceOnce(
								`hold:${botId}:creditMiss:${mint}`,
								`No on-chain credit detected yet for ${_shortMint(mint)}; will keep reconciling in background.`,
								4000,
								"warn",
							);
						}
					}
				} catch (e) {
					traceOnce(
						`hold:${botId}:creditErr:${mint}`,
						`Token credit check failed: ${String(e?.message || e || "credit error")}`,
						6000,
						"warn",
					);
				}
				return;
			}

			// Holding: wait indefinitely until profit threshold met.
			const active = pos || (_hasActiveCycleForMint(mint) ? _cycle : null);
			if (!active) return;
			const cost = Number(active.costSol || 0);
			if (!(cost > 0)) {
				log(`Holding ${_shortMint(mint)}… (cost unknown)`, "help");
				return;
			}
			const estOut = pos
				? await (async () => {
					try {
						const last = _lastExitQuote;
						const age = now() - Number(last?.at || 0);
						const wantMint = String(last?.mint || "") === mint;
						if (wantMint && age < HOLD_EXIT_QUOTE_MIN_INTERVAL_MS && Number.isFinite(last?.solUi) && last.solUi > 0) {
							return Number(last.solUi);
						}
					} catch {}
					const out = await _estimateExitSolForPosition(mint, pos);
					try {
						if (out > 0) {
							_lastExitQuote = {
								mint,
								sizeUi: Number(pos?.sizeUi || 0),
								decimals: Number(pos?.decimals || 6),
								solUi: out,
								at: now(),
							};
						}
					} catch {}
					return out;
				})()
				: await (async () => {
					try {
						const last = _lastExitQuote;
						const age = now() - Number(last?.at || 0);
						const wantMint = String(last?.mint || "") === mint;
						if (wantMint && age < HOLD_EXIT_QUOTE_MIN_INTERVAL_MS && Number.isFinite(last?.solUi) && last.solUi > 0) {
							return Number(last.solUi);
						}
					} catch {}
					const out = await _estimateExitSolFromUiAmount(mint, Number(active.sizeUi || 0), Number(active.decimals || 6));
					try {
						if (out > 0) {
							_lastExitQuote = {
								mint,
								sizeUi: Number(active?.sizeUi || 0),
								decimals: Number(active?.decimals || 6),
								solUi: out,
								at: now(),
							};
						}
					} catch {}
					return out;
				})();
			if (!(estOut > 0)) {
				log(`Holding ${_shortMint(mint)}… (quote unavailable)`, "help");
				return;
			}
			const pnlPct = ((estOut - cost) / cost) * 100;
			if (Number.isFinite(pnlPct)) {
				traceOnce(
					`hold:${botId}:pnl:${mint}`,
					`Holding ${_shortMint(mint)}… cost=${cost.toFixed(4)} SOL estOut=${estOut.toFixed(4)} SOL pnl=${pnlPct.toFixed(2)}% target=${Number(state.profitPct || DEFAULTS.profitPct).toFixed(2)}%`,
					Math.max(2000, Math.min(8000, Number(state.pollMs || 1500) * 2)),
					"info",
				);
			}
			if (pnlPct < Number(state.profitPct || DEFAULTS.profitPct)) return;

			let kp;
			try {
				kp = await getAutoKeypair();
			} catch (e) {
				log(String(e?.message || e || "Wallet error"), "error");
				return;
			}
			const st = getAutoTraderState();
			const slip = Math.max(50, Math.min(2000, Number(st?.slippageBps || 250) | 0));
			log(`Profit target hit (${pnlPct.toFixed(2)}% ≥ ${Number(state.profitPct).toFixed(2)}%). Selling…`, "ok");
			const ownerStr = (() => {
				try { return kp.publicKey.toBase58(); } catch { return ""; }
			})();
			const prevSizeUi = Number(pos?.sizeUi || active?.sizeUi || 0);
			const res = await dex.sellWithConfirm(
				{ signer: kp, mint, amountUi: 0, slippageBps: slip },
				{ retries: 0, confirmMs: HOLD_SELL_CONFIRM_MS, fastConfirm: HOLD_FAST_SWAPS, closeTokenAta: false, closeWsolAta: false },
			);

			if (res?.ok) {
				log(`Sell confirmed (${res.sig || "no-sig"}).`, "ok");
				_lastProbe = null;
				_lastExitQuote = null;
				_pendingEntry = null;
				_pendingExit = null;
				_clearAutoPosForMint(mint);
				_clearCycle();
				if (!state.repeatBuy) {
					await stop({ liquidate: false });
					return;
				}
				log("Repeat enabled; waiting for next entry.", "help");
				return;
			}

			if (res?.noBalance) {
				log(`Sell skipped: no on-chain balance to sell for ${_shortMint(mint)}.`, "warn");
				_lastProbe = null;
				_lastExitQuote = null;
				_pendingEntry = null;
				_pendingExit = null;
				_clearAutoPosForMint(mint);
				_clearCycle();
				if (!state.repeatBuy) {
					await stop({ liquidate: false });
					return;
				}
				return;
			}

			if (res?.sig) {
				log(`Sell sent (${String(res.sig).slice(0, 8)}…); awaiting debit…`, "help");
				_pendingExit = { mint, sig: res.sig, at: now(), ownerStr, prevSizeUi };
				void (async () => {
					try {
						if (!ownerStr) return;
						const deb = await dex.waitForTokenDebit(ownerStr, mint, prevSizeUi, {
							timeoutMs: HOLD_EXIT_DEBIT_TIMEOUT_MS,
							pollMs: HOLD_EXIT_DEBIT_POLL_MS,
						});
						if (deb?.debited) {
							log(`Sell debited (remain≈${Number(deb.remainUi || 0).toFixed(6)}).`, "ok");
							_lastProbe = null;
							_lastExitQuote = null;
							_pendingEntry = null;
							_pendingExit = null;
							_clearAutoPosForMint(mint);
							_clearCycle();
							if (!state.repeatBuy) {
								await stop({ liquidate: false });
								return;
							}
							log("Repeat enabled; waiting for next entry.", "help");
							return;
						}
						// If we timed out without seeing debit, allow retries.
						try {
							if (_pendingExit && _pendingExit.sig === res.sig) {
								log(`Sell debit not detected yet for ${_shortMint(mint)}; will retry if still holding.`, "warn");
								_pendingExit = null;
							}
						} catch {}
					} catch (e) {
						traceOnce(
							`hold:${botId}:debitWatchErr:${mint}`,
							`Debit watch failed for ${_shortMint(mint)}; will retry if still holding. (${String(e?.message || e || "debit error")})`,
							6000,
							"warn",
						);
						try { _pendingExit = null; } catch {}
					}
				})();
				return;
			}

			log(`Sell not confirmed (${res?.sig || "no-sig"}); will keep watching.`, "warn");
		} catch (e) {
			log(String(e?.message || e || "Tick error"), "err");
		} finally {
			_tickInFlight = false;
		}
	}

	function startLoop() {
		const runId = ++_runNonce;
		try { if (_timer) clearInterval(_timer); } catch {}
		_timer = setInterval(() => {
			void tickOnce(runId);
		}, Math.max(250, Number(state.pollMs || DEFAULTS.pollMs)));
	}

	async function start({ resume = false } = {}) {
		if (state.enabled && !resume) return;
		_readUiToState();
		state.enabled = true;
		_acceptLogs = true;
		_lastProbe = null;
		_pendingExit = null;
		_persist();
		_emitAnyRunning();
		updateUI();
		log(
			`Hold started. mint=${state.mint ? state.mint.slice(0, 6) + "…" : ""} poll=${state.pollMs}ms buyPct=${Number(state.buyPct || DEFAULTS.buyPct).toFixed(0)}% profit=${Number(state.profitPct || DEFAULTS.profitPct).toFixed(2)}% uptick=${state.uptickEnabled ? "on" : "off"} repeat=${state.repeatBuy ? "on" : "off"}`,
			"ok",
			true,
		);
		startLoop();
		await tickOnce(_runNonce);
	}

	async function stop({ liquidate = true } = {}) {
		const mint = String((_cycle?.mint || state.mint || "")).trim();

		if (!state.enabled) {
			_emitAnyRunning();
			updateUI();
			return;
		}

		// Stop the loop immediately.
		state.enabled = false;
		_runNonce++;
		_persist();
		_emitAnyRunning();
		try { if (_timer) clearInterval(_timer); } catch {}
		_timer = null;
		updateUI();

		if (liquidate && mint) {
			try {
				_acceptLogs = true;
				log(`Stop requested; liquidating ${_shortMint(mint)}…`, "warn", true);

				// If a tick/swap is in progress, give it a moment to settle.
				try {
					const start = now();
					while (_tickInFlight && (now() - start < 10_000)) {
						await new Promise((r) => setTimeout(r, 250));
					}
				} catch {}

				try {
					const p = _pendingEntry;
					if (p && p.mint === mint && p.ownerStr) {
						void (async () => {
							try {
								const got = await dex.waitForTokenCredit(p.ownerStr, mint, { timeoutMs: 20_000, pollMs: 300 });
								if (Number(got?.sizeUi || 0) > 0) {
									_setCycleFromCredit({ mint, ownerStr: p.ownerStr, costSol: Number(p.addCostSol || 0), sizeUi: got.sizeUi, decimals: got.decimals });
									_upsertAutoPosFromCredit({ mint, sizeUi: got.sizeUi, decimals: got.decimals, addCostSol: Number(p.addCostSol || 0) });
									log(`Stop-liquidation: position credited size≈${Number(got.sizeUi).toFixed(6)}; selling ASAP…`, "help", true);
								}
							} catch {}
						})();
					}
				} catch {}

				let kp;
				try {
					kp = await getAutoKeypair();
				} catch (e) {
					log(String(e?.message || e || "Wallet error"), "error", true);
					kp = null;
				}

				if (kp) {
					const st = getAutoTraderState();
					const baseSlip = Math.max(50, Math.min(2000, Number(st?.slippageBps || 250) | 0));

					const trySell = async (slippageBps) => {
						return await dex.sellWithConfirm(
							{ signer: kp, mint, amountUi: 0, slippageBps },
							{ retries: 2, confirmMs: 45_000 },
						);
					};

					let res = await trySell(baseSlip);
					if (!res?.ok && !res?.noBalance) {
						const code = String(res?.code || "");
						const msg = String(res?.msg || "");
						log(
							`Stop-liquidation attempt 1 failed: ${code || ""}${msg ? ` ${msg}` : ""}${res?.sig ? ` sig=${String(res.sig).slice(0, 8)}…` : ""}`.trim(),
							"warn",
							true,
						);
						// Common fast fix: bump slippage and retry once.
						const slip2 = Math.max(baseSlip, Math.min(3000, Math.floor(baseSlip * 1.6)));
						if (slip2 !== baseSlip) {
							await new Promise((r) => setTimeout(r, 400));
							res = await trySell(slip2);
						}
					}

					if (res?.ok) {
						log(`Stop-liquidation sell confirmed (${res.sig || "no-sig"}).`, "ok", true);
						// Only clear cycle/pending when we know the exit happened.
						_lastProbe = null;
						_lastExitQuote = null;
						_pendingEntry = null;
						_clearCycle();
					} else if (res?.noBalance) {
						log(`Stop-liquidation: no on-chain balance to sell for ${_shortMint(mint)}.`, "warn", true);
						// If we were waiting on a credit, don't discard that state.
						if (!_pendingEntry) {
							_lastProbe = null;
							_lastExitQuote = null;
							_clearCycle();
						}
					} else {
						const code = String(res?.code || "");
						const msg = String(res?.msg || "");
						log(
							`Stop-liquidation sell not confirmed (${res?.sig || "no-sig"})${code || msg ? ` code=${code || ""}${msg ? ` msg=${msg}` : ""}` : ""}; position may still be held.`,
							"warn",
							true,
						);
						// Intentionally keep _cycle/_pendingEntry so a later restart won't re-buy.
					}
				}
			} catch (e) {
				log(`Stop-liquidation error: ${String(e?.message || e || "sell error")}`, "warn", true);
			}
		}

		// If liquidation succeeded/no-balance, cycle may already be cleared above.
		log("Hold stopped.", "warn", true);
	}

	function mount(panelEl) {
		const root = panelEl;
		root.innerHTML = `
			<div class="fdv-tab-content active" data-tab-content="hold">
				<div class="fdv-grid">
					<label>Target Mint <input data-hold-mint type="text" placeholder="Mint address"></label>
					<label>Poll (ms) <input data-hold-poll type="number" min="250" max="60000" step="50"></label>
					<label>Buy % (10-70%) <input data-hold-buy-pct type="number" min="10" max="70" step="1"></label>
					<label>Profit % to sell <input data-hold-profit type="number" min="0.1" max="500" step="0.1"></label>
				</div>

				<div class="fdv-log" data-hold-log></div>
				<div class="fdv-actions" style="margin-top:6px;">
					<div class="fdv-actions-left" style="display:flex; flex-direction:row; gap:4px; align-items:center;">
						<label style="display:flex;flex-direction:row;align-items:center;gap:4px;">Repeat<input data-hold-repeat type="checkbox"></label>
						<label style="display:flex;flex-direction:row;align-items:center;gap:4px;">Uptick<input data-hold-uptick type="checkbox"></label>
					</div>
					<div class="fdv-actions-right">
						<button data-hold-start>Start</button>
						<button data-hold-stop>Stop</button>
						<button data-hold-chart title="Open Dexscreener chart">Chart</button>
					</div>
				</div>
			</div>
		`;

		mintEl = root.querySelector("[data-hold-mint]");
		pollEl = root.querySelector("[data-hold-poll]");
		buyPctEl = root.querySelector("[data-hold-buy-pct]");
		profitEl = root.querySelector("[data-hold-profit]");
		repeatEl = root.querySelector("[data-hold-repeat]");
		uptickEl = root.querySelector("[data-hold-uptick]");
		logEl = root.querySelector("[data-hold-log]");
		startBtn = root.querySelector("[data-hold-start]");
		stopBtn = root.querySelector("[data-hold-stop]");
		chartBtn = root.querySelector("[data-hold-chart]");

		updateUI();

		const onChange = () => {
			_readUiToState();
			updateUI();
			if (state.enabled) startLoop();
		};

		mintEl?.addEventListener("change", onChange);
		pollEl?.addEventListener("change", onChange);
		buyPctEl?.addEventListener("change", onChange);
		profitEl?.addEventListener("change", onChange);
		repeatEl?.addEventListener("change", onChange);
		uptickEl?.addEventListener("change", onChange);

		startBtn?.addEventListener("click", async () => {
			await start();
		});
		stopBtn?.addEventListener("click", async () => {
			await stop();
		});
		chartBtn?.addEventListener("click", () => {
			try {
				// Prefer the live input value so user can click Chart before change/blur.
				const m = String(mintEl?.value || state.mint || "").trim();
				if (!m) return;
				const url = _dexscreenerUrlForMint(m);
				if (!url) return;
				window.open(url, "_blank", "noopener,noreferrer");
			} catch {}
		});
	}

	return {
		id: botId,
		getState: () => ({ ...state }),
		setState: (next) => {
			state = _coerceState(next || {});
			_updateLabelCache();
			_persist();
			updateUI();
		},
		mount,
		start,
		stop,
		log,
		isRunning: () => !!state.enabled,
		tabTitle: () => (state.mint ? _shortMint(state.mint) : "Hold"),
	};

	function _updateLabelCache() {
		_emitLabelChanged();
	}
}

// Legacy CLI hooks kept for compatibility (no localStorage in node-like runs).
let _cliState = { ...DEFAULTS };
async function __fdvCli_startHold(cfg = {}) {
	if (!_isNodeLike()) return 1;
	_cliState = { ..._cliState, ...cfg, enabled: true };
	return 0;
}

async function __fdvCli_stopHold() {
	if (!_isNodeLike()) return 1;
	_cliState.enabled = false;
	return 0;
}

export const __fdvCli_start = __fdvCli_startHold;
export const __fdvCli_stop = __fdvCli_stopHold;

export function initHoldWidget(container = document.body) {
	const wrap = container;
	while (wrap.firstChild) wrap.removeChild(wrap.firstChild);

	const tabsState = loadHoldTabsState();
	const outer = document.createElement("div");
	outer.className = "fdv-follow-wrap";
	outer.innerHTML = `
		<div class="fdv-tabs" data-hold-tabs style="display:flex; gap:8px; margin:8px 0; overflow: auto;">
			<!-- hold bot tabs inserted here -->
			<button class="fdv-tab-btn" data-hold-add title="Add hold bot">+</button>
		</div>
		<div data-hold-panels></div>
	`;
	wrap.appendChild(outer);

	const tabsEl = outer.querySelector("[data-hold-tabs]");
	const panelsEl = outer.querySelector("[data-hold-panels]");
	if (!tabsEl || !panelsEl) return;
	const addBtn = outer.querySelector("[data-hold-add]");

	const bots = new Map();
	const tabBtns = new Map();
	const tabPanels = new Map();
	let activeId = String(tabsState.activeId || "").trim();
	let seq = 0;
	const deleted = new Set();

	const persistAll = () => {
		try {
			const botsArr = Array.from(bots.values()).map((b) => ({ id: b.id, state: b.getState() }));
			saveHoldTabsState({ activeId, bots: botsArr });
		} catch {}
	};

	const refreshAddBtn = () => {
		try {
			if (!addBtn) return;
			const atMax = bots.size >= HOLD_MAX_TABS;
			addBtn.disabled = atMax;
			addBtn.title = atMax ? `Max ${HOLD_MAX_TABS} hold tabs` : "Add hold bot";
		} catch {}
	};

	const recomputeRunningLed = () => {
		try {
			const anyRunning = Array.from(bots.values()).some((b) => b.isRunning());
			setBotRunning("hold", anyRunning);
		} catch {}
	};

	const updateTabLabel = (botId) => {
		try {
			const b = bots.get(botId);
			const btn = tabBtns.get(botId);
			if (!b || !btn) return;
			const labelEl = btn.querySelector?.('[data-hold-tab-label]') || null;
			if (labelEl) labelEl.textContent = b.tabTitle();
			else btn.textContent = b.tabTitle();
		} catch {}
	};

	const removeBot = async (botId) => {
		const id = String(botId || "").trim();
		const bot = bots.get(id);
		if (!id || !bot) return;

		let proceed = true;
		try {
			if (bot.isRunning()) {
				proceed = confirm("Delete this hold bot? It will stop and attempt to liquidate the position.");
			} else {
				proceed = confirm("Delete this hold bot?");
			}
		} catch {
			proceed = true;
		}
		if (!proceed) return;

		deleted.add(id);
		try {
			if (bot.isRunning()) await bot.stop({ liquidate: true });
		} catch {}

		try { tabBtns.get(id)?.remove(); } catch {}
		try { tabPanels.get(id)?.remove(); } catch {}
		bots.delete(id);
		tabBtns.delete(id);
		tabPanels.delete(id);

		if (activeId === id) {
			activeId = bots.size ? Array.from(bots.keys())[0] : "";
		}

		if (!bots.size) {
			// Keep at least one tab present.
			const nid = addBot({ state: DEFAULTS });
			activeId = nid;
		}

		setActive(activeId);
		recomputeRunningLed();
		persistAll();
		refreshAddBtn();
	};

	const setActive = (botId) => {
		const id = String(botId || "").trim();
		if (!id || !bots.has(id)) return;
		activeId = id;
		for (const [bid, btn] of tabBtns.entries()) {
			if (!btn) continue;
			btn.classList.toggle("active", bid === activeId);
		}
		for (const [bid, panel] of tabPanels.entries()) {
			if (!panel) continue;
			const isActive = bid === activeId;
			panel.style.display = isActive ? "block" : "none";
		}
		persistAll();
	};

	const addBot = ({ state } = {}) => {
		if (bots.size >= HOLD_MAX_TABS) {
			try { alert(`Max ${HOLD_MAX_TABS} hold tabs.`); } catch {}
			return null;
		}
		const id = _newBotId();
		seq++;
		deleted.delete(id);

		const btn = document.createElement("button");
		btn.className = "fdv-tab-btn";
		btn.dataset.holdTab = id;
		btn.style.position = "relative";
		btn.style.paddingRight = "26px";
		btn.innerHTML = `
			<span data-hold-tab-label></span>
			<span data-hold-tab-del title="Delete" aria-label="Delete hold bot" style="position:absolute; top:4px; right:6px; opacity:.7; line-height:1; font-size:14px;">×</span>
		`;
		const labelEl = btn.querySelector('[data-hold-tab-label]');
		if (labelEl) labelEl.textContent = state?.mint ? _shortMint(state.mint) : `Hold ${seq}`;
		btn.addEventListener("click", (e) => {
			try {
				const hitDel = e?.target?.closest?.('[data-hold-tab-del]');
				if (hitDel) {
					e?.preventDefault?.();
					e?.stopPropagation?.();
					void removeBot(id);
					return;
				}
			} catch {}
			setActive(id);
		});

		const plusBtn = tabsEl.querySelector("[data-hold-add]");
		if (plusBtn) tabsEl.insertBefore(btn, plusBtn);
		else tabsEl.appendChild(btn);

		const panel = document.createElement("div");
		panel.dataset.holdPanel = id;
		panel.style.display = "none";
		panelsEl.appendChild(panel);

		const bot = createHoldBotInstance({
			id,
			initialState: state || DEFAULTS,
			onPersist: (bid, nextState) => {
				try {
					if (deleted.has(bid)) return;
					const b = bots.get(bid);
					if (!b) return;
					persistAll();
					updateTabLabel(bid);
					if (bid === activeId) setActive(bid);
				} catch {}
			},
			onAnyRunningChanged: () => {
				recomputeRunningLed();
				persistAll();
				updateTabLabel(id);
			},
			onLabelChanged: (bid) => {
				updateTabLabel(bid);
				persistAll();
			},
		});
		bot.mount(panel);

		bots.set(id, bot);
		tabBtns.set(id, btn);
		tabPanels.set(id, panel);
		updateTabLabel(id);
		refreshAddBtn();
		return id;
	};

	// Initialize bots
	for (const entry of (tabsState.bots || []).slice(0, HOLD_MAX_TABS)) {
		const id = String(entry?.id || "").trim();
		const st = _coerceState(entry?.state || entry);
		seq++;
		deleted.delete(id);

		const btn = document.createElement("button");
		btn.className = "fdv-tab-btn";
		btn.dataset.holdTab = id;
		btn.style.position = "relative";
		btn.style.paddingRight = "26px";
		btn.innerHTML = `
			<span data-hold-tab-label></span>
			<span data-hold-tab-del title="Delete" aria-label="Delete hold bot" style="position:absolute; top:4px; right:6px; opacity:.7; line-height:1; font-size:14px;">×</span>
		`;
		const labelEl = btn.querySelector('[data-hold-tab-label]');
		if (labelEl) labelEl.textContent = st.mint ? _shortMint(st.mint) : `Hold ${seq}`;
		btn.addEventListener("click", (e) => {
			try {
				const hitDel = e?.target?.closest?.('[data-hold-tab-del]');
				if (hitDel) {
					e?.preventDefault?.();
					e?.stopPropagation?.();
					void removeBot(id);
					return;
				}
			} catch {}
			setActive(id);
		});

		const plusBtn = tabsEl.querySelector("[data-hold-add]");
		if (plusBtn) tabsEl.insertBefore(btn, plusBtn);
		else tabsEl.appendChild(btn);

		const panel = document.createElement("div");
		panel.dataset.holdPanel = id;
		panel.style.display = "none";
		panelsEl.appendChild(panel);

		const bot = createHoldBotInstance({
			id,
			initialState: st,
			onPersist: () => {
				if (deleted.has(id)) return;
				persistAll();
				updateTabLabel(id);
			},
			onAnyRunningChanged: () => {
				recomputeRunningLed();
				persistAll();
				updateTabLabel(id);
			},
			onLabelChanged: () => {
				updateTabLabel(id);
				persistAll();
			},
		});
		bot.mount(panel);

		bots.set(id, bot);
		tabBtns.set(id, btn);
		tabPanels.set(id, panel);
		updateTabLabel(id);
	}

	if (!bots.size) {
		activeId = addBot({ state: DEFAULTS }) || "";
	} else if (!bots.has(activeId)) {
		activeId = Array.from(bots.keys())[0];
	}

	// Wire + button
	addBtn?.addEventListener("click", () => {
		const id = addBot({ state: DEFAULTS });
		if (!id) return;
		setActive(id);
		persistAll();
		refreshAddBtn();
	});

	setActive(activeId);
	recomputeRunningLed();
	persistAll();
	refreshAddBtn();

	// Resume bots that were enabled.
	for (const b of bots.values()) {
		try {
			if (b.isRunning()) {
				b.log("Hold was enabled from last session; resuming.", "help", true);
				void b.start({ resume: true });
			}
		} catch {}
	}

	function openForMint({ mint, config, tokenHydrate, start, logLoaded, createNew } = {}) {
		const m = String(mint || tokenHydrate?.mint || "").trim();
		if (!m) return null;

		// Card Hold button behavior: always open a fresh instance.
		if (createNew) {
			try {
				if (bots.size >= HOLD_MAX_TABS) {
					const activeBot = bots.get(activeId) || Array.from(bots.values())[0] || null;
					try {
						activeBot?.log(
							`Hold: no instances available (max ${HOLD_MAX_TABS}). Stop/delete a tab to open ${_shortMint(m)}.`,
							"warn",
							true,
						);
					} catch {}
					return null;
				}
			} catch {}

			const next = {
				...DEFAULTS,
				...(typeof config === "object" && config ? config : {}),
				mint: m,
				enabled: false,
			};

			const createdId = addBot({ state: next });
			if (!createdId) {
				const activeBot = bots.get(activeId) || Array.from(bots.values())[0] || null;
				try {
					activeBot?.log(
						`Hold: no instances available (max ${HOLD_MAX_TABS}). Stop/delete a tab to open ${_shortMint(m)}.`,
						"warn",
						true,
					);
				} catch {}
				return null;
			}

			const target = bots.get(createdId) || null;
			try {
				setActive(createdId);
				persistAll();
				refreshAddBtn();
				recomputeRunningLed();
			} catch {}

			try {
				if (logLoaded) target?.log(`Mint loaded: ${_shortMint(m)}`, "help", true);
			} catch {}

			if (start && target && !target.isRunning()) {
				try { void target.start({ resume: false }); } catch {}
			}
			return createdId;
		}

		// Prefer an existing tab already targeting this mint.
		let target = null;
		try {
			for (const b of bots.values()) {
				try {
					const st = b.getState();
					if (String(st?.mint || "").trim() === m) {
						target = b;
						break;
					}
				} catch {}
			}
		} catch {}

		// If we already have a tab for this mint, just activate it (and optionally apply config).
		if (target) {
			try {
				if (config && typeof config === "object") {
					const cur = target.getState();
					target.setState({ ...cur, ...config, mint: m });
				}
			} catch {}

			try {
				setActive(target.id);
				persistAll();
				refreshAddBtn();
				recomputeRunningLed();
			} catch {}

			try {
				if (logLoaded) target.log(`Mint loaded: ${_shortMint(m)}`, "help", true);
			} catch {}

			if (start && !target.isRunning()) {
				try { void target.start({ resume: false }); } catch {}
			}
			return target.id;
		}

		// No exact match: prefer reusing an idle tab.
		try {
			for (const b of bots.values()) {
				if (!b.isRunning()) {
					target = b;
					break;
				}
			}
		} catch {}

		// Otherwise create a new tab if possible.
		if (!target) {
			if (bots.size >= HOLD_MAX_TABS) {
				try { alert(`Hold: max ${HOLD_MAX_TABS} tabs. Stop/delete a tab to open a new mint.`); } catch {}
				return null;
			}
			const createdId = addBot({ state: DEFAULTS });
			if (createdId) target = bots.get(createdId) || null;
		}

		if (!target) {
			try { alert(`Hold: no available tab (max ${HOLD_MAX_TABS}). Stop/delete a tab and try again.`); } catch {}
			return null;
		}

		// Safety: never overwrite a running bot with a different mint.
		if (target.isRunning()) {
			try { alert("Hold: stop this tab before reusing it for a new mint."); } catch {}
			return null;
		}

		const next = {
			...DEFAULTS,
			...(typeof config === "object" && config ? config : {}),
			mint: m,
			enabled: false,
		};

		try {
			target.setState(next);
		} catch {}

		try {
			setActive(target.id);
			persistAll();
			refreshAddBtn();
			recomputeRunningLed();
		} catch {}

		try {
			if (logLoaded) target.log(`Mint loaded: ${_shortMint(m)}`, "help", true);
		} catch {}

		if (start) {
			try { void target.start({ resume: false }); } catch {}
		}

		return target.id;
	}

	// Expose minimal integration API.
	const api = { openForMint };
	try { window.__fdvHoldOpenForMint = (mintArg, opts) => openForMint({ mint: mintArg, ...(opts || {}) }); } catch {}
	try { window._fdvHoldWidgetApi = api; } catch {}
	return api;
}