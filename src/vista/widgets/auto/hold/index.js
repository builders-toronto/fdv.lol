import { setBotRunning } from "../lib/autoLed.js";
import { createSolanaDepsLoader } from "../lib/solana/deps.js";
import { createConnectionGetter } from "../lib/solana/connection.js";
import { clamp, safeNum } from "../lib/util.js";
import { FEE_RESERVE_MIN, FEE_RESERVE_PCT, SOL_MINT } from "../lib/constants.js";
import { dex, getAutoTraderState } from "../trader/index.js";

const HOLD_LS_KEY = "fdv_hold_bot_v1";

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

let logEl;
let statusEl;
let startBtn;
let stopBtn;
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
let _pendingEntry = null; // { mint, sig, at, until, ownerStr, addCostSol, lastReconAt, lastCreditProbeAt }
let _cycle = null; // { mint, ownerStr, costSol, sizeUi, decimals, enteredAt, lastSeenAt }

let state = { ...DEFAULTS };

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

const _traceLast = new Map();
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

function loadState() {
	try {
		if (typeof localStorage === "undefined") return;
		const raw = localStorage.getItem(HOLD_LS_KEY);
		if (!raw) return;
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return;
		state = {
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
	} catch {}
}

function saveState() {
	try {
		if (typeof localStorage === "undefined") return;
		localStorage.setItem(HOLD_LS_KEY, JSON.stringify(state));
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

async function _shouldBuyOnUptick(mint) {
	const cur = await _probeOutRaw(mint);
	if (cur === null) return { ok: false, reason: "NO_QUOTE" };
	const prev = _lastProbe;
	_lastProbe = { outRawBig: cur, at: now() };
	if (!prev || prev.outRawBig === null) return { ok: false, reason: "NEED_BASELINE" };
	if (!(prev.outRawBig > 0n)) return { ok: false, reason: "BAD_BASELINE" };

	const drop = Number((prev.outRawBig - cur) * 10000n / prev.outRawBig) / 100;
	return { ok: drop >= UPTICK_MIN_DROP_PCT, dropPct: drop, prevOutRaw: prev.outRawBig, curOutRaw: cur };
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

function updateUI() {
	try {
		if (mintEl) mintEl.value = String(state.mint || "");
		if (pollEl) pollEl.value = String(state.pollMs || DEFAULTS.pollMs);
		if (buyPctEl) buyPctEl.value = String(state.buyPct || DEFAULTS.buyPct);
		if (profitEl) profitEl.value = String(state.profitPct || DEFAULTS.profitPct);
		if (repeatEl) repeatEl.checked = !!state.repeatBuy;
		if (uptickEl) uptickEl.checked = !!state.uptickEnabled;
		// if (statusEl) {
		// 	statusEl.textContent = state.enabled ? "Running" : "Stopped";
		// }
		if (startBtn) startBtn.disabled = !!state.enabled;
		if (stopBtn) stopBtn.disabled = !state.enabled;
	} catch {}
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

		// Direct credit probe (fast path). We treat an on-chain credit as the
		// source of truth for entering a hold cycle.
		const lastProbe = Number(p.lastCreditProbeAt || 0);
		if (t - lastProbe >= 5500) {
			p.lastCreditProbeAt = t;
			const got = await dex.waitForTokenCredit(ownerStr, mint, { timeoutMs: 1800, pollMs: 250 });
			if (Number(got?.sizeUi || 0) > 0) {
				_setCycleFromCredit({ mint, ownerStr, costSol: Number(p.addCostSol || 0), sizeUi: got.sizeUi, decimals: got.decimals });
				_upsertAutoPosFromCredit({ mint, sizeUi: got.sizeUi, decimals: got.decimals, addCostSol: Number(p.addCostSol || 0) });
			}
		}
	} catch {}
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

		const pos = _getPosForMint(mint);
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
						`hold:awaitCredit:${mint}`,
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
				const up = await _shouldBuyOnUptick(mint);
				if (!up?.ok) {
					const drop = Number(up?.dropPct || 0);
					const reason = String(up?.reason || "");
					traceOnce(
						`hold:waitUptick:${mint}`,
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
				{ retries: 2, confirmMs: 32000 },
			);
			const ownerStr = (() => {
				try { return kp.publicKey.toBase58(); } catch { return ""; }
			})();
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
						`hold:pendingEntry:${mint}`,
						`Buy placed for ${_shortMint(mint)}; waiting up to ${Math.ceil(graceMs / 1000)}s for position sync…`,
						3000,
						"help",
					);
				}
			} catch {}
			if (res?.ok) {
				log(`Buy sent/confirmed (${res.sig || "no-sig"}).`, "ok");
			} else {
				log(`Buy not confirmed (${res?.sig || "no-sig"}); will keep watching.`, "warn");
			}

			try {
				if (ownerStr) {
					traceOnce(
						`hold:creditWait:${mint}`,
						`Checking token credit for ${_shortMint(mint)} (up to ~8s)…`,
						2500,
						"help",
					);
					const got = await dex.waitForTokenCredit(ownerStr, mint, { timeoutMs: 8000, pollMs: 300 });
					if (Number(got?.sizeUi || 0) > 0) {
						_setCycleFromCredit({ mint, ownerStr, costSol: buySol, sizeUi: got.sizeUi, decimals: got.decimals });
						_upsertAutoPosFromCredit({ mint, sizeUi: got.sizeUi, decimals: got.decimals, addCostSol: buySol });
						log(
							`Buy credited for ${_shortMint(mint)}: size≈${Number(got.sizeUi).toFixed(6)} (dec=${Number(got.decimals || 0) || 6}).`,
							"ok",
						);
						_pendingEntry = null;
					} else {
						traceOnce(
							`hold:creditMiss:${mint}`,
							`No on-chain credit detected yet for ${_shortMint(mint)}; will keep reconciling in background.`,
							4000,
							"warn",
						);
					}
				}
			} catch (e) {
				traceOnce(
					`hold:creditErr:${mint}`,
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
			? await _estimateExitSolForPosition(mint, pos)
			: await _estimateExitSolFromUiAmount(mint, Number(active.sizeUi || 0), Number(active.decimals || 6));
		if (!(estOut > 0)) {
			log(`Holding ${_shortMint(mint)}… (quote unavailable)`, "help");
			return;
		}
		const pnlPct = ((estOut - cost) / cost) * 100;
		if (Number.isFinite(pnlPct)) {
			traceOnce(
				`hold:pnl:${mint}`,
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
		const res = await dex.sellWithConfirm(
			{ signer: kp, mint, amountUi: 0, slippageBps: slip },
			{ retries: 1, confirmMs: 30_000 },
		);
		if (res?.ok) {
			log(`Sell confirmed (${res.sig || "no-sig"}).`, "ok");
			_lastProbe = null;
			_pendingEntry = null;
			_clearCycle();
			if (!state.repeatBuy) {
				await stopHold({ liquidate: false });
				return;
			}
			log("Repeat enabled; waiting for next entry.", "help");
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

async function startHold() {
	if (state.enabled) return;
	state.mint = String(mintEl?.value || state.mint || "").trim();
	state.pollMs = clamp(safeNum(pollEl?.value, state.pollMs), 250, 60_000);
	state.buyPct = clamp(safeNum(buyPctEl?.value, state.buyPct), 10, 70);
	state.profitPct = clamp(safeNum(profitEl?.value, state.profitPct), 0.1, 500);
	state.repeatBuy = !!repeatEl?.checked;
	state.uptickEnabled = !!uptickEl?.checked;
	state.enabled = true;
	_acceptLogs = true;
	_lastProbe = null;
	saveState();
	try { setBotRunning("hold", true); } catch {}
	updateUI();
	log(
		`Hold started. mint=${state.mint ? state.mint.slice(0, 6) + "…" : ""} poll=${state.pollMs}ms buyPct=${Number(state.buyPct || DEFAULTS.buyPct).toFixed(0)}% profit=${Number(state.profitPct || DEFAULTS.profitPct).toFixed(2)}% uptick=${state.uptickEnabled ? "on" : "off"} repeat=${state.repeatBuy ? "on" : "off"}`,
		"ok",
		true,
	);
	startLoop();
	await tickOnce(_runNonce);
}

async function stopHold({ liquidate = true } = {}) {
	const mint = String((_cycle?.mint || state.mint || "")).trim();

	if (!state.enabled) {
		try { setBotRunning("hold", false); } catch {}
		updateUI();
		return;
	}

	// Stop the loop immediately.
	state.enabled = false;
	_runNonce++;
	saveState();
	try { if (_timer) clearInterval(_timer); } catch {}
	_timer = null;
	try { setBotRunning("hold", false); } catch {}
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
					const got = await dex.waitForTokenCredit(p.ownerStr, mint, { timeoutMs: 2500, pollMs: 250 });
					if (Number(got?.sizeUi || 0) > 0) {
						_setCycleFromCredit({ mint, ownerStr: p.ownerStr, costSol: Number(p.addCostSol || 0), sizeUi: got.sizeUi, decimals: got.decimals });
						_upsertAutoPosFromCredit({ mint, sizeUi: got.sizeUi, decimals: got.decimals, addCostSol: Number(p.addCostSol || 0) });
						log(`Stop-liquidation: position credited size≈${Number(got.sizeUi).toFixed(6)}; proceeding to sell.`, "help", true);
					}
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
					_pendingEntry = null;
					_clearCycle();
				} else if (res?.noBalance) {
					log(`Stop-liquidation: no on-chain balance to sell for ${_shortMint(mint)}.`, "warn", true);
					// If we were waiting on a credit, don't discard that state.
					if (!_pendingEntry) {
						_lastProbe = null;
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

async function __fdvCli_startHold(cfg = {}) {
	if (!_isNodeLike()) return 1;
	state = { ...state, ...cfg, enabled: true };
	saveState();
	return 0;
}

async function __fdvCli_stopHold() {
	if (!_isNodeLike()) return 1;
	state.enabled = false;
	saveState();
	return 0;
}

export const __fdvCli_start = __fdvCli_startHold;
export const __fdvCli_stop = __fdvCli_stopHold;

export function initHoldWidget(container = document.body) {
	loadState();

	const wrap = container;
	while (wrap.firstChild) wrap.removeChild(wrap.firstChild);

	const outer = document.createElement("div");
	outer.className = "fdv-follow-wrap";
	outer.innerHTML = `
		<div class="fdv-tab-content active" data-tab-content="hold">
			<div class="fdv-grid">
				<label>Target Mint <input id="hold-mint" type="text" placeholder="Mint address"></label>
				<label>Poll (ms) <input id="hold-poll" type="number" min="250" max="60000" step="50"></label>
				<label>Buy % (10-70%) <input id="hold-buy-pct" type="number" min="10" max="70" step="1"></label>
				<label>Profit % to sell <input id="hold-profit" type="number" min="0.1" max="500" step="0.1"></label>
			</div>

			<div class="fdv-log" id="hold-log"></div>
			<div class="fdv-actions" style="margin-top:6px;">
				<div class="fdv-actions-left" style="display:flex; flex-direction:row; gap:4px;">
					<label style="display:flex;flex-direction:row;align-items:center;gap:4px;">Repeat<input id="hold-repeat" type="checkbox"></label>
					<label style="display:flex;flex-direction:row;align-items:center;gap:4px;">Uptick<input id="hold-uptick" type="checkbox"></label>
					
				</div>
				<div class="fdv-actions-right">
					<button id="fdv-hold-start">Start</button>
					<button id="fdv-hold-stop">Stop</button>
				</div>
			</div>
		</div>
	`;

	wrap.appendChild(outer);

	mintEl = document.getElementById("hold-mint");
	pollEl = document.getElementById("hold-poll");
	buyPctEl = document.getElementById("hold-buy-pct");
	profitEl = document.getElementById("hold-profit");
	repeatEl = document.getElementById("hold-repeat");
	uptickEl = document.getElementById("hold-uptick");
	logEl = document.getElementById("hold-log");
	startBtn = document.getElementById("fdv-hold-start");
	stopBtn = document.getElementById("fdv-hold-stop");
	statusEl = document.getElementById("hold-status");

	if (mintEl) mintEl.value = String(state.mint || "");
	if (pollEl) pollEl.value = String(state.pollMs || DEFAULTS.pollMs);
	if (buyPctEl) buyPctEl.value = String(state.buyPct || DEFAULTS.buyPct);
	if (profitEl) profitEl.value = String(state.profitPct || DEFAULTS.profitPct);
	if (repeatEl) repeatEl.checked = !!state.repeatBuy;
	if (uptickEl) uptickEl.checked = !!state.uptickEnabled;

	const onChange = () => {
		state.mint = String(mintEl?.value || "").trim();
		state.pollMs = clamp(safeNum(pollEl?.value, DEFAULTS.pollMs), 250, 60_000);
		state.buyPct = clamp(safeNum(buyPctEl?.value, DEFAULTS.buyPct), 10, 70);
		state.profitPct = clamp(safeNum(profitEl?.value, DEFAULTS.profitPct), 0.1, 500);
		state.repeatBuy = !!repeatEl?.checked;
		state.uptickEnabled = !!uptickEl?.checked;
		saveState();
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
		await startHold();
	});
	stopBtn?.addEventListener("click", async () => {
		await stopHold();
	});

	updateUI();
	if (state.enabled) {
		log("Hold was enabled from last session; resuming.", "help");
		void startHold();
	}
}