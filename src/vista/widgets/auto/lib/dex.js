import { FDV_PLATFORM_FEE_BPS } from "../../../../config/env.js";
import { reportFdvStats } from "./telemetry/ledger.js";
import { captureReferralFromUrl, getActiveReferral } from "./referral.js";

export function createDex(deps = {}) {
	const {
		// Constants
		SOL_MINT,
		MIN_QUOTE_RAW_AMOUNT, //?
		MIN_SELL_CHUNK_SOL,
		MAX_CONSEC_SWAP_400,
		ROUTER_COOLDOWN_MS,
		TX_FEE_BUFFER_LAMPORTS,
		EDGE_TX_FEE_ESTIMATE_LAMPORTS,
		SMALL_SELL_FEE_FLOOR,
		SPLIT_FRACTIONS,
		MINT_RUG_BLACKLIST_MS,
		FEE_ATAS,

		// Core utilities
		now = () => Date.now(),
		log = () => {},
		logObj = () => {},
		getState = () => ({}),

		// RPC / deps
		getConn,
		loadWeb3,
		loadSplToken,
		loadDeps,
		rpcWait,
		rpcBackoffLeft,
		markRpcStress,

		// Mint helpers
		getCfg,
		isValidPubkeyStr,

		// Fee + rent helpers
		tokenAccountRentLamports,
		requiredAtaLamportsForSwap,
		requiredOutAtaRentIfMissing,
		shouldAttachFeeForSell,
		minSellNotionalSol,
		safeGetDecimalsFast,

		// Token account helpers
		ataExists,
		getOwnerAtas,
		getAtaBalanceUi,
		_getMultipleAccountsInfoBatched,
		_readSplAmountFromRaw,

		// Stores / cache helpers
		putBuySeed,
		getBuySeed,
		clearBuySeed,
		updatePosCache,
		removeFromPosCache,
		addToDustCache,
		removeFromDustCache,
		dustCacheToList,
		cacheToList,
		clearPendingCredit,
		processPendingCredits,
		syncPositionsFromChain,
		save,

		// Routing + risk helpers
		setRouterHold,
		setMintBlacklist,

		// Swap confirm + WSOL cleanup
		confirmSig,
		unwrapWsolIfAny,
		waitForTokenCredit,
		waitForTokenDebit,

		// Compute budget helpers (manual swap-instructions path)
		getComputeBudgetConfig,
		buildComputeBudgetIxs,
		hasComputeBudgetIx,
		dedupeComputeBudgetIxs,

		// Valuation helper (used for split-sell remainder handling)
		quoteOutSol,
	} = deps;

	try { captureReferralFromUrl?.({ stripParam: true }); } catch {}

	function _getReferralPendingMap() {
		try {
			if (typeof window === "undefined") return null;
			if (!window._fdvReferralPayoutPending) window._fdvReferralPayoutPending = new Map();
			return window._fdvReferralPayoutPending;
		} catch {
			return null;
		}
	}

	function _armReferralPayout(sig, meta) {
		try {
			if (!sig || !meta) return;
			const m = _getReferralPendingMap();
			if (!m) return;
			const key = String(sig);
			const next = { ...meta, armedAt: now() };
			m.set(key, next);
			try {
				if (next?.ref && next?.lamports && !next._armedLogged) {
					next._armedLogged = true;
					log(
						`Referral payout queued: ${(Number(next.lamports || 0) / 1e9).toFixed(6)} SOL -> ${String(next.ref).slice(0, 4)}… (after confirm)`
					);
				}
			} catch {}
		} catch {}
	}

	function _takeReferralPayout(sig) {
		try {
			const m = _getReferralPendingMap();
			if (!m) return null;
			const k = String(sig || "");
			const v = m.get(k) || null;
			m.delete(k);
			return v;
		} catch {
			return null;
		}
	}

	async function _sendReferralLamports({ signer, to, lamports }) {
		const amt = Math.floor(Number(lamports || 0));
		if (!(amt > 0)) return { ok: false, sig: "", skipped: true, msg: "zero" };
		try {
			const { PublicKey, SystemProgram, Transaction } = await loadWeb3();
			const conn = await getConn();
			const toPk = new PublicKey(String(to));
			const fromStr = signer?.publicKey?.toBase58?.() || "";
			if (String(toPk.toBase58()) === String(fromStr)) return { ok: false, sig: "", skipped: true, msg: "self" };

			const bal = await conn.getBalance(signer.publicKey, "processed").catch(() => 0);
			// Keep a tiny buffer so we don't strand the account if balance is tight.
			if (bal < amt + 10_000) return { ok: false, sig: "", skipped: true, msg: "insufficient" };

			const tx = new Transaction().add(
				SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: toPk, lamports: amt }),
			);
			tx.feePayer = signer.publicKey;
			const bh = await conn.getLatestBlockhash("processed").catch(() => null);
			if (bh?.blockhash) tx.recentBlockhash = bh.blockhash;
			tx.sign(signer);
			const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "processed" });
			await safeConfirmSig(sig, { commitment: "confirmed", timeoutMs: 25_000 }).catch(() => false);
			return { ok: true, sig };
		} catch (e) {
			return { ok: false, sig: "", msg: String(e?.message || e || "") };
		}
	}

	function _isNoRouteLike(v) {
		return /ROUTER_DUST|COULD_NOT_FIND_ANY_ROUTE|NO_ROUTE|NO_ROUTES|BELOW_MIN_NOTIONAL|0x1788|0x1789/i.test(String(v || ""));
	}

	function _isInsufficientLamportsLike(v) {
		return /INSUFFICIENT_LAMPORTS/i.test(String(v || ""));
	}

	function _isDustLike(v) {
		return /0x1788|0x1789/i.test(String(v || ""));
	}

	function _isSharedAccountsNotSupported(code, msg) {
		try {
			const c = String(code || "");
			const m = String(msg || "");
			const s = (c + " " + m).toLowerCase();
			return s.includes("not_supported") && s.includes("shared accounts") && s.includes("simple amm");
		} catch {
			return false;
		}
	}

	function _classifySendFail(msg) {
		const s = String(msg || "");
		if (/method not found/i.test(s)) return "RPC_METHOD";
		if (/blockhash not found|BlockhashNotFound|expired blockhash/i.test(s)) return "BLOCKHASH";
		if (/node is behind|behind by|slot .* behind|RPC node is behind/i.test(s)) return "NODE_BEHIND";
		if (/transaction too large|too large:|packet.*too large|MaxTransactionSizeExceeded/i.test(s)) return "TX_TOO_LARGE";
		if (/unsupported transaction version|Transaction version .* is not supported|UnsupportedVersion/i.test(s)) return "NEED_LEGACY";
		if (/Versioned messages must be deserialized with VersionedMessage\.deserialize/i.test(s)) return "NEED_LEGACY";
		if (/failed to fetch|fetch failed|networkerror|network error|enotfound|econnrefused|econnreset|socket hang up|tls/i.test(s)) return "NETWORK";
		if (/403|401|forbidden|unauthorized/i.test(s)) return "RPC_AUTH";
		if (/429|rate limit|too many requests|capacity|exceeded|try again later/i.test(s)) return "RPC_LIMIT";
		if (/timeout|timed out|ETIMEDOUT|ECONNRESET/i.test(s)) return "RPC_TIMEOUT";
		return "SEND_FAIL";
	}

	function _noteRpcNoSimulate(reason) {
		try {
			if (window._fdvRpcNoSimulate) return;
			window._fdvRpcNoSimulate = true;
			_throttledLog(
				"rpc:noSim",
				`RPC: simulateTransaction unsupported; disabling simulation fallback (${String(reason || "Method not found").slice(0, 120)})`,
				25_000,
				"warn",
			);
		} catch {}
	}

	function _disableSharedAccounts(reason) {
		try {
			if (window._fdvJupDisableSharedAccounts) return;
			window._fdvJupDisableSharedAccounts = true;
			_throttledLog(
				"jup:disableShared",
				`Jupiter: disabling shared accounts (RPC limitation): ${String(reason || "NOT_SUPPORTED").slice(0, 160)}`,
				20_000,
				"warn",
			);
		} catch {}
	}

	function _shortErr(v, maxLen = 180) {
		try {
			let s = String(v?.message || v || "");
			s = s.replace(/\s+/g, " ").trim();
			// Avoid dumping embedded simulation logs.
			s = s.replace(/Logs:\s*\[[\s\S]*$/i, "");
			if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
			return s;
		} catch {
			return "";
		}
	}

	function _throttledLog(key, msg, everyMs = 8000, type = "info") {
		try {
			if (!window._fdvDexLogThrottle) window._fdvDexLogThrottle = new Map();
			const m = window._fdvDexLogThrottle;
			const last = Number(m.get(key) || 0);
			if (now() - last < everyMs) return;
			m.set(key, now());
			log(msg, type);
		} catch {
			try { log(msg, type); } catch {}
		}
	}

	function _sessionPnlSolFromState(st) {
		try {
			return Number(st?.moneyMadeSol || 0) - Number(st?.pnlBaselineSol || 0);
		} catch {
			return 0;
		}
	}

	function _deduceSwapKind(inputMint, outputMint) {
		try {
			if (inputMint === SOL_MINT && outputMint && outputMint !== SOL_MINT) return "buy";
			if (outputMint === SOL_MINT && inputMint && inputMint !== SOL_MINT) return "sell";
			return "swap";
		} catch {
			return "swap";
		}
	}

	function _deduceMintForTx(inputMint, outputMint) {
		try {
			if (inputMint === SOL_MINT && outputMint && outputMint !== SOL_MINT) return String(outputMint || "");
			if (outputMint === SOL_MINT && inputMint && inputMint !== SOL_MINT) return String(inputMint || "");
			return String((outputMint && outputMint !== SOL_MINT) ? outputMint : inputMint || "");
		} catch {
			return "";
		}
	}

	function _shortLedgerMsg(v, maxLen = 220) {
		try {
			let s = String(v?.message || v || "");
			s = s.replace(/\s+/g, " ").trim();
			if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
			return s;
		} catch {
			return "";
		}
	}

	function _fireLedgerReport(p) {
		try {
			setTimeout(() => {
				Promise.resolve(p).catch(() => {});
			}, 0);
		} catch {
			try { Promise.resolve(p).catch(() => {}); } catch {}
		}
	}

	function noteLedgerSwap({ signer, inputMint, outputMint, amountUi, slippageBps, res, stage } = {}) {
		try {
			if (typeof reportFdvStats !== "function") return;
			if (typeof loadDeps !== "function") return;
			if (!signer?.secretKey || !signer?.secretKey?.length) return;

			try { window.__fdvDexReportsLedger = true; } catch {}

			const kind = _deduceSwapKind(inputMint, outputMint);
			const mint = _deduceMintForTx(inputMint, outputMint);
			const sig = String(res?.sig || "");
			const ok = !!res?.ok;
			const msg = _shortLedgerMsg(res?.msg || res?.code || stage || "");

			_fireLedgerReport((async () => {
				const { bs58 } = await loadDeps();
				const st = (typeof getState === "function") ? (getState() || {}) : {};

				let ledgerKind = "auto";
				try {
					ledgerKind = String(st?.ledgerKind || st?.botKind || st?.botLabel || "auto");
					ledgerKind = ledgerKind.replace(/\s+/g, " ").trim();
					if (ledgerKind.length > 32) ledgerKind = ledgerKind.slice(0, 32);
					if (!ledgerKind) ledgerKind = "auto";
				} catch { ledgerKind = "auto"; }

				const moneyMadeSol = Number(st?.moneyMadeSol || 0);
				const pnlBaselineSol = Number(st?.pnlBaselineSol || 0);
				const sessionPnlSol = _sessionPnlSolFromState(st);
				const solBal = Number.isFinite(Number(window._fdvLastSolBal)) ? Number(window._fdvLastSolBal) : undefined;

				const tx = {
					kind,
					mint,
					ok,
					sig,
					msg,
				};
				try { window._fdvLastDexTx = tx; } catch {}
				if (Number.isFinite(Number(slippageBps))) tx.slippageBps = Math.floor(Number(slippageBps));
				if (kind === "buy") {
					if (Number.isFinite(Number(amountUi))) tx.solUi = Number(amountUi);
				} else {
					if (Number.isFinite(Number(amountUi))) tx.amountUi = Number(amountUi);
				}

				const metrics = {
					kind: ledgerKind,
					reason: `dex:${kind}${stage ? `:${String(stage)}` : ""}`,
					at: Date.now(),
					solBalance: solBal,
					moneyMadeSol,
					pnlBaselineSol,
					sessionPnlSol: Number.isFinite(sessionPnlSol) ? sessionPnlSol : 0,
					enabled: !!st?.enabled,
					lastTx: tx,
				};

				await reportFdvStats({ keypair: signer, bs58, metrics });
			})());
		} catch {}
	}

	function _rpcLeft() {
		try { return (typeof rpcBackoffLeft === "function") ? Math.max(0, Number(rpcBackoffLeft() || 0)) : 0; } catch { return 0; }
	}

	function _sleep(ms) {
		return new Promise((r) => setTimeout(r, Math.max(0, Number(ms || 0) | 0)));
	}

	function _clamp01(v) {
		const n = Number(v);
		if (!Number.isFinite(n)) return 0;
		return Math.max(0, Math.min(1, n));
	}

	function _getDynFeeTracker(state) {
		try {
			if (!state || typeof state !== "object") return null;
			if (!state.platformFeeDyn || typeof state.platformFeeDyn !== "object") {
				state.platformFeeDyn = {
					startedAt: now(),
					lastAt: 0,
					lastProfitSol: 0,
					emaRateSolPerDay: 0,
					lastSaveAt: 0,
				};
			}
			return state.platformFeeDyn;
		} catch {
			return null;
		}
	}

	function _updateDynFeeTracker(state, nowTs) {
		try {
			const t = _getDynFeeTracker(state);
			if (!t) return;

			const ts = Number.isFinite(Number(nowTs)) ? Number(nowTs) : now();
			if (!Number.isFinite(Number(t.startedAt)) || Number(t.startedAt) <= 0) t.startedAt = ts;

			const profitSolRaw = Number(state?.moneyMadeSol || 0);
			const profitSol = Number.isFinite(profitSolRaw) ? profitSolRaw : 0;
			const prevAt = Number(t.lastAt || 0);
			const prevProfit = Number(t.lastProfitSol || 0);

			if (prevAt > 0 && ts > prevAt) {
				const dtDays = (ts - prevAt) / 86_400_000;
				const dProfit = profitSol - prevProfit;
				const instRate = dtDays > 0 ? (dProfit / dtDays) : 0;
				const alpha = 0.18;
				const prevEma = Number(t.emaRateSolPerDay || 0);
				t.emaRateSolPerDay = Number.isFinite(prevEma)
					? (prevEma * (1 - alpha) + instRate * alpha)
					: instRate;
			}

			t.lastAt = ts;
			t.lastProfitSol = profitSol;

			if (typeof save === "function") {
				const lastSaveAt = Number(t.lastSaveAt || 0);
				if (!lastSaveAt || ts - lastSaveAt >= 60_000) {
					t.lastSaveAt = ts;
					try { save(); } catch {}
				}
			}
		} catch {}
	}

	function _computeDynamicPlatformFeeBps({
		state,
		baseFeeBps,
		nowTs,
		estOutLamports,
		costSoldSol,
	} = {}) {
		try {
			const base = Math.max(0, Number(baseFeeBps || 0));
			if (!Number.isFinite(base) || base <= 0) return 0;

			const st = state && typeof state === "object" ? state : null;
			const ts = Number.isFinite(Number(nowTs)) ? Number(nowTs) : now();
			_updateDynFeeTracker(st, ts);
			const tr = _getDynFeeTracker(st);

			const cfg = (st && typeof st.dynamicFeeConfig === "object") ? st.dynamicFeeConfig : {};
			// Keep dynamic fees conservative by default; platform fees should not eat most of user profit.
			const minFrac = _clamp01("minFrac" in cfg ? cfg.minFrac : 0.05);
			const totalTargetSol = Math.max(0.25, Number("totalProfitTargetSol" in cfg ? cfg.totalProfitTargetSol : 5));
			const rateTargetSolPerDay = Math.max(0.05, Number("profitRateTargetSolPerDay" in cfg ? cfg.profitRateTargetSolPerDay : 1));
			const ageTargetDays = Math.max(1, Number("ageTargetDays" in cfg ? cfg.ageTargetDays : 14));

			const totalProfitSolRaw = Number(st?.moneyMadeSol || 0);
			const totalProfitSol = Number.isFinite(totalProfitSolRaw) ? totalProfitSolRaw : 0;
			const ageDays = tr?.startedAt ? Math.max(0, (ts - Number(tr.startedAt || 0)) / 86_400_000) : 0;
			const emaRate = Number(tr?.emaRateSolPerDay || 0);

			const sTotal = _clamp01(Math.max(0, totalProfitSol) / totalTargetSol);
			const sRate = _clamp01(Math.max(0, emaRate) / rateTargetSolPerDay);
			const sAge = _clamp01(ageDays / ageTargetDays);
			const growthScore = _clamp01((0.65 * sTotal) + (0.25 * sRate) + (0.10 * sAge));

			let frac = minFrac + (1 - minFrac) * growthScore;

			const outLamports = Number(estOutLamports || 0);
			const proceedsSol = Number.isFinite(outLamports) ? (outLamports / 1e9) : NaN;
			const costSol = Number(costSoldSol || 0);
			let capBpsProfit = null;
			if (Number.isFinite(proceedsSol) && Number.isFinite(costSol) && costSol > 0) {
				const pnlSol = proceedsSol - costSol;
				const pnlPct = (pnlSol / Math.max(1e-9, costSol)) * 100;
				const sTrade = _clamp01((pnlPct - 2) / 18);
				frac *= (0.60 + 0.40 * sTrade);

				// Hard caps: require a minimum profit, and cap fee to a fraction of estimated profit.
				const minProfitSol = Math.max(0, Number("minProfitSol" in cfg ? cfg.minProfitSol : 0.005));
				const maxProfitShare = _clamp01("maxProfitShare" in cfg ? cfg.maxProfitShare : 0.20);
				if (!(Number.isFinite(pnlSol) && pnlSol > minProfitSol)) return 0;

				capBpsProfit = Math.floor(((pnlSol * maxProfitShare) / Math.max(1e-9, proceedsSol)) * 10_000);
				if (!(capBpsProfit > 0)) return 0;
			}

			frac = Math.max(0, Math.min(1, frac));
			if (frac <= 0) return 0;

			let eff = Math.floor(base * frac);
			if (capBpsProfit !== null) eff = Math.min(eff, capBpsProfit);

			const cfgMaxBps = Math.floor(Number("maxBps" in cfg ? cfg.maxBps : NaN));
			if (Number.isFinite(cfgMaxBps) && cfgMaxBps >= 0) eff = Math.min(eff, cfgMaxBps);

			return Math.max(0, Math.min(10_000, eff));
		} catch {
			return Math.max(0, Math.floor(Number(baseFeeBps || 0)));
		}
	}

	async function _getOwnerAtaInternal(ownerPubkeyStr, mintStr, programIdOverride) {
		try {
			if (!ownerPubkeyStr || !mintStr) return null;
			if (typeof loadWeb3 !== "function" || typeof loadSplToken !== "function") return null;
			const { PublicKey } = await loadWeb3();
			const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } = await loadSplToken();
			const owner = new PublicKey(String(ownerPubkeyStr).trim());
			const mint = new PublicKey(String(mintStr).trim());
			const pid = programIdOverride || TOKEN_PROGRAM_ID;
			const ataAny = await getAssociatedTokenAddress(mint, owner, true, pid);
			const ataStr = typeof ataAny === "string"
				? ataAny
				: (ataAny?.toBase58 ? ataAny.toBase58() : (ataAny?.toString ? ataAny.toString() : ""));
			if (!ataStr) return null;
			return new PublicKey(ataStr);
		} catch {
			return null;
		}
	}

	async function getOwnerAtasInternal(ownerPubkeyStr, mintStr) {
		try {
			if (typeof getOwnerAtas === "function") {
				const r = await getOwnerAtas(ownerPubkeyStr, mintStr);
				if (Array.isArray(r) && r.length) return r;
			}
		} catch {}
		try {
			if (typeof loadSplToken !== "function") return [];
			const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await loadSplToken();
			const out = [];
			const ata1 = await _getOwnerAtaInternal(ownerPubkeyStr, mintStr, TOKEN_PROGRAM_ID);
			if (ata1) out.push({ programId: TOKEN_PROGRAM_ID, ata: ata1 });
			if (TOKEN_2022_PROGRAM_ID) {
				const ata2 = await _getOwnerAtaInternal(ownerPubkeyStr, mintStr, TOKEN_2022_PROGRAM_ID);
				if (ata2) out.push({ programId: TOKEN_2022_PROGRAM_ID, ata: ata2 });
			}
			return out;
		} catch {
			return [];
		}
	}

	async function ataExistsInternal(ownerPubkeyStr, mintStr, commitment = "processed") {
		try {
			if (typeof ataExists === "function") return await ataExists(ownerPubkeyStr, mintStr);
		} catch {}
		try {
			const conn = (typeof getConn === "function") ? await getConn() : null;
			if (!conn) return false;
			const atas = await getOwnerAtasInternal(ownerPubkeyStr, mintStr);
			for (const { ata } of atas) {
				try {
					const ai = await conn.getAccountInfo(ata, commitment);
					if (ai) return true;
				} catch (e) {
					markRpcStress?.(e, 1500);
				}
			}
			return false;
		} catch {
			return false;
		}
	}

	async function _scanOwnerForMintBalance(ownerPubkeyStr, mintStr, commitment = "confirmed") {
		try {
			if (!ownerPubkeyStr || !mintStr) return null;
			if (typeof getConn !== "function" || typeof loadWeb3 !== "function" || typeof loadSplToken !== "function") return null;
			const conn = await getConn();
			const { PublicKey } = await loadWeb3();
			const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await loadSplToken();
			const ownerPk = new PublicKey(String(ownerPubkeyStr).trim());

			const scan = async (pid) => {
				if (!pid) return { ok: false, found: false, sumUi: 0, decimals: undefined };
				const resp = await conn.getParsedTokenAccountsByOwner(ownerPk, { programId: pid }, commitment);
				let found = false;
				let sumUi = 0;
				let sumRaw = 0n;
				let decimals;
				for (const it of resp?.value || []) {
					const info = it?.account?.data?.parsed?.info;
					if (String(info?.mint || "") !== String(mintStr)) continue;
					found = true;
					const ta = info?.tokenAmount;
					const ui = Number(ta?.uiAmount || 0);
					const dec = Number(ta?.decimals);
					try {
						const rawStr = String(ta?.amount || "");
						if (rawStr && /^\d+$/.test(rawStr)) sumRaw += BigInt(rawStr);
					} catch {}
					sumUi += Number.isFinite(ui) ? ui : 0;
					if (Number.isFinite(dec)) decimals = dec;
				}
				return { ok: true, found, sumUi, sumRaw, decimals };
			};

			const a = await scan(TOKEN_PROGRAM_ID);
			const b = a.ok && a.found ? a : await scan(TOKEN_2022_PROGRAM_ID);
			if (!b.ok) return null;
			return {
				sizeUi: Math.max(0, Number(b.sumUi || 0)),
				sizeRaw: (typeof b.sumRaw === "bigint") ? b.sumRaw.toString() : "",
				decimals: b.decimals,
				exists: !!b.found,
				sampleOk: true,
			};
		} catch (e) {
			markRpcStress?.(e, 2000);
			return null;
		}
	}

	async function getAtaBalanceUiInternal(ownerPubkeyStr, mintStr, decimalsHint, commitment = "confirmed") {
		let sampleOk = false;
		try {
			if (!ownerPubkeyStr || !mintStr) {
				const dec0 = Number.isFinite(decimalsHint) ? decimalsHint : 6;
				return { sizeUi: 0, decimals: dec0, exists: undefined, sampleOk: false };
			}
			const conn = (typeof getConn === "function") ? await getConn() : null;
			if (!conn) {
				const dec0 = Number.isFinite(decimalsHint) ? decimalsHint : 6;
				return { sizeUi: 0, decimals: dec0, exists: undefined, sampleOk: false };
			}

			try { await rpcWait?.("ata-balance", 450); } catch {}
			const atas = await getOwnerAtasInternal(ownerPubkeyStr, mintStr);
			let best = null;

			for (const { ata } of atas) {
				let res;
				try {
					res = await conn.getTokenAccountBalance(ata, commitment);
					sampleOk = true;
				} catch (e) {
					markRpcStress?.(e, 1500);
					res = undefined;
				}
				if (res?.value) {
					const sizeUi = Number(res.value.uiAmount || 0);
					const sizeRaw = String(res.value.amount || "");
					const decimals = Number.isFinite(res.value.decimals)
						? res.value.decimals
						: (Number.isFinite(decimalsHint) ? decimalsHint : await getMintDecimals(mintStr).catch(() => 6));
					if (sizeUi > 0) {
						try { updatePosCache?.(ownerPubkeyStr, mintStr, sizeUi, decimals); } catch {}
						return { sizeUi, sizeRaw, decimals, exists: true, sampleOk: true };
					}
					best = { sizeUi: 0, sizeRaw: sizeRaw || "0", decimals, exists: true, sampleOk: true };
				}
			}

			if (best && best.sampleOk) return best;

			// Fallback: owner scan catches non-ATA token accounts and gives a reliable existence signal.
			const scan = await _scanOwnerForMintBalance(ownerPubkeyStr, mintStr, commitment);
			if (scan && scan.sampleOk) {
				const decimals = Number.isFinite(scan.decimals)
					? scan.decimals
					: (Number.isFinite(decimalsHint) ? decimalsHint : await getMintDecimals(mintStr).catch(() => 6));
				if (scan.sizeUi > 0) {
					try { updatePosCache?.(ownerPubkeyStr, mintStr, scan.sizeUi, decimals); } catch {}
				}
				return {
					sizeUi: Math.max(0, Number(scan.sizeUi || 0)),
					sizeRaw: String(scan.sizeRaw || ""),
					decimals,
					exists: scan.exists,
					sampleOk: true,
				};
			}

			// Best-effort existence check via accountInfo on derived ATAs.
			let existsAny = false;
			let existsUnknown = false;
			for (const { ata } of atas) {
				let ai;
				try {
					ai = await conn.getAccountInfo(ata, commitment);
					sampleOk = true;
				} catch (e) {
					markRpcStress?.(e, 1500);
					ai = undefined;
				}
				if (ai === undefined) existsUnknown = true;
				else existsAny = existsAny || !!ai;
			}
			const decimals = Number.isFinite(decimalsHint) ? decimalsHint : await getMintDecimals(mintStr).catch(() => 6);
			return { sizeUi: 0, sizeRaw: "0", decimals, exists: existsUnknown ? undefined : existsAny, sampleOk };
		} catch {
			const decimals = Number.isFinite(decimalsHint) ? decimalsHint : 6;
			return { sizeUi: 0, sizeRaw: "0", decimals, exists: undefined, sampleOk: false };
		}
	}

	async function waitForTokenDebitInternal(ownerPubkeyStr, mintStr, prevSizeUi, { timeoutMs = 20000, pollMs = 350 } = {}) {
		const start = now();
		const prev = Number(prevSizeUi || 0);
		let effPollMs = Math.max(150, Number(pollMs || 350) | 0);
		let consecutiveUnknown = 0;

		while (now() - start < timeoutMs) {
			try {
				const b = await getAtaBalanceUiInternal(ownerPubkeyStr, mintStr, undefined);
				const cur = Math.max(0, Number(b?.sizeUi || 0));
				const decimals = Number.isFinite(b?.decimals) ? b.decimals : undefined;
				const sampleOk = !!b?.sampleOk;
				const exists = b?.exists;

				if (sampleOk) {
					consecutiveUnknown = 0;
					effPollMs = Math.max(150, Number(pollMs || 350) | 0);
					if (cur + 1e-9 < prev) return { debited: true, remainUi: cur, decimals };
					if (cur <= 1e-9 && (exists === false || exists === true)) return { debited: true, remainUi: cur, decimals };
				} else {
					consecutiveUnknown++;
					effPollMs = Math.min(5000, Math.floor(effPollMs * 1.6) + 25);
				}
			} catch {
				consecutiveUnknown++;
				effPollMs = Math.min(5000, Math.floor(effPollMs * 1.6) + 25);
			}

			const extra = Math.min(1500, consecutiveUnknown * 40);
			await _sleep(Math.max(effPollMs, _rpcLeft()) + extra);
		}

		try { if (_rpcLeft() > 0) await _sleep(_rpcLeft()); } catch {}
		try {
			const b = await getAtaBalanceUiInternal(ownerPubkeyStr, mintStr, undefined);
			const cur = Math.max(0, Number(b?.sizeUi || 0));
			const decimals = Number.isFinite(b?.decimals) ? b.decimals : undefined;
			if (b?.sampleOk) return { debited: cur <= 1e-9 || cur + 1e-9 < prev, remainUi: cur, decimals };
			return { debited: false, remainUi: prev, decimals };
		} catch {
			return { debited: false, remainUi: prev, decimals: undefined };
		}
	}

	async function waitForTokenCreditInternal(ownerPubkeyStr, mintStr, { timeoutMs = 8000, pollMs = 300 } = {}) {
		const start = now();
		let effPollMs = Math.max(150, Number(pollMs || 300) | 0);
		let consecutiveUnknown = 0;
		let decimals = 6;
		try { decimals = await getMintDecimals(mintStr); } catch {}

		while (now() - start < timeoutMs) {
			try {
				const b = await getAtaBalanceUiInternal(ownerPubkeyStr, mintStr, decimals);
				const cur = Math.max(0, Number(b?.sizeUi || 0));
				const dec = Number.isFinite(b?.decimals) ? b.decimals : decimals;
				if (b?.sampleOk) {
					consecutiveUnknown = 0;
					effPollMs = Math.max(150, Number(pollMs || 300) | 0);
					if (cur > 0) return { sizeUi: cur, decimals: dec };
				} else {
					consecutiveUnknown++;
					effPollMs = Math.min(5000, Math.floor(effPollMs * 1.6) + 25);
				}
			} catch {
				consecutiveUnknown++;
				effPollMs = Math.min(5000, Math.floor(effPollMs * 1.6) + 25);
			}
			const extra = Math.min(1500, consecutiveUnknown * 40);
			await _sleep(Math.max(effPollMs, _rpcLeft()) + extra);
		}
		return { sizeUi: 0, decimals };
	}

	async function waitForTokenCreditIncreaseInternal(ownerPubkeyStr, mintStr, prevSizeUi = 0, { timeoutMs = 8000, pollMs = 300, epsilonUi = 1e-9 } = {}) {
		const start = now();
		let effPollMs = Math.max(150, Number(pollMs || 300) | 0);
		let consecutiveUnknown = 0;
		let decimals = 6;
		try { decimals = await getMintDecimals(mintStr); } catch {}

		const prev = Math.max(0, Number(prevSizeUi || 0));
		const eps = Math.max(1e-12, Number(epsilonUi || 1e-9));
		let lastCur = prev;

		while (now() - start < timeoutMs) {
			try {
				const b = await getAtaBalanceUiInternal(ownerPubkeyStr, mintStr, decimals);
				const cur = Math.max(0, Number(b?.sizeUi || 0));
				lastCur = cur;
				const dec = Number.isFinite(b?.decimals) ? b.decimals : decimals;
				if (b?.sampleOk) {
					consecutiveUnknown = 0;
					effPollMs = Math.max(150, Number(pollMs || 300) | 0);
					if (prev <= eps) {
						if (cur > eps) return { increased: true, sizeUi: cur, decimals: dec };
					} else {
						if (cur > prev + eps) return { increased: true, sizeUi: cur, decimals: dec };
					}
				} else {
					consecutiveUnknown++;
					effPollMs = Math.min(5000, Math.floor(effPollMs * 1.6) + 25);
				}
			} catch {
				consecutiveUnknown++;
				effPollMs = Math.min(5000, Math.floor(effPollMs * 1.6) + 25);
			}
			const extra = Math.min(1500, consecutiveUnknown * 40);
			await _sleep(Math.max(effPollMs, _rpcLeft()) + extra);
		}
		return { increased: false, sizeUi: lastCur > prev ? lastCur : 0, decimals };
	}

	function withTimeout(promise, ms, { label = "op" } = {}) {
		const timeoutMs = Math.max(1, Number(ms || 0));
		let t = null;
		return Promise.race([
			Promise.resolve(promise).finally(() => {
				try { if (t) clearTimeout(t); } catch {}
			}),
			new Promise((_, reject) => {
				t = setTimeout(() => reject(new Error(`${label}_TIMEOUT_${timeoutMs}`)), timeoutMs);
			}),
		]);
	}

	function rpcTimeoutMs(kind = "rpc") {
		try {
			// Keep these fairly short so we can retry rather than hang forever.
			if (/send/i.test(kind)) return 20_000;
			if (/blockhash|balance/i.test(kind)) return 12_000;
			if (/lut|accountInfo|parsed/i.test(kind)) return 12_000;
			return 10_000;
		} catch {
			return 10_000;
		}
	}

	async function pollSigStatus(sig, { commitment = "confirmed", timeoutMs = 22_000 } = {}) {
		try {
			const conn = await getConn();
			const start = now();
			const hardMs = Math.max(4000, Number(timeoutMs || 0));
			while (now() - start < hardMs) {
				try {
					const st = await withTimeout(conn.getSignatureStatuses([sig]), 5000, { label: "sigStatus" });
					const v = st?.value?.[0];
					if (v?.err) return { ok: false, err: v.err, status: "TX_ERR" };
					const c = v?.confirmationStatus;
					if (commitment === "confirmed" && (c === "confirmed" || c === "finalized")) return { ok: true, status: c };
					if (commitment === "finalized" && c === "finalized") return { ok: true, status: c };
				} catch (e) {
					markRpcStress?.(e, 1500);
				}
				await new Promise((r) => setTimeout(r, 700));
			}
			return { ok: false, status: "NO_CONFIRM" };
		} catch (e) {
			markRpcStress?.(e, 2000);
			return { ok: false, status: "NO_CONFIRM" };
		}
	}

	async function safeConfirmSig(sig, { commitment = "confirmed", timeoutMs = 22_000, requireFinalized = false } = {}) {
		const want = requireFinalized ? "finalized" : commitment;
		const hardMs = Math.max(4000, Number(timeoutMs || 0));
		try {
			if (typeof confirmSig === "function") {
				const ok = await withTimeout(
					confirmSig(sig, { commitment, timeoutMs: hardMs, requireFinalized }),
					hardMs + 6000,
					{ label: "confirmSig" },
				).catch(() => false);
				if (ok) return true;
			}
		} catch (e) {
			markRpcStress?.(e, 2000);
		}
		const polled = await pollSigStatus(sig, { commitment: want, timeoutMs: hardMs });
		return !!polled?.ok;
	}

	async function getJupBase() {
		const cfg = (typeof getCfg === "function") ? await getCfg() : (typeof getCfg === "object" ? getCfg : {});
		return String(cfg?.jupiterBase || "https://api.jup.ag").replace(/\/+$/, "");
	}

	async function getJupApiKey() {
		try {
			const cfg = (typeof getCfg === "function") ? await getCfg() : (typeof getCfg === "object" ? getCfg : {});
			return String(cfg?.jupiterApiKey || cfg?.jupApiKey || "").trim();
		} catch {
			return "";
		}
	}

	async function getMintDecimals(mintStr) {
		if (!mintStr) return 6;
		if (mintStr === SOL_MINT) return 9;
		try {
			const cfg = (typeof getCfg === "function") ? await getCfg() : (typeof getCfg === "object" ? getCfg : {});
			const cached = Number(cfg?.tokenDecimals?.[mintStr]);
			if (Number.isFinite(cached)) return cached;
		} catch {}
		try {
			const { PublicKey } = await loadWeb3();
			const conn = await getConn();
			const info = await withTimeout(
				conn.getParsedAccountInfo(new PublicKey(mintStr), "processed"),
				rpcTimeoutMs("parsedAccountInfo"),
				{ label: "parsedAccountInfo" },
			);
			const d = Number(info?.value?.data?.parsed?.info?.decimals);
			return Number.isFinite(d) ? d : 6;
		} catch {
			return 6;
		}
	}

	async function jupFetch(path, opts) {
		const base = await getJupBase();
		const apiKey = await getJupApiKey();
		const url = `${base}${path}`;
		const isGet = !opts || String(opts.method || "GET").toUpperCase() === "GET";
		const isQuote = isGet && /\/quote(\?|$)/.test(path);

		// Jupiter now requires an API key on api.jup.ag. Return a synthetic response so callers
		// can handle it like a normal HTTP failure without throwing.
		try {
			const isApi = /(^|\/\/)api\.jup\.ag\b/i.test(String(base || ""));
			if (isApi && !apiKey) {
				return new Response(
					JSON.stringify({ error: "API_KEY_REQUIRED", msg: "This bot requires a Jup API key (x-api-key)." }),
					{ status: 401, headers: { "content-type": "application/json" } },
				);
			}
		} catch {}

		const nowTs = Date.now();
		let minGapMs = isQuote ? 1200 : 200;
		try {
			const q = Number(window._fdvJupQuoteMinGapMs);
			const a = Number(window._fdvJupMinGapMs);
			if (isQuote && Number.isFinite(q) && q > 0) minGapMs = q;
			if (!isQuote && Number.isFinite(a) && a > 0) minGapMs = a;
		} catch {}
		minGapMs = Math.max(isQuote ? 450 : 120, Number(minGapMs || 0) | 0);

		if (typeof rpcWait === "function") {
			await rpcWait(isQuote ? "jup-quote" : "jup", minGapMs);
		} else {
			if (!window._fdvJupLastCall) window._fdvJupLastCall = 0;
			const waitMs = Math.max(0, window._fdvJupLastCall + minGapMs - nowTs) + (isQuote ? Math.floor(Math.random() * 200) : 0);
			if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
			window._fdvJupLastCall = Date.now();
		}

		const stressLeft = Math.max(0, (window._fdvJupStressUntil || 0) - nowTs);
		if (stressLeft > 0) {
			await new Promise((r) => setTimeout(r, Math.min(3000, stressLeft) + (isQuote ? Math.floor(Math.random() * 120) : 0)));
		}

		if (isGet) {
			if (!window._fdvJupInflight) window._fdvJupInflight = new Map();
			const inflight = window._fdvJupInflight;
			if (inflight.has(url)) return inflight.get(url);
		}

		if (isQuote) {
			if (!window._fdvJupQuoteCache) window._fdvJupQuoteCache = new Map();
			const cache = window._fdvJupQuoteCache;
			const hit = cache.get(url);
			if (hit && (Date.now() - hit.ts) < 1500) {
				log(`JUP cache hit: ${url}`);
				return new Response(JSON.stringify(hit.json), { status: 200, headers: { "content-type": "application/json" } });
			}
		}

		log(`JUP fetch: ${opts?.method || "GET"} ${url}`);

		async function doFetchWithRetry() {
			let lastRes = null;
			let lastBody = "";
			for (let attempt = 0; attempt < 3; attempt++) {
				const controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
				const method = String(opts?.method || "GET").toUpperCase();
				const baseT = isQuote ? 12_000 : (method === "POST" ? 25_000 : 16_000);
				const timeoutMs = Math.max(6000, baseT + attempt * 2500);
				let to = null;
				try {
					if (controller) {
						to = setTimeout(() => {
							try { controller.abort(); } catch {}
						}, timeoutMs);
					}
					let optHeaders = {};
					try {
						if (typeof Headers !== "undefined" && opts?.headers instanceof Headers) {
							optHeaders = Object.fromEntries(opts.headers.entries());
						} else {
							optHeaders = opts?.headers ? { ...(opts.headers) } : {};
						}
					} catch {
						optHeaders = {};
					}
					const headers = { accept: "application/json", ...optHeaders };
					if (apiKey) headers["x-api-key"] = apiKey;
					const res = await fetch(url, {
						...(opts || {}),
						headers,
						signal: controller?.signal,
					});
					lastRes = res;
					if (res && res.status === 401) {
						try {
							_throttledLog?.(
								`jup:401:${method}:${path}`,
								`JUP 401 Unauthorized (${method} ${path}) apiKeyPresent=${!!apiKey} headerSent=${!!headers["x-api-key"]}`,
								15_000,
								"warn",
							);
						} catch {}
					}
					if (res.ok && isQuote) {
						try {
							const json = await res.clone().json();
							if (!window._fdvJupQuoteCache) window._fdvJupQuoteCache = new Map();
							window._fdvJupQuoteCache.set(url, { ts: Date.now(), json });
						} catch {}
					}
				} catch (e) {
					markRpcStress?.(e, 1500);
					const msg = String(e?.message || e || "");
					log(`JUP fetch error: ${method} ${url} (${msg})`);
					const backoff = 700 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
					window._fdvJupStressUntil = Date.now() + 15_000;
					await new Promise((r) => setTimeout(r, backoff));
					continue;
				} finally {
					try { if (to) clearTimeout(to); } catch {}
				}

				const res = lastRes;
				if (!res) continue;

				if (res.status !== 429) {
					if (!res.ok && isQuote && res.status === 400) {
						try {
							lastBody = await res.clone().text();
						} catch {}
						if (/rate limit exceeded/i.test(lastBody)) {
							const backoff = 600 * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
							log(`JUP 400(rate-limit): backing off ${backoff}ms`);
							window._fdvJupStressUntil = Date.now() + 20_000;
							try { markRpcStress?.(new Error("JUP 400(rate-limit)"), 2500); } catch {}
							await new Promise((r) => setTimeout(r, backoff));
							continue;
						}
					}
					return res;
				}

				const backoff = 600 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
				log(`JUP 429: backing off ${backoff}ms`);
				window._fdvJupStressUntil = Date.now() + 20_000;
				try { markRpcStress?.(new Error("JUP 429"), 3000); } catch {}
				await new Promise((r) => setTimeout(r, backoff));
			}
			return lastRes;
		}

		const p = doFetchWithRetry();
		if (isGet) {
			window._fdvJupInflight.set(url, p);
			try {
				const res = await p;
				log(`JUP resp: ${res.status} ${url}`);
				return res.clone();
			} finally {
				window._fdvJupInflight.delete(url);
			}
		}

		const res = await p;
		log(`JUP resp: ${res.status} ${url}`);
		return res;
	}

	async function quoteGeneric(inputMint, outputMint, amountRaw, slippageBps) {
		try {
			const baseUrl = await getJupBase();
			const isLite = /lite-api\.jup\.ag/i.test(String(baseUrl || ''));

			let amtStr = "1";
			try {
				if (typeof amountRaw === "string") {
					const bi = BigInt(amountRaw);
					amtStr = bi > 0n ? amountRaw : "1";
				} else {
					const n = Math.floor(Number(amountRaw || 0));
					amtStr = n > 0 ? String(n) : "1";
				}
			} catch {
				amtStr = "1";
			}

			const mk = (restrict) => {
				const u = new URL("/swap/v1/quote", "https://fdv.lol");
				u.searchParams.set("inputMint", inputMint);
				u.searchParams.set("outputMint", outputMint);
				u.searchParams.set("amount", amtStr);
				u.searchParams.set("slippageBps", String(Math.max(1, slippageBps | 0)));
				u.searchParams.set("restrictIntermediateTokens", String(!!restrict));
				return u;
			};

			const u1 = mk(true);
			const r1 = await jupFetch(u1.pathname + u1.search);
			if (r1?.ok) return await r1.json();

			// lite-api free tier does not support restrictIntermediateTokens=false
			if (isLite) return null;

			const u2 = mk(false);
			const r2 = await jupFetch(u2.pathname + u2.search);
			if (r2?.ok) return await r2.json();
			return null;
		} catch {
			return null;
		}
	}

	function _getSwap400Store() {
		if (!window._fdvSwap400) window._fdvSwap400 = new Map();
		return window._fdvSwap400;
	}

	function noteSwap400(inputMint, outputMint) {
		try {
			const k = `${inputMint}->${outputMint}`;
			const m = _getSwap400Store();
			const prev = m.get(k) || { count: 0, lastAt: 0 };
			const within = now() - prev.lastAt < 60_000;
			const next = { count: (within ? prev.count : 0) + 1, lastAt: now() };
			m.set(k, next);
			log(`Noted swap 400 for ${k}: count=${next.count}`);
			return next.count;
		} catch {
			return 0;
		}
	}

	async function jupSwapWithKeypair({ signer, inputMint, outputMint, amountUi, slippageBps }) {
		const state = getState();

		const { PublicKey, VersionedTransaction, Transaction } = await loadWeb3();
		const conn = await getConn();
		const userPub = signer.publicKey.toBase58();
		const baseFeeBps = Number(FDV_PLATFORM_FEE_BPS || 0);
		let appliedFeeBps = Math.max(0, Math.floor(baseFeeBps));
		let feeAccount = null;
		let lastErrCode = "";
		let lastErrMsg = "";

		function noteLastErr(r) {
			try {
				if (!r || r.ok) return;
				if (r.code) lastErrCode = r.code;
				if (r.msg) lastErrMsg = r.msg;
			} catch {}
		}

		try {
			const okIn = await isValidPubkeyStr?.(inputMint);
			const okOut = await isValidPubkeyStr?.(outputMint);
			if (!okIn || !okOut) throw new Error("INVALID_MINT");
		} catch {
			throw new Error("INVALID_MINT");
		}

		const inDecimals = await getMintDecimals(inputMint);
		let baseSlip = Math.max(150, Number(slippageBps ?? state.slippageBps ?? 150) | 0);
		const isBuy = inputMint === SOL_MINT && outputMint !== SOL_MINT;
		if (isBuy) baseSlip = Math.min(300, Math.max(200, baseSlip));
		const amountRaw = Math.max(1, Math.floor(amountUi * Math.pow(10, inDecimals)));

		let _preBuyRent = 0;
		if (isBuy) {
			try {
				_preBuyRent = await requiredAtaLamportsForSwap?.(userPub, inputMint, outputMint);
			} catch {
				_preBuyRent = 0;
			}
		}

		const baseUrl = await getJupBase();
		const isLite = /lite-api\.jup\.ag/i.test(baseUrl);
		const restrictAllowed = !isLite;

		const isSell = inputMint !== SOL_MINT && outputMint === SOL_MINT;
		// lite-api free tier rejects restrictIntermediateTokens=false
		let restrictIntermediates = isSell ? (restrictAllowed ? "false" : "true") : "true";

		let quoteIncludesFee = false;

		function _computeReferralPayoutMeta() {
			try {
				// Only pay on profitable sells where the platform fee is attached.
				if (!(inputMint !== SOL_MINT && outputMint === SOL_MINT)) return null;
				if (!(feeAccount && appliedFeeBps > 0)) return null;
				const ref = getActiveReferral?.(now())?.ref;
				if (!ref) return null;

				const outLamports = Math.floor(Number(quote?.outAmount || 0));
				if (!(outLamports > 0)) return null;

				const inRaw = Math.floor(Number(quote?.inAmount || amountRaw || 0));
				const soldUi = (Number.isFinite(inDecimals) && inDecimals > 0)
					? (inRaw / Math.pow(10, inDecimals))
					: Number(amountUi || 0);
				if (!(soldUi > 0)) return null;

				const pos = state?.positions?.[inputMint];
				const posSize = Math.max(0, Number(pos?.sizeUi || 0));
				const posCost = Math.max(0, Number(pos?.costSol || 0));
				if (!(posSize > 0) || !(posCost > 0)) return null;

				const frac = Math.max(0, Math.min(1, soldUi / Math.max(1e-12, posSize)));
				const costSoldSol = posCost * frac;
				const profitSol = (outLamports / 1e9) - costSoldSol;
				if (!(Number.isFinite(profitSol) && profitSol > 0)) return null;

				const payLamports = Math.floor((profitSol * 0.01) * 1e9);
				if (!(payLamports > 0)) return null;

				return {
					ref,
					lamports: payLamports,
					profitSol,
					feeBps: Math.floor(appliedFeeBps) || 0,
					inputMint,
					soldUi,
					outLamports,
				};
			} catch {
				return null;
			}
		}

		let _preSplitUi = 0;
		let _decHint = await getMintDecimals(inputMint).catch(() => 6);
		if (isSell) {
			try {
				const b0 = await getAtaBalanceUiInternal(userPub, inputMint, _decHint);
				_preSplitUi = Number(b0?.sizeUi || 0);
				if (Number.isFinite(b0?.decimals)) _decHint = b0.decimals;
			} catch {}
		}

		if (isBuy) {
			const rentSol = (_preBuyRent / 1e9).toFixed(6);
			log(`Buy cost breakdown: input=${(amountRaw / 1e9).toFixed(6)} SOL + ataRent≈${rentSol} (one-time; may include wSOL + out ATA)`);
		}

		async function notePendingBuySeed() {
			try {
				if (!isBuy) return;
				const outRaw = Number(quote?.outAmount || 0);
				if (!Number.isFinite(outRaw) || outRaw <= 0) return;
				const dec = await safeGetDecimalsFast?.(outputMint);
				const ui = outRaw / Math.pow(10, dec);
				if (ui > 0) {
					putBuySeed?.(userPub, outputMint, {
						sizeUi: ui,
						decimals: dec,
						costSol: Number(amountUi || 0),
					});
				}
			} catch {}
		}

		async function _reconcileSplitSellRemainder(sig) {
			try {
				await safeConfirmSig(sig, { commitment: "confirmed", timeoutMs: 15000 }).catch(() => {});
				let remainUi = 0,
					d = _decHint;
				try {
					const b1 = await getAtaBalanceUiInternal(userPub, inputMint, d);
					remainUi = Number(b1?.sizeUi || 0);
					if (Number.isFinite(b1?.decimals)) d = b1.decimals;
				} catch {}
				if (remainUi <= 1e-9) {
					try { removeFromPosCache?.(userPub, inputMint); } catch {}
					try { clearPendingCredit?.(userPub, inputMint); } catch {}
					if (state.positions && state.positions[inputMint]) {
						delete state.positions[inputMint];
						save?.();
					}
					return;
				}
				const estRemainSol = await quoteOutSol?.(inputMint, remainUi, d).catch(() => 0);
				const minN = minSellNotionalSol?.();
				if (estRemainSol >= minN) {
					const prevSize = _preSplitUi > 0 ? _preSplitUi : (state.positions?.[inputMint]?.sizeUi || 0);
					const frac = prevSize > 0 ? Math.min(1, Math.max(0, remainUi / Math.max(1e-9, prevSize))) : 1;
					const pos = state.positions?.[inputMint];
					if (pos) {
						pos.sizeUi = remainUi;
						pos.decimals = d;
						pos.costSol = Number(pos.costSol || 0) * frac;
						pos.hwmSol = Number(pos.hwmSol || 0) * frac;
						pos.lastSellAt = now();
						save?.();
					}
					updatePosCache?.(userPub, inputMint, remainUi, d);
				} else {
					try { addToDustCache?.(userPub, inputMint, remainUi, d); } catch {}
					try { removeFromPosCache?.(userPub, inputMint); } catch {}
					if (state.positions && state.positions[inputMint]) {
						delete state.positions[inputMint];
						save?.();
					}
					log(`Split-sell remainder below notional for ${inputMint.slice(0, 4)}… moved to dust cache.`);
				}
			} catch {}
		}

		function buildQuoteUrl({ outMint, slipBps, restrict, asLegacy = false, amountOverrideRaw, withFee = false }) {
			const u = new URL("/swap/v1/quote", "https://fdv.lol");
			const amt = Number.isFinite(amountOverrideRaw) ? amountOverrideRaw : amountRaw;
			u.searchParams.set("inputMint", inputMint);
			u.searchParams.set("outputMint", outMint);
			u.searchParams.set("amount", String(amt));
			u.searchParams.set("slippageBps", String(slipBps));
			u.searchParams.set("restrictIntermediateTokens", String(restrict === "false" ? false : true));
			if (withFee && appliedFeeBps > 0) u.searchParams.set("platformFeeBps", String(appliedFeeBps));
			if (asLegacy) u.searchParams.set("asLegacyTransaction", "true");
			return u;
		}

		let feeDestCandidate = null;
		if (baseFeeBps > 0 && isSell) {
			const acct = FEE_ATAS?.[outputMint] || (outputMint === SOL_MINT ? FEE_ATAS?.[SOL_MINT] : null);
			feeDestCandidate = acct || null;
		}

		const q = buildQuoteUrl({ outMint: outputMint, slipBps: baseSlip, restrict: restrictIntermediates, withFee: false });
		logObj("Quote params", {
			inputMint,
			outputMint,
			amountUi,
			inDecimals,
			slippageBps: baseSlip,
			restrictIntermediateTokens: restrictIntermediates,
			baseFeeBps: Math.floor(baseFeeBps) || 0,
			appliedFeeBps: Math.floor(appliedFeeBps) || 0,
		});

		let quote;
		let haveQuote = false;

		async function seedCacheIfBuy() {
			if (window._fdvDeferSeed) return;
			if (inputMint === SOL_MINT && outputMint !== SOL_MINT) {
				const estRaw = Number(quote?.outAmount || 0);
				if (estRaw > 0) {
					const dec = await safeGetDecimalsFast?.(outputMint);
					const ui = estRaw / Math.pow(10, dec || 0);
					try {
						updatePosCache?.(userPub, outputMint, ui, dec);
						log(`Seeded cache for ${outputMint.slice(0,4)}… (~${ui.toFixed(6)})`);
					} catch {}
					setTimeout(() => {
						Promise.resolve()
							.then(() => syncPositionsFromChain?.(userPub).catch(()=>{}))
							.then(() => processPendingCredits?.().catch(()=>{}));
					}, 0);
				}
			}
		}

		async function buildAndSend(useSharedAccounts = true, asLegacy = false) {
			const sharedAllowed = !!useSharedAccounts && !window._fdvJupDisableSharedAccounts;
			if (!!useSharedAccounts && !sharedAllowed) {
				_throttledLog(
					"jup:sharedDisabled",
					"Jupiter: shared accounts disabled; sending swap without shared accounts.",
					20_000,
					"warn",
				);
			}

			if (inputMint === SOL_MINT && outputMint !== SOL_MINT) {
				try {
					const balL = await withTimeout(
						conn.getBalance(signer.publicKey, "processed"),
						rpcTimeoutMs("balance"),
						{ label: "getBalance" },
					);
					const needL = amountRaw + Math.ceil(_preBuyRent) + Number(TX_FEE_BUFFER_LAMPORTS || 0);
					if (balL < needL) {
						log(`Buy preflight: insufficient SOL ${(balL/1e9).toFixed(6)} < ${(needL/1e9).toFixed(6)} (amount+rent+fees).`);
						throw new Error("INSUFFICIENT_LAMPORTS");
					}
				} catch (e) {
					if (String(e?.message||"").includes("INSUFFICIENT_LAMPORTS")) throw e;
				}
			}

			if (asLegacy) {
				try {
					const qLegacy = buildQuoteUrl({
						outMint: outputMint,
						slipBps: baseSlip,
						restrict: restrictIntermediates,
						asLegacy: true,
						withFee: !!(feeAccount && appliedFeeBps > 0),
					});
					const qResL = await jupFetch(qLegacy.pathname + qLegacy.search);
					if (!qResL.ok) {
						const body = await qResL.text().catch(()=> "");
						log(`Legacy quote failed (${qResL.status}): ${body || "(empty)"}`);
					} else {
						quote = await qResL.json();
						log("Re-quoted for legacy transaction.");
					}
				} catch (e) {
					log(`Legacy re-quote error: ${e.message || e}`, 'err');
				}
			}

			const body = {
				quoteResponse: quote,
				userPublicKey: signer.publicKey.toBase58(),
				wrapAndUnwrapSol: true,
				dynamicComputeUnitLimit: true,
				useSharedAccounts: !!sharedAllowed,
				asLegacyTransaction: !!asLegacy,
				...(feeAccount && appliedFeeBps > 0 ? { feeAccount } : {}),
			};

			try {
				const { cuPriceMicroLamports } = await getComputeBudgetConfig?.();
				if (Number(cuPriceMicroLamports) > 0) {
					body.computeUnitPriceMicroLamports = Math.floor(Number(cuPriceMicroLamports));
				}
			} catch {}

			logObj("Swap body", { hasFee: !!feeAccount, appliedFeeBps: feeAccount ? appliedFeeBps : 0, baseFeeBps: Math.floor(baseFeeBps) || 0, useSharedAccounts: !!sharedAllowed, asLegacy: !!asLegacy });

			const sRes = await jupFetch(`/swap/v1/swap`, {
				method: "POST",
				headers: { "Content-Type":"application/json", accept: "application/json" },
				body: JSON.stringify(body),
			});

			if (!sRes.ok) {
				let errTxt = "";
				try { errTxt = await sRes.clone().text(); } catch {}
				if (sRes.status === 400) {
					const c = noteSwap400(inputMint, outputMint);
					if (c >= Number(MAX_CONSEC_SWAP_400 || 0)) {
						try { setRouterHold?.(inputMint, ROUTER_COOLDOWN_MS); } catch {}
						log(`Swap 400 threshold reached (${c}) for ${inputMint.slice(0,4)}… -> cooldown applied.`);
						return { ok: false, code: "NO_ROUTE", msg: "400 abort" };
					}
					return { ok: false, code: "NO_ROUTE", msg: `swap 400 ${errTxt.slice(0,120)}` };
				}
				try {
					const j = JSON.parse(errTxt || "{}");
					const code = j?.errorCode || "";
					const msg = j?.error || `swap ${sRes.status}`;
					if (sharedAllowed && _isSharedAccountsNotSupported(code, msg)) {
						_disableSharedAccounts(msg);
					}
					return { ok: false, code, msg };
				} catch {
					return { ok: false, code: "", msg: `swap ${sRes.status}` };
				}
			}

			const { swapTransaction } = await sRes.json();
			if (!swapTransaction) return { ok: false, code: "NO_SWAP_TX", msg: "no swapTransaction" };

			const raw = atob(swapTransaction);
			const rawBytes = new Uint8Array(raw.length);
			for (let i=0; i<raw.length; i++) rawBytes[i] = raw.charCodeAt(i);

			let isVersioned = false;
			let txObj;
			try {
				txObj = VersionedTransaction.deserialize(rawBytes);
				isVersioned = true;
			} catch {
				txObj = Transaction.from(rawBytes);
				isVersioned = false;
			}
			try {
				if (isVersioned) txObj.sign([signer]);
				else txObj.sign(signer);
			} catch (e) {
				return { ok: false, code: "SIGN_FAIL", msg: e?.message || String(e) };
			}
			try {
				const sig = await withTimeout(
					conn.sendRawTransaction(txObj.serialize(), { preflightCommitment: "processed", maxRetries: 3 }),
					rpcTimeoutMs("sendRawTransaction"),
					{ label: "sendRawTransaction" },
				);
				log(`Swap sent: ${sig}`);
				try { log(`Explorer: https://solscan.io/tx/${sig}`); } catch {}
				try {
					const meta = _computeReferralPayoutMeta();
					if (meta) _armReferralPayout(sig, meta);
				} catch {}
				try { if (isSell) setTimeout(() => _reconcileSplitSellRemainder(sig), 0); } catch {}
				try {
					if (inputMint === SOL_MINT || outputMint === SOL_MINT) {
						setTimeout(() => { unwrapWsolIfAny?.(signer).catch(()=>{}); }, 1200);
						setTimeout(() => { unwrapWsolIfAny?.(signer).catch(()=>{}); }, 1500);
					}
				} catch {}
				return { ok: true, sig };
			} catch (e) {
				markRpcStress?.(e, 2500);
				const emsg0 = String(e?.message || e || "");
				const sendCode0 = _classifySendFail(emsg0);
				if (/simulation failed/i.test(emsg0) && /method not found/i.test(emsg0)) {
					_noteRpcNoSimulate(emsg0);
					try {
						const sig2 = await withTimeout(
							conn.sendRawTransaction(txObj.serialize(), { skipPreflight: true, preflightCommitment: "processed", maxRetries: 3 }),
							rpcTimeoutMs("sendRawTransaction"),
							{ label: "sendRawTransaction_skipPreflight" },
						);
						log(`Swap sent (skipPreflight): ${sig2}`);
						try { log(`Explorer: https://solscan.io/tx/${sig2}`); } catch {}
						try {
							const meta = _computeReferralPayoutMeta();
							if (meta) _armReferralPayout(sig2, meta);
						} catch {}
						try { if (isSell) setTimeout(() => _reconcileSplitSellRemainder(sig2), 0); } catch {}
						try {
							if (inputMint === SOL_MINT || outputMint === SOL_MINT) {
								setTimeout(() => { unwrapWsolIfAny?.(signer).catch(()=>{}); }, 1200);
								setTimeout(() => { unwrapWsolIfAny?.(signer).catch(()=>{}); }, 1500);
							}
						} catch {}
						return { ok: true, sig: sig2 };
					} catch (e2) {
						markRpcStress?.(e2, 2500);
					}
				}
				_throttledLog(
					`swapSendFail:${inputMint}->${outputMint}`,
					`Swap send failed (${sendCode0}): ${_shortErr(e)}. Simulating…`,
					12_000,
					"warn",
				);
				if (window._fdvRpcNoSimulate) {
					return { ok: false, code: sendCode0, msg: _shortErr(emsg0, 240) };
				}
				try {
					const sim = await withTimeout(
						conn.simulateTransaction(txObj, { sigVerify: false, replaceRecentBlockhash: true }),
						rpcTimeoutMs("simulate"),
						{ label: "simulateTransaction" },
					);
					const logs = sim?.value?.logs || e?.logs || [];
					const txt = (logs || []).join(" ");
					const hasDustErr = /0x1788|0x1789/i.test(txt);
					const hasSlipErr = /0x1771/i.test(txt);
					if (hasDustErr) return { ok: false, code: "ROUTER_DUST", msg: e.message || String(e) };
					if (hasSlipErr) return { ok: false, code: "SLIPPAGE", msg: e.message || String(e) };
					const code = _classifySendFail(`${emsg0} ${txt || ""}`);
					return { ok: false, code, msg: _shortErr(emsg0) || _shortErr(txt) };
				} catch (simErr) {
					const smsg = String(simErr?.message || simErr || "");
					if (/method not found/i.test(smsg)) {
						_noteRpcNoSimulate(smsg);
						return { ok: false, code: sendCode0, msg: _shortErr(emsg0, 240) };
					}
					const code = _classifySendFail(emsg0);
					return { ok: false, code, msg: _shortErr(emsg0, 240) };
				}
			}
		}

		async function manualBuildAndSend(useSharedAccounts = true) {
			const { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } = await loadWeb3();
			try {
				const sharedAllowed = !!useSharedAccounts && !window._fdvJupDisableSharedAccounts;
				const body = {
					quoteResponse: quote,
					userPublicKey: signer.publicKey.toBase58(),
					wrapAndUnwrapSol: true,
					dynamicComputeUnitLimit: true,
					useSharedAccounts: !!sharedAllowed,
					asLegacyTransaction: false,
					...(feeAccount && appliedFeeBps > 0 ? { feeAccount, platformFeeBps: appliedFeeBps } : {}),
				};
				try {
					const { cuPriceMicroLamports } = await getComputeBudgetConfig?.();
					if (Number(cuPriceMicroLamports) > 0) {
						body.computeUnitPriceMicroLamports = Math.floor(Number(cuPriceMicroLamports));
					}
				} catch {}
				log(`Swap-instructions request (manual send) … hasFee=${!!feeAccount}, useSharedAccounts=${!!sharedAllowed}`);

				const iRes = await jupFetch(`/swap/v1/swap-instructions`, {
					method: "POST",
					headers: { "Content-Type":"application/json", accept: "application/json" },
					body: JSON.stringify(body),
				});
				if (!iRes.ok) {
					let errTxt = "";
					try { errTxt = await iRes.clone().text(); } catch {}
					if (iRes.status === 400) {
						const c = noteSwap400(inputMint, outputMint);
						if (c >= Number(MAX_CONSEC_SWAP_400 || 0)) {
							try { setRouterHold?.(inputMint, ROUTER_COOLDOWN_MS); } catch {}
							log(`Swap-instructions 400 threshold reached (${c}) for ${inputMint.slice(0,4)}… -> cooldown applied.`);
							return { ok: false, code: "NO_ROUTE", msg: "400 abort" };
						}
						return { ok: false, code: "NO_ROUTE", msg: `swap-instr 400 ${errTxt.slice(0,120)}` };
					}
					try {
						const j = JSON.parse(errTxt || "{}");
						const code = j?.errorCode || "";
						const msg = j?.error || "";
						if (sharedAllowed && _isSharedAccountsNotSupported(code, msg)) {
							_disableSharedAccounts(msg);
						}
					} catch {}
					const isNoRoute = /NO_ROUTE|COULD_NOT_FIND_ANY_ROUTE/i.test(errTxt);
					log(`Swap-instructions error: ${errTxt || iRes.status}`, 'err');
					return { ok: false, code: isNoRoute ? "NO_ROUTE" : "JUP_DOWN", msg: `swap-instructions ${iRes.status}` };
				}

				const {
					computeBudgetInstructions = [],
					setupInstructions = [],
					swapInstruction,
					cleanupInstructions = [],
					addressLookupTableAddresses = [],
				} = await iRes.json();

				if (!swapInstruction) {
					return { ok: false, code: "NO_ROUTE", msg: "no swapInstruction" };
				}

				function decodeData(d) {
					if (!d) return new Uint8Array();
					if (d instanceof Uint8Array) return d;
					if (Array.isArray(d)) return new Uint8Array(d);
					if (typeof d === "string") {
						const raw = atob(d);
						const b = new Uint8Array(raw.length);
						for (let i=0;i<raw.length;i++) b[i] = raw.charCodeAt(i);
						return b;
					}
					return new Uint8Array();
				}

				function toIx(ix) {
					if (!ix) return null;
					const pid = new PublicKey(ix.programId);
					const keys = (ix.accounts || []).map(a => {
						if (typeof a === "string") return { pubkey: new PublicKey(a), isSigner: false, isWritable: false };
						const pk = a.pubkey || a.pubKey || a.address || a;
						return { pubkey: new PublicKey(pk), isSigner: !!a.isSigner, isWritable: !!a.isWritable };
					});
					const data = decodeData(ix.data);
					return new TransactionInstruction({ programId: pid, keys, data });
				}

				let ixs = [
					...computeBudgetInstructions.map(toIx).filter(Boolean),
					...setupInstructions.map(toIx).filter(Boolean),
					toIx(swapInstruction),
					...cleanupInstructions.map(toIx).filter(Boolean),
				].filter(Boolean);

				try {
					if (typeof dedupeComputeBudgetIxs === "function") ixs = dedupeComputeBudgetIxs(ixs);
				} catch {}

				try {
					if (typeof hasComputeBudgetIx === "function" && !hasComputeBudgetIx(ixs)) {
						const cb = await buildComputeBudgetIxs?.();
						if (cb?.length) ixs.unshift(...cb);
					}
				} catch {}

				const lookups = [];
				for (const addr of addressLookupTableAddresses || []) {
					try {
						const lut = await withTimeout(
							conn.getAddressLookupTable(new PublicKey(addr)),
							rpcTimeoutMs("lut"),
							{ label: "getAddressLookupTable" },
						);
						if (lut?.value) lookups.push(lut.value);
					} catch {}
				}

				const { blockhash } = await withTimeout(
					conn.getLatestBlockhash("confirmed"),
					rpcTimeoutMs("blockhash"),
					{ label: "getLatestBlockhash" },
				);
				const msg = new TransactionMessage({
					payerKey: signer.publicKey,
					recentBlockhash: blockhash,
					instructions: ixs,
				}).compileToV0Message(lookups);

				const vtx = new VersionedTransaction(msg);
				vtx.sign([signer]);

				try {
					const sig = await withTimeout(
						conn.sendRawTransaction(vtx.serialize(), {
						preflightCommitment: "confirmed",
						maxRetries: 3,
					}),
						rpcTimeoutMs("sendRawTransaction"),
						{ label: "sendRawTransaction" },
					);
						const ok = await safeConfirmSig(sig, { commitment: "confirmed", timeoutMs: 15000 });
					if (!ok) {
						const st = await withTimeout(conn.getSignatureStatuses([sig]), 5000, { label: "sigStatus" }).catch(()=>null);
						const status = st?.value?.[0]?.err ? "TX_ERR" : "NO_CONFIRM";
						return { ok: false, code: status, msg: "not confirmed" };
					}
					log(`Swap (manual send v1) sent: ${sig}`);
					try { log(`Explorer: https://solscan.io/tx/${sig}`); } catch {}
					try {
						const meta = _computeReferralPayoutMeta();
						if (meta) _armReferralPayout(sig, meta);
					} catch {}
					try { if (isSell) setTimeout(() => _reconcileSplitSellRemainder(sig), 0); } catch {}
					try {
						if (inputMint === SOL_MINT || outputMint === SOL_MINT) {
							setTimeout(() => { unwrapWsolIfAny?.(signer).catch(()=>{}); }, 1200);
							setTimeout(() => { unwrapWsolIfAny?.(signer).catch(()=>{}); }, 1500);
						}
					} catch {}
					return { ok: true, sig };
				} catch (e) {
					const emsg = String(e?.message || e || "");
					if (_isNoRouteLike(emsg) || _isDustLike(emsg)) {
						_throttledLog(
							`manualSend:noRoute:${inputMint}`,
							`Manual send failed (no route/dust) for ${String(inputMint || "").slice(0, 4)}…`,
							12_000,
							"warn",
						);
						return { ok: false, code: _isDustLike(emsg) ? "ROUTER_DUST" : "NO_ROUTE", msg: _shortErr(emsg) };
					}

					if (/simulation failed/i.test(emsg) && /method not found/i.test(emsg)) {
						_noteRpcNoSimulate(emsg);
						try {
							const sig2 = await withTimeout(
								conn.sendRawTransaction(vtx.serialize(), {
									skipPreflight: true,
									preflightCommitment: "confirmed",
									maxRetries: 3,
								}),
								rpcTimeoutMs("sendRawTransaction"),
								{ label: "sendRawTransaction_skipPreflight" },
							);
							const ok2 = await safeConfirmSig(sig2, { commitment: "confirmed", timeoutMs: 15000 });
							if (!ok2) return { ok: false, code: "NO_CONFIRM", msg: "not confirmed" };
							log(`Swap (manual send v1, skipPreflight) sent: ${sig2}`);
							try { log(`Explorer: https://solscan.io/tx/${sig2}`); } catch {}
							try {
								const meta = _computeReferralPayoutMeta();
								if (meta) _armReferralPayout(sig2, meta);
							} catch {}
							try { if (isSell) setTimeout(() => _reconcileSplitSellRemainder(sig2), 0); } catch {}
							try {
								if (inputMint === SOL_MINT || outputMint === SOL_MINT) {
									setTimeout(() => { unwrapWsolIfAny?.(signer).catch(()=>{}); }, 1200);
									setTimeout(() => { unwrapWsolIfAny?.(signer).catch(()=>{}); }, 1500);
								}
							} catch {}
							return { ok: true, sig: sig2 };
						} catch (e2) {
							markRpcStress?.(e2, 2500);
						}
					}

					log(`Manual send failed: ${_shortErr(e)}. Simulating…`);
					if (window._fdvRpcNoSimulate) {
						return { ok: false, code: _classifySendFail(emsg), msg: _shortErr(emsg, 240) };
					}
					try {
						const sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
						const logs = sim?.value?.logs || e?.logs || [];
						const txt = (logs || []).join(" ");
						const hasDustErr = /0x1788|0x1789/i.test(txt);
						const hasSlipErr = /0x1771/i.test(txt);
						if (hasDustErr) return { ok: false, code: "ROUTER_DUST", msg: e.message || String(e) };
						if (hasSlipErr) return { ok: false, code: "SLIPPAGE", msg: e.message || String(e) };
						return { ok: false, code: _classifySendFail(`${emsg} ${txt || ""}`), msg: _shortErr(emsg, 240) || _shortErr(txt) };
					} catch (simErr) {
						const smsg = String(simErr?.message || simErr || "");
						if (/method not found/i.test(smsg)) {
							_noteRpcNoSimulate(smsg);
							return { ok: false, code: _classifySendFail(emsg), msg: _shortErr(emsg, 240) };
						}
						return { ok: false, code: _classifySendFail(emsg), msg: _shortErr(emsg, 240) };
					}
				}
			} catch (e) {
				return { ok: false, code: "", msg: e.message || String(e) };
			}
		}

		{
			try {
				const qRes = await jupFetch(q.pathname + q.search);
				if (!qRes.ok) {
					if (isSell) {
						const altRestrict = restrictIntermediates === "false" ? "true" : (restrictAllowed ? "false" : "true");
						if (String(altRestrict) === String(restrictIntermediates)) {
							const body = await qRes.text().catch(() => "");
							if (_isNoRouteLike(body)) {
								_throttledLog(`quote:noRoute:${inputMint}`, `Sell quote: no route for ${inputMint.slice(0, 4)}…`, 12_000, "warn");
								throw new Error("NO_ROUTE");
							}
							_throttledLog(`quote:fail:${inputMint}`, `Sell quote failed (${qRes.status}) for ${inputMint.slice(0, 4)}…`, 12_000, "warn");
							haveQuote = false;
						} else {
							const alt = buildQuoteUrl({ outMint: outputMint, slipBps: baseSlip, restrict: altRestrict, withFee: false });
							log(`Primary sell quote failed (${qRes.status}). Retrying with restrictIntermediateTokens=${alt.searchParams.get("restrictIntermediateTokens")} …`);
							const qRes2 = await jupFetch(alt.pathname + alt.search);
							if (qRes2.ok) {
								quote = await qRes2.json();
								haveQuote = true;
							} else {
								const body = await qRes2.text().catch(() => "");
								if (_isNoRouteLike(body)) {
									_throttledLog(`quote:noRoute:${inputMint}`, `Sell quote: no route for ${inputMint.slice(0, 4)}…`, 12_000, "warn");
									throw new Error("NO_ROUTE");
								}
								_throttledLog(`quote:retryFail:${inputMint}`, `Sell quote retry failed (${qRes2.status}) for ${inputMint.slice(0, 4)}…`, 12_000, "warn");
								haveQuote = false;
							}
						}
					} else {
						throw new Error(`QUOTE_${qRes.status}`);
					}
				} else {
					quote = await qRes.json();
					haveQuote = true;
				}

				if (haveQuote) {
					logObj("Quote", { inAmount: quote?.inAmount, outAmount: quote?.outAmount, routePlanLen: quote?.routePlan?.length });
				}
			} catch (e) {
				if (!isSell) throw e;
				haveQuote = false;
				if (_isNoRouteLike(e?.message || e)) throw e;
				_throttledLog(`quote:err:${inputMint}`, `Sell quote error; will try fallbacks (${inputMint.slice(0, 4)}…)`, 12_000, "warn");
			}
		}

		if (haveQuote) {
			const _isRouteDead = (codeOrMsg) => {
				return isSell && /ROUTER_DUST|NO_ROUTE/i.test(String(codeOrMsg || ""));
			};

			if (isSell) {
				const outRaw = Number(quote?.outAmount || 0);
				const minOutLamports = Math.floor(Number(minSellNotionalSol?.() || 0) * 1e9);
				if (!Number.isFinite(outRaw) || outRaw <= 0 || outRaw < minOutLamports) {
					_throttledLog(
						`sell:belowMin:${inputMint}`,
						`Sell below minimum; skipping (${(outRaw / 1e9).toFixed(6)} SOL < ${(minOutLamports / 1e9).toFixed(6)})`,
						15_000,
						"warn",
					);
					throw new Error("BELOW_MIN_NOTIONAL");
				}
			}

			if (isSell && baseFeeBps > 0 && feeDestCandidate) {
				try {
					const outRawNoFee = Number(quote?.outAmount || 0);
					const ts = now();
					const pos = state?.positions?.[inputMint];
					const decIn = Number.isFinite(inDecimals) ? inDecimals : (_decHint ?? 6);
					const posSizeUi = Math.max(0, Number(pos?.sizeUi || 0));
					const posCostSol = Math.max(0, Number(pos?.costSol || 0));
					const soldUi = amountRaw / Math.pow(10, decIn);
					const frac = (posSizeUi > 0 && soldUi > 0) ? Math.min(1, Math.max(0, soldUi / Math.max(1e-9, posSizeUi))) : 1;
					const costSoldSol = posCostSol > 0 ? (posCostSol * frac) : 0;
					appliedFeeBps = _computeDynamicPlatformFeeBps({
						state,
						baseFeeBps,
						nowTs: ts,
						estOutLamports: outRawNoFee,
						costSoldSol,
					});

					if (!(appliedFeeBps > 0)) {
						feeAccount = null;
						quoteIncludesFee = false;
						log("Dynamic fee computed as 0 bps; fee disabled for this sell.");
					} else {
					const profitableNoFee = (typeof shouldAttachFeeForSell === "function")
						? shouldAttachFeeForSell({
							mint: inputMint,
							amountRaw: amountRaw,
							inDecimals: inDecimals,
							quoteOutLamports: outRawNoFee,
						})
						: true;

						if (profitableNoFee) {
						const qFee = buildQuoteUrl({ outMint: outputMint, slipBps: baseSlip, restrict: restrictIntermediates, withFee: true });
						const qFeeRes = await jupFetch(qFee.pathname + qFee.search);
						if (qFeeRes.ok) {
							const quoteWithFee = await qFeeRes.json();
							const outRawWithFee = Number(quoteWithFee?.outAmount || 0);
							const stillProfitable = (typeof shouldAttachFeeForSell === "function")
								? shouldAttachFeeForSell({
									mint: inputMint,
									amountRaw: amountRaw,
									inDecimals: inDecimals,
									quoteOutLamports: outRawWithFee,
								})
								: true;
							if (stillProfitable) {
								quote = quoteWithFee;
								feeAccount = feeDestCandidate;
								quoteIncludesFee = true;
								const outSol = outRawWithFee / 1e9;
									const frac = baseFeeBps > 0 ? (appliedFeeBps / Math.max(1e-9, baseFeeBps)) : 0;
									const estFeeSol = outSol * (Math.max(0, appliedFeeBps) / 10_000);
									log(`Sell fee enabled @ ${appliedFeeBps} bps (base ${Math.floor(baseFeeBps)}; x${frac.toFixed(2)}). Est out ${outSol.toFixed(6)} SOL (est fee≈${estFeeSol.toFixed(6)} SOL).`);
							} else {
								feeAccount = null;
								quoteIncludesFee = false;
								log("Fee suppressed: adding fee removes estimated profit (keeping no-fee sell).");
							}
						} else {
							feeAccount = null;
							quoteIncludesFee = false;
							log("Fee quote failed; proceeding without fee for this sell.");
						}
					} else {
						feeAccount = null;
						quoteIncludesFee = false;
						log("No estimated profit; fee disabled for this sell.");
					}
					}
				} catch {
					feeAccount = null;
					quoteIncludesFee = false;
					log("Profit check failed; fee disabled for this sell.");
				}
			}

			const canTryShared = () => !window._fdvJupDisableSharedAccounts;

			const first = await buildAndSend(false);
			if (first.ok) {
				await notePendingBuySeed();
				await seedCacheIfBuy();
				return first.sig;
			}
			noteLastErr(first);
			if (_isRouteDead(first.code) || _isRouteDead(first.msg)) {
				throw new Error(String(first.code || "NO_ROUTE"));
			}

			if (first.code === "NOT_SUPPORTED") {
				// Some free/limited RPCs reject swaps that use shared accounts for Simple AMMs.
				if (canTryShared() && !_isSharedAccountsNotSupported(first.code, first.msg)) {
					log("Primary swap NOT_SUPPORTED. Fallback: shared accounts …");
					const second = await buildAndSend(true);
					if (second.ok) {
						await notePendingBuySeed();
						await seedCacheIfBuy();
						return second.sig;
					}
					noteLastErr(second);
					if (_isSharedAccountsNotSupported(second.code, second.msg)) {
						_disableSharedAccounts(second.msg || second.code);
					}
					if (_isRouteDead(second.code) || _isRouteDead(second.msg)) {
						throw new Error(String(second.code || "NO_ROUTE"));
					}
				} else {
					log("Primary swap NOT_SUPPORTED. Skipping shared-accounts fallback.");
				}
			} else {
				if (canTryShared()) {
					log("Primary swap failed. Fallback: shared accounts …");
					const fallback = await buildAndSend(true);
					if (fallback.ok) {
						await notePendingBuySeed();
						await seedCacheIfBuy();
						return fallback.sig;
					}
					noteLastErr(fallback);
					if (_isSharedAccountsNotSupported(fallback.code, fallback.msg)) {
						_disableSharedAccounts(fallback.msg || fallback.code);
					}
					if (_isRouteDead(fallback.code) || _isRouteDead(fallback.msg)) {
						throw new Error(String(fallback.code || "NO_ROUTE"));
					}
				} else {
					log("Primary swap failed. Skipping shared-accounts fallback (disabled).", "warn");
				}
			}

			if (isSell && /ROUTER_DUST|NO_ROUTE/i.test(String(lastErrCode || ""))) {
				try {
					const slip2 = 2000;
					const rFlag = restrictAllowed ? "false" : "true";
					quoteIncludesFee = false;
					feeAccount = null;
					const q2 = buildQuoteUrl({ outMint: outputMint, slipBps: slip2, restrict: rFlag, withFee: false });
					log(`Dust/route fallback: slip=${slip2} bps, no fee, relaxed route …`);
					const r2 = await jupFetch(q2.pathname + q2.search);
					if (r2.ok) {
						quote = await r2.json();
						const a = await buildAndSend(false, true);
						if (a.ok) {
							await seedCacheIfBuy();
							return a.sig;
						}
						noteLastErr(a);
						if (canTryShared()) {
							const b = await buildAndSend(true, true);
							if (b.ok) {
								await seedCacheIfBuy();
								return b.sig;
							}
							noteLastErr(b);
							if (_isSharedAccountsNotSupported(b.code, b.msg)) {
								_disableSharedAccounts(b.msg || b.code);
							}
						}
					}
				} catch {}
			}

			// If we still have a route/dust failure, do not spam expensive manual paths.
			if (_isRouteDead(lastErrCode)) {
				throw new Error(String(lastErrCode || "NO_ROUTE"));
			}

			// Some RPCs cannot send/accept v0 transactions reliably; try legacy before manual paths.
			if (/NEED_LEGACY|UNSUPPORTED_VERSION|TX_TOO_LARGE|BLOCKHASH|NODE_BEHIND|RPC_LIMIT|RPC_TIMEOUT|SEND_FAIL/i.test(String(lastErrCode || ""))) {
				try {
					if (/NEED_LEGACY|UNSUPPORTED_VERSION/i.test(String(lastErrCode || ""))) {
						log("Send failed; retrying as legacy transaction …", "warn");
						const lx = await buildAndSend(false, true);
						if (lx.ok) {
							await notePendingBuySeed();
							await seedCacheIfBuy();
							return lx.sig;
						}
						noteLastErr(lx);
					}
				} catch {}
			}

			{
				const manualSeq = canTryShared()
					? [() => manualBuildAndSend(false), () => manualBuildAndSend(true)]
					: [() => manualBuildAndSend(false)];
				for (const t of manualSeq) {
					try {
						const r = await t();
						if (r?.ok) {
							await notePendingBuySeed();
							await seedCacheIfBuy();
							return r.sig;
						}
						noteLastErr(r);
					} catch {}
				}
			}

			{
				log("Swap API failed - trying manual build/sign …");
				const tries = canTryShared()
					? [() => manualBuildAndSend(false), () => manualBuildAndSend(true)]
					: [() => manualBuildAndSend(false)];
				for (const t of tries) {
					try {
						const r = await t();
						if (r?.ok) {
							await notePendingBuySeed();
							await seedCacheIfBuy();
							return r.sig;
						}
						noteLastErr(r);
					} catch {}
				}
			}

			if (isSell) {
				try {
					const slip2 = 2000;
					const rFlag = restrictAllowed ? "false" : "true";
					const q2 = buildQuoteUrl({ outMint: outputMint, slipBps: slip2, restrict: rFlag, withFee: !!(feeAccount && appliedFeeBps > 0) });
					log(`Tiny-notional fallback: relax route, slip=${slip2} bps …`);
					const r2 = await jupFetch(q2.pathname + q2.search);
					if (r2.ok) {
						quote = await r2.json();
						const a = await buildAndSend(false, true);
						if (a.ok) {
							await seedCacheIfBuy();
							return a.sig;
						}
						if (!a.ok) lastErrCode = a.code || lastErrCode;
						const b = await buildAndSend(true, true);
						if (b.ok) {
							await seedCacheIfBuy();
							return b.sig;
						}
						if (!b.ok) lastErrCode = b.code || lastErrCode;
					}
				} catch {}

				try {
					const a = await buildAndSend(false, true);
					if (a.ok) {
						await seedCacheIfBuy();
						return a.sig;
					}
					const b = await buildAndSend(true);
					if (b.ok) {
						await seedCacheIfBuy();
						return b.sig;
					}
				} catch {}

				try {
					const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
					if (!state.USDCfallbackEnabled) {
						log("USDC fallback disabled; aborting expensive fallback attempt.");
						throw new Error("USDC_FALLBACK_DISABLED");
					}
					const slip3 = 2000;
					const rFlag = restrictAllowed ? "false" : "true";
					const q3 = buildQuoteUrl({ outMint: USDC, slipBps: slip3, restrict: rFlag });
					log("Strict fallback: route to USDC, then dump USDC->SOL …");
					const r3 = await jupFetch(q3.pathname + q3.search);
					if (r3.ok) {
						quote = await r3.json();
						const sendFns = [() => buildAndSend(false), () => buildAndSend(true), () => manualBuildAndSend(false), () => manualBuildAndSend(true)];
						for (const send of sendFns) {
							try {
								const r = await send();
								if (r?.ok) {
									const sig1 = r.sig;
									try { await safeConfirmSig(sig1, { commitment: "confirmed", timeoutMs: 12000 }); } catch {}
											try { await waitForTokenCreditInternal(userPub, USDC, { timeoutMs: 12000, pollMs: 300 }); } catch {}
									let usdcUi = 0;
									try {
												const b = await getAtaBalanceUiInternal(userPub, USDC, 6);
										usdcUi = Number(b?.sizeUi || 0);
									} catch {}
									if (usdcUi > 0) {
										const back = await executeSwapWithConfirm?.({ signer, inputMint: USDC, outputMint: SOL_MINT, amountUi: usdcUi, slippageBps: state.slippageBps }, { retries: 1, confirmMs: 15000 });
										if (back?.ok) return back.sig;
										log("USDC->SOL dump failed after fallback; keeping USDC.");
									}
									return sig1;
								} else if (r && !r.ok) {
									lastErrCode = r.code || lastErrCode;
								}
							} catch {}
						}
					}
				} catch {}

				try {
					const slipSplit = 2000;
					for (const f of SPLIT_FRACTIONS || []) {
						const partRaw = Math.max(1, Math.floor(amountRaw * f));
						if (partRaw <= 0) continue;

						const restrictOptions = restrictAllowed ? ["false", "true"] : ["true"];
						for (const restrict of restrictOptions) {
							const qP = buildQuoteUrl({ outMint: outputMint, slipBps: slipSplit, restrict, amountOverrideRaw: partRaw, withFee: false });
							log(`Split-sell quote f=${f} restrict=${restrict} slip=${slipSplit}…`);
							const rP = await jupFetch(qP.pathname + qP.search);
							if (!rP.ok) continue;

							const quotePart = await rP.json();
							const outPartRaw = Number(quotePart?.outAmount || 0);
							const outPartSol = outPartRaw / 1e9;
							if (!Number.isFinite(outPartSol) || outPartSol < MIN_SELL_CHUNK_SOL) {
								log(`Split f=${f} est out ${outPartSol.toFixed(6)} SOL < ${MIN_SELL_CHUNK_SOL}; skipping this chunk.`);
								continue;
							}

							let chunkFeeAccount = null;
							const prevAppliedFeeBps = appliedFeeBps;
							if (baseFeeBps > 0 && feeDestCandidate) {
								try {
									const ts = now();
									const decIn = Number.isFinite(inDecimals) ? inDecimals : (_decHint ?? 6);
									const pos = state?.positions?.[inputMint];
									const prevSizeUi = _preSplitUi > 0 ? _preSplitUi : Number(pos?.sizeUi || 0);
									const soldUi = partRaw / Math.pow(10, decIn);
									const costSoldSol = prevSizeUi > 0
										? Number(pos?.costSol || 0) * Math.min(1, Math.max(0, soldUi / Math.max(1e-9, prevSizeUi)))
										: Number(pos?.costSol || 0);
									appliedFeeBps = _computeDynamicPlatformFeeBps({
										state,
										baseFeeBps,
										nowTs: ts,
										estOutLamports: outPartRaw,
										costSoldSol,
									});

									if (appliedFeeBps > 0) {
										const profitableChunkNoFee = shouldAttachFeeForSell?.({
											mint: inputMint,
											amountRaw: partRaw,
											inDecimals: decIn,
											quoteOutLamports: outPartRaw,
										});
										if (profitableChunkNoFee) {
											const qPFee = buildQuoteUrl({ outMint: outputMint, slipBps: slipSplit, restrict, amountOverrideRaw: partRaw, withFee: true });
											const rPFee = await jupFetch(qPFee.pathname + qPFee.search);
											if (rPFee.ok) {
												const quotePartWithFee = await rPFee.json();
												const outPartRawWithFee = Number(quotePartWithFee?.outAmount || 0);
												const stillProfChunk = shouldAttachFeeForSell?.({
													mint: inputMint,
													amountRaw: partRaw,
													inDecimals: decIn,
													quoteOutLamports: outPartRawWithFee,
												});
												if (stillProfChunk) {
													quote = quotePartWithFee;
													chunkFeeAccount = feeDestCandidate;
													log(`Split-sell fee enabled @ ${appliedFeeBps} bps (base ${Math.floor(baseFeeBps)}) for f=${f}.`);
												} else {
													quote = quotePart;
													chunkFeeAccount = null;
													log(`Split-sell fee suppressed (removes profit) for f=${f}.`);
												}
											} else {
												quote = quotePart;
												chunkFeeAccount = null;
												log("Split-sell fee quote failed; proceeding without fee.");
											}
										} else {
											quote = quotePart;
											chunkFeeAccount = null;
											log("Split-sell no estimated profit; fee disabled for this chunk.");
										}
									} else {
										quote = quotePart;
										chunkFeeAccount = null;
										log(`Split-sell dynamic fee computed as 0 bps for f=${f}; fee disabled.`);
									}
								} catch {
									quote = quotePart;
									chunkFeeAccount = null;
									log("Split-sell profit check failed; fee disabled for this chunk.");
								}
							} else {
								quote = quotePart;
							}

							const prevFeeAccount = feeAccount;
							feeAccount = chunkFeeAccount;

							const tries = [
								() => buildAndSend(false, false),
								() => buildAndSend(true, false),
								() => buildAndSend(false, true),
								() => buildAndSend(true, true),
							];
							for (const t of tries) {
								try {
									const res = await t();
									if (res?.ok) {
										log(`Split-sell succeeded at ${Math.round(f * 100)}% of position.`);
										try {
											setMintBlacklist?.(inputMint, MINT_RUG_BLACKLIST_MS);
											log(`Split-sell: blacklisted ${inputMint.slice(0, 4)}… for 30m.`);
										} catch {}

										try {
											if (isSell) {
												const dec = Number.isFinite(_decHint) ? _decHint : (Number.isFinite(inDecimals) ? inDecimals : 6);
												const prevSize = _preSplitUi > 0 ? _preSplitUi : (state.positions?.[inputMint]?.sizeUi || 0);
												const soldUi = partRaw / Math.pow(10, dec);
												let remainUi = Math.max(0, prevSize - soldUi);

												if (!Number.isFinite(remainUi) || remainUi < 1e-12) remainUi = 0;
												if (remainUi <= 1e-9) {
													try { removeFromPosCache?.(userPub, inputMint); } catch {}
													if (state.positions && state.positions[inputMint]) {
														delete state.positions[inputMint];
														save?.();
													}
													log(`Split-sell cleared position for ${inputMint.slice(0, 4)}… locally.`);
												} else {
													const estRemainSol = await quoteOutSol?.(inputMint, remainUi, dec).catch(() => 0);
													const minN = minSellNotionalSol?.();
													if (estRemainSol >= minN) {
														const basePrev = prevSize > 0 ? prevSize : (state.positions?.[inputMint]?.sizeUi || remainUi);
														const frac = basePrev > 0 ? Math.min(1, Math.max(0, remainUi / Math.max(1e-9, basePrev))) : 1;
														const pos = state.positions?.[inputMint] || { costSol: 0, hwmSol: 0, acquiredAt: now() };
														pos.sizeUi = remainUi;
														pos.decimals = dec;
														pos.costSol = Number(pos.costSol || 0) * frac;
														pos.hwmSol = Number(pos.hwmSol || 0) * frac;
														pos.lastSellAt = now();
														state.positions[inputMint] = pos;
														updatePosCache?.(userPub, inputMint, remainUi, dec);
														save?.();
														log(`Split-sell remainder kept: ${remainUi.toFixed(6)} ${inputMint.slice(0, 4)}…`);
													} else {
														try { addToDustCache?.(userPub, inputMint, remainUi, dec); } catch {}
														try { removeFromPosCache?.(userPub, inputMint); } catch {}
														if (state.positions && state.positions[inputMint]) {
															delete state.positions[inputMint];
															save?.();
														}
														log(`Split-sell remainder below notional; moved to dust cache (${remainUi.toFixed(6)}).`);
													}
												}
											}
										} catch {}

										return res.sig;
									}
								} catch {}
							}

							feeAccount = prevFeeAccount;
							appliedFeeBps = prevAppliedFeeBps;
						}
					}
				} catch (e) {
					log(`Split-sell fallback error: ${e.message || e}`, "err");
				}
			}

			if (lastErrCode && lastErrMsg) throw new Error(`${lastErrCode}: ${_shortErr(lastErrMsg, 240)}`);
			if (lastErrCode) throw new Error(String(lastErrCode));
			if (lastErrMsg) throw new Error(_shortErr(lastErrMsg, 240));
			throw new Error("swap failed");
		}
	}

	async function executeSwapWithConfirm(opts, { retries = 2, confirmMs = 15000 } = {}) {
		const fastConfirm = !!opts?.fastConfirm;
		const totalAttemptMs = fastConfirm
			? Math.max(18_000, Number(confirmMs || 0) + 5_000)
			: Math.max(30_000, Number(confirmMs || 0) + 55_000);
		let slip = Math.max(150, Number(opts.slippageBps ?? getState().slippageBps ?? 150) | 0);
		const isBuy = (opts?.inputMint === SOL_MINT && opts?.outputMint && opts.outputMint !== SOL_MINT);
		const minConfirmMs = isBuy ? 32_000 : 15_000;
		if (isBuy) slip = Math.min(300, Math.max(200, slip));

		const prevDefer = !!window._fdvDeferSeed;
		window._fdvDeferSeed = true;
		let lastSig = null;
		try {
			const needFinal = false;
			for (let attempt = 0; attempt <= retries; attempt++) {
				try {
					const sig = await withTimeout(
						jupSwapWithKeypair({ ...opts, slippageBps: slip }),
						totalAttemptMs,
						{ label: "swapAttempt" },
					);
					lastSig = sig;

					if (fastConfirm) {
						const out = { ok: false, sig, slip, fast: true };
						try { noteLedgerSwap({ signer: opts?.signer, inputMint: opts?.inputMint, outputMint: opts?.outputMint, amountUi: opts?.amountUi, slippageBps: slip, res: out, stage: "fast" }); } catch {}
						return out;
					}

					if (isBuy) {
						try {
							const ownerStr = opts?.signer?.publicKey?.toBase58?.();
							if (ownerStr) {
								const s = getBuySeed?.(ownerStr, opts.outputMint);
								if (s && Number(s.sizeUi || 0) > 0) {
									try { clearBuySeed?.(ownerStr, opts.outputMint); } catch {}
								}
							}
						} catch {}
					}

					const ok = await safeConfirmSig(sig, {
						commitment: "confirmed",
						timeoutMs: Math.max(Number(confirmMs || 0), minConfirmMs),
						requireFinalized: needFinal,
					}).catch(() => false);
					if (ok) {
						try {
							const meta = _takeReferralPayout(sig);
							if (meta?.ref && meta?.lamports && opts?.signer) {
								log(`Referral payout: sending ${(Number(meta.lamports || 0) / 1e9).toFixed(6)} SOL to ${String(meta.ref).slice(0, 4)}… (1% of profit≈${Number(meta.profitSol || 0).toFixed(6)} SOL)`);
								const r = await withTimeout(
									_sendReferralLamports({ signer: opts.signer, to: meta.ref, lamports: meta.lamports }),
									22_000,
									{ label: "referralPayout" },
								).catch(() => null);
								if (r?.ok) log(`Referral payout sent: ${String(r.sig || "").slice(0, 12)}…`);
								else if (r?.skipped) log(`Referral payout skipped (${r.msg || "skip"}).`, "warn");
								else log(`Referral payout failed (${r?.msg || "error"}).`, "warn");
							}
						} catch {}
						const out = { ok: true, sig, slip };
						try { noteLedgerSwap({ signer: opts?.signer, inputMint: opts?.inputMint, outputMint: opts?.outputMint, amountUi: opts?.amountUi, slippageBps: slip, res: out, stage: "confirmed" }); } catch {}
						return out;
					}

					if (isBuy) {
						log("Buy sent; skipping retries and relying on pending credit.");
						const out = { ok: false, sig, slip };
						try { noteLedgerSwap({ signer: opts?.signer, inputMint: opts?.inputMint, outputMint: opts?.outputMint, amountUi: opts?.amountUi, slippageBps: slip, res: out, stage: "unconfirmed" }); } catch {}
						return out;
					}
				} catch (e) {
					const msg = String(e?.message || e || "");
					if (/swapAttempt_TIMEOUT_/i.test(msg) || /sendRawTransaction_TIMEOUT_/i.test(msg)) {
						log(`Swap attempt ${attempt + 1} stalled; retrying (${msg})`);
					}
					const isNoRoute = _isNoRouteLike(msg);
					const isInsufficient = _isInsufficientLamportsLike(msg);
					if (!isNoRoute) {
						_throttledLog(
							`swapAttempt:${opts?.inputMint}->${opts?.outputMint}`,
							`Swap attempt ${attempt + 1} failed: ${msg}`,
							6000,
							"warn",
						);
					}
					if (isInsufficient) {
						const out = { ok: false, insufficient: true, msg, sig: lastSig };
						try { noteLedgerSwap({ signer: opts?.signer, inputMint: opts?.inputMint, outputMint: opts?.outputMint, amountUi: opts?.amountUi, slippageBps: slip, res: out, stage: "insufficient" }); } catch {}
						return out;
					}
					if (isNoRoute) {
						if (opts?.inputMint && opts?.outputMint === SOL_MINT && opts.inputMint !== SOL_MINT) {
							setRouterHold?.(opts.inputMint, ROUTER_COOLDOWN_MS);
						}
						const out = { ok: false, noRoute: true, msg, sig: lastSig };
						try { noteLedgerSwap({ signer: opts?.signer, inputMint: opts?.inputMint, outputMint: opts?.outputMint, amountUi: opts?.amountUi, slippageBps: slip, res: out, stage: "no_route" }); } catch {}
						return out;
					}
				}
				slip = Math.min(2000, Math.floor(slip * 1.6));
				log(`Swap not confirmed; retrying with slippage=${slip} bps…`);
			}
			const out = { ok: false, sig: lastSig };
			try { noteLedgerSwap({ signer: opts?.signer, inputMint: opts?.inputMint, outputMint: opts?.outputMint, amountUi: opts?.amountUi, slippageBps: slip, res: out, stage: "not_confirmed" }); } catch {}
			return out;
		} finally {
			window._fdvDeferSeed = prevDefer;
		}
	}

	async function closeEmptyTokenAtas(signer, mint, { allowSolMint = false } = {}) {
		try {
			const { Transaction, TransactionInstruction } = await loadWeb3();
			const conn = await getConn();
			const { createCloseAccountInstruction } = await loadSplToken();

			const ownerPk = signer.publicKey;
			const owner = ownerPk.toBase58();

			if (!mint) return false;
			if (mint === SOL_MINT && !allowSolMint) return false;
			if (rpcBackoffLeft?.() > 0) {
				log("Backoff active; deferring per-mint ATA close.");
				return false;
			}

			const atas = await getOwnerAtas?.(owner, mint);
			if (!atas?.length) return false;

			const infos = await _getMultipleAccountsInfoBatched?.(conn, atas.map((a) => a.ata), {
				commitment: "processed",
				batchSize: 95,
				kind: "gmai-close-one",
			});

			const ixs = [];
			for (let i = 0; i < atas.length; i++) {
				const { ata, programId } = atas[i];
				const ai = infos?.[i];
				if (!ai || !ai.data) continue;

				const raw =
					ai.data instanceof Uint8Array
						? ai.data
						: (Array.isArray(ai.data?.data) && typeof ai.data?.data[0] === "string")
							? Uint8Array.from(atob(ai.data.data[0]), (c) => c.charCodeAt(0))
							: new Uint8Array();

				const amt = _readSplAmountFromRaw?.(raw);
				if (amt === null || amt > 0n) continue;

				if (typeof createCloseAccountInstruction === "function") {
					ixs.push(createCloseAccountInstruction(ata, ownerPk, ownerPk, [], programId));
				} else {
					ixs.push(
						new TransactionInstruction({
							programId,
							keys: [
								{ pubkey: ata, isSigner: false, isWritable: true },
								{ pubkey: ownerPk, isSigner: false, isWritable: true },
								{ pubkey: ownerPk, isSigner: true, isWritable: false },
							],
							data: Uint8Array.of(9),
						})
					);
				}
			}

			if (!ixs.length) return false;

			let rentLamports = 2_039_280;
			try { rentLamports = await conn.getMinimumBalanceForRentExemption(165); } catch {}
			const reclaimedLamportsEst = Math.max(0, (ixs.length | 0)) * Math.max(0, Math.floor(Number(rentLamports || 0)));

			const tx = new Transaction();
			for (const ix of ixs) tx.add(ix);
			tx.feePayer = ownerPk;
			tx.recentBlockhash = (await conn.getLatestBlockhash("processed")).blockhash;
			tx.sign(signer);
			const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "processed", maxRetries: 2 });
			log(`Closed empty ATAs for ${mint.slice(0, 4)}…: ${sig}`);
			return { ok: true, sig, closedCount: (ixs.length | 0), reclaimedLamportsEst };
		} catch {
			return false;
		}
	}

	async function closeAllEmptyAtas(signer) {
		try {
			const state = getState();
			if (!signer?.publicKey) return false;
			if (rpcBackoffLeft?.() > 0) {
				log("Backoff active; deferring global ATA close.");
				return false;
			}

			const { Transaction, TransactionInstruction } = await loadWeb3();
			const conn = await getConn();
			const { createCloseAccountInstruction } = await loadSplToken();

			const ownerPk = signer.publicKey;
			const owner = ownerPk.toBase58();

			const mintSet = new Set();
			for (const m of Object.keys(state.positions || {})) {
				if (m && m !== SOL_MINT) mintSet.add(m);
			}

			try {
				const cached = cacheToList?.(owner) || [];
				for (const it of cached) {
					if (it?.mint && it.mint !== SOL_MINT) mintSet.add(it.mint);
				}
			} catch {}

			try {
				const dust = dustCacheToList?.(owner) || [];
				for (const it of dust) {
					if (it?.mint && it.mint !== SOL_MINT) mintSet.add(it.mint);
				}
			} catch {}

			mintSet.add(SOL_MINT);

			const atas = [];
			const seenAtas = new Set();
			for (const mint of mintSet) {
				try {
					const recs = await getOwnerAtas?.(owner, mint);
					for (const { ata, programId } of recs || []) {
						const k = `${programId?.toBase58?.() || String(programId)}:${ata.toBase58()}`;
						if (!seenAtas.has(k)) {
							seenAtas.add(k);
							atas.push({ ata, programId });
						}
					}
				} catch {}
			}
			if (!atas.length) return false;

			const infos = await _getMultipleAccountsInfoBatched?.(conn, atas.map((a) => a.ata), {
				commitment: "processed",
				batchSize: 95,
				kind: "gmai-close-all",
			});

			const closeIxs = [];
			for (let i = 0; i < atas.length; i++) {
				const { ata, programId } = atas[i];
				const ai = infos?.[i];
				if (!ai || !ai.data) continue;

				const raw =
					ai.data instanceof Uint8Array
						? ai.data
						: (Array.isArray(ai.data?.data) && typeof ai.data?.data[0] === "string")
							? Uint8Array.from(atob(ai.data.data[0]), (c) => c.charCodeAt(0))
							: new Uint8Array();

				const amt = _readSplAmountFromRaw?.(raw);
				if (amt === null || amt > 0n) continue;

				if (typeof createCloseAccountInstruction === "function") {
					closeIxs.push(createCloseAccountInstruction(ata, ownerPk, ownerPk, [], programId));
				} else {
					closeIxs.push(
						new TransactionInstruction({
							programId,
							keys: [
								{ pubkey: ata, isSigner: false, isWritable: true },
								{ pubkey: ownerPk, isSigner: false, isWritable: true },
								{ pubkey: ownerPk, isSigner: true, isWritable: false },
							],
							data: Uint8Array.of(9),
						})
					);
				}
			}
			if (!closeIxs.length) return false;

			const BATCH = 8;
			const sigs = [];
			for (let i = 0; i < closeIxs.length; i += BATCH) {
				const slice = closeIxs.slice(i, i + BATCH);
				try {
					await rpcWait?.("tx-close", 350);
					const tx = new Transaction();
					for (const ix of slice) tx.add(ix);
					tx.feePayer = ownerPk;
					tx.recentBlockhash = (await conn.getLatestBlockhash("processed")).blockhash;
					tx.sign(signer);
					const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "processed", maxRetries: 2 });
					sigs.push(sig);
					await new Promise((r) => setTimeout(r, 120));
				} catch (e) {
					markRpcStress?.(e, 2000);
					log(`Close-ATAs batch failed: ${e.message || e}`);
				}
			}

			if (sigs.length > 0) {
				log(`Closed ${closeIxs.length} empty ATAs (known set) in ${sigs.length} tx(s): ${sigs.join(", ")}`);
				return true;
			}
			return false;
		} catch (e) {
			log(`Close-empty-ATAs failed: ${e.message || e}`);
			return false;
		}
	}

	async function buyWithConfirm(
		{ signer, mint, solUi, slippageBps },
		{ retries = 1, confirmMs = 45_000, closeWsolAta = true, fastConfirm = false } = {},
	) {
		const res = await executeSwapWithConfirm(
			{ signer, inputMint: SOL_MINT, outputMint: mint, amountUi: solUi, slippageBps, fastConfirm: !!fastConfirm },
			{ retries, confirmMs },
		);
		if (res?.ok && closeWsolAta) {
			try { await closeEmptyTokenAtas(signer, SOL_MINT, { allowSolMint: true }); } catch {}
		}
		return res;
	}

	async function sellWithConfirm(
		{ signer, mint, amountUi, slippageBps },
		{ retries = 1, confirmMs = 30_000, closeTokenAta = true, closeWsolAta = true, fastConfirm = false } = {},
	) {
		let effAmountUi = Number(amountUi || 0);
		let balanceUi = null;
		try {
			const owner = signer?.publicKey?.toBase58?.();
			if (owner && mint) {
				const b = await getAtaBalanceUiInternal(owner, mint);
				balanceUi = Number(b?.sizeUi || 0);
				if (!Number.isFinite(balanceUi)) balanceUi = 0;
				if (!Number.isFinite(effAmountUi)) effAmountUi = 0;
				if (balanceUi <= 0) {
					if (closeTokenAta) {
						try { await closeEmptyTokenAtas(signer, mint); } catch {}
					}
					if (closeWsolAta) {
						try { await closeEmptyTokenAtas(signer, SOL_MINT, { allowSolMint: true }); } catch {}
					}
					return { ok: false, noBalance: true, balanceUi: 0, msg: "NO_BALANCE" };
				}
				// Guard against stale cache: never try to sell more than is actually held.
				if (effAmountUi <= 0) effAmountUi = balanceUi;
				if (effAmountUi > balanceUi * 1.000001) {
					_throttledLog(
						`sell:clamp:${mint}`,
						`Sell amount clamped to on-chain balance (${effAmountUi.toFixed(6)} -> ${balanceUi.toFixed(6)}) for ${String(mint).slice(0, 4)}…`,
						15_000,
						"warn",
					);
					effAmountUi = balanceUi;
				}
			}
		} catch {}

		let res;
		try {
			res = await executeSwapWithConfirm(
				{ signer, inputMint: mint, outputMint: SOL_MINT, amountUi: effAmountUi, slippageBps, fastConfirm: !!fastConfirm },
				{ retries, confirmMs },
			);
			if (res?.ok && closeTokenAta) {
				try { await closeEmptyTokenAtas(signer, mint); } catch {}
				// Debits can settle after the swap reaches confirmation; retry shortly after.
				try { setTimeout(() => { closeEmptyTokenAtas(signer, mint).catch(() => {}); }, 1400); } catch {}
			}
			return res;
		} finally {
			// Always best-effort cleanup for wSOL ATA, even if swap failed after creating it.
			if (closeWsolAta) {
				try { await closeEmptyTokenAtas(signer, SOL_MINT, { allowSolMint: true }); } catch {}
				try { setTimeout(() => { closeEmptyTokenAtas(signer, SOL_MINT, { allowSolMint: true }).catch(() => {}); }, 1400); } catch {}
			}
		}
	}

	return {
		processPendingCredits: async () => {
			try { return await processPendingCredits?.(); } catch { return 0; }
		},
		syncPositionsFromChain: async (ownerPubkeyStr) => {
			try { return await syncPositionsFromChain?.(ownerPubkeyStr); } catch { return null; }
		},
		getOwnerAtas: getOwnerAtasInternal,
		ataExists: ataExistsInternal,
		getAtaBalanceUi: getAtaBalanceUiInternal,
		waitForTokenCredit: waitForTokenCreditInternal,
		waitForTokenCreditIncrease: waitForTokenCreditIncreaseInternal,
		waitForTokenDebit: waitForTokenDebitInternal,

		getJupBase,
		getMintDecimals,
		jupFetch,
		quoteGeneric,
		jupSwapWithKeypair,
		executeSwapWithConfirm,
		closeEmptyTokenAtas,
		closeAllEmptyAtas,
		buyWithConfirm,
		sellWithConfirm,
	};
}