export function createDex(deps = {}) {
	const {
		// Constants
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

		// Core utilities
		now = () => Date.now(),
		log = () => {},
		logObj = () => {},
		getState = () => ({}),

		// RPC / deps
		getConn,
		loadWeb3,
		loadSplToken,
		rpcWait,
		rpcBackoffLeft,
		markRpcStress,

		// Mint helpers
		getCfg,
		isValidPubkeyStr,

		// Fee + rent helpers
		getPlatformFeeBps,
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

	async function getJupBase() {
		const cfg = (typeof getCfg === "function") ? await getCfg() : (typeof getCfg === "object" ? getCfg : {});
		return String(cfg?.jupiterBase || "https://lite-api.jup.ag").replace(/\/+$/, "");
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
			const info = await conn.getParsedAccountInfo(new PublicKey(mintStr), "processed");
			const d = Number(info?.value?.data?.parsed?.info?.decimals);
			return Number.isFinite(d) ? d : 6;
		} catch {
			return 6;
		}
	}

	async function jupFetch(path, opts) {
		const base = await getJupBase();
		const url = `${base}${path}`;
		const isGet = !opts || String(opts.method || "GET").toUpperCase() === "GET";
		const isQuote = isGet && /\/quote(\?|$)/.test(path);

		const nowTs = Date.now();
		const minGapMs = isQuote ? 450 : 150;
		if (!window._fdvJupLastCall) window._fdvJupLastCall = 0;
		const stressLeft = Math.max(0, (window._fdvJupStressUntil || 0) - nowTs);
		const waitMs =
			Math.max(0, window._fdvJupLastCall + minGapMs - nowTs) +
			(isQuote ? Math.floor(Math.random() * 200) : 0) +
			Math.min(2000, stressLeft);
		if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
		window._fdvJupLastCall = Date.now();

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
				const res = await fetch(url, {
					headers: { accept: "application/json", ...(opts?.headers || {}) },
					...opts,
				});
				lastRes = res;

				if (res.ok && isQuote) {
					try {
						const json = await res.clone().json();
						if (!window._fdvJupQuoteCache) window._fdvJupQuoteCache = new Map();
						window._fdvJupQuoteCache.set(url, { ts: Date.now(), json });
					} catch {}
				}

				if (res.status !== 429) {
					if (!res.ok && isQuote && res.status === 400) {
						try {
							lastBody = await res.clone().text();
						} catch {}
						if (/rate limit exceeded/i.test(lastBody)) {
							const backoff = 600 * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
							log(`JUP 400(rate-limit): backing off ${backoff}ms`);
							window._fdvJupStressUntil = Date.now() + 20_000;
							await new Promise((r) => setTimeout(r, backoff));
							continue;
						}
					}
					return res;
				}

				const backoff = 600 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
				log(`JUP 429: backing off ${backoff}ms`);
				window._fdvJupStressUntil = Date.now() + 20_000;
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

		const { PublicKey, VersionedTransaction } = await loadWeb3();
		const conn = await getConn();
		const userPub = signer.publicKey.toBase58();
		const feeBps = Number((typeof getPlatformFeeBps === "function" ? getPlatformFeeBps() : 0) || 0);
		let feeAccount = null;
		let lastErrCode = "";

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

		let _preSplitUi = 0;
		let _decHint = await getMintDecimals(inputMint).catch(() => 6);
		if (isSell) {
			try {
				const b0 = await getAtaBalanceUi?.(userPub, inputMint, _decHint);
				_preSplitUi = Number(b0?.sizeUi || 0);
				if (Number.isFinite(b0?.decimals)) _decHint = b0.decimals;
			} catch {}
		}

		if (isBuy) {
			const rentSol = (_preBuyRent / 1e9).toFixed(6);
			log(`Buy cost breakdown: input=${(amountRaw / 1e9).toFixed(6)} SOL + ataRent≈${rentSol}`);
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
				await confirmSig?.(sig, { commitment: "confirmed", timeoutMs: 15000 }).catch(() => {});
				let remainUi = 0,
					d = _decHint;
				try {
					const b1 = await getAtaBalanceUi?.(userPub, inputMint, d);
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
			if (withFee && feeBps > 0 && feeAccount) u.searchParams.set("platformFeeBps", String(feeBps));
			if (asLegacy) u.searchParams.set("asLegacyTransaction", "true");
			return u;
		}

		let feeDestCandidate = null;
		if (feeBps > 0 && isSell) {
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
			feeBps: 0,
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
			if (inputMint === SOL_MINT && outputMint !== SOL_MINT) {
				try {
					const balL = await conn.getBalance(signer.publicKey, "processed");
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
						withFee: !!(feeAccount && feeBps > 0),
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
				useSharedAccounts: !!useSharedAccounts,
				asLegacyTransaction: !!asLegacy,
				...(feeAccount && feeBps > 0 ? { feeAccount, platformFeeBps: feeBps } : {}),
			};

			try {
				const { cuPriceMicroLamports } = await getComputeBudgetConfig?.();
				if (Number(cuPriceMicroLamports) > 0) {
					body.computeUnitPriceMicroLamports = Math.floor(Number(cuPriceMicroLamports));
				}
			} catch {}

			logObj("Swap body", { hasFee: !!feeAccount, feeBps: feeAccount ? feeBps : 0, useSharedAccounts: !!useSharedAccounts, asLegacy: !!asLegacy });

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
					return { ok: false, code: j?.errorCode || "", msg: j?.error || `swap ${sRes.status}` };
				} catch {
					return { ok: false, code: "", msg: `swap ${sRes.status}` };
				}
			}

			const { swapTransaction } = await sRes.json();
			if (!swapTransaction) return { ok: false, code: "NO_SWAP_TX", msg: "no swapTransaction" };

			const raw = atob(swapTransaction);
			const rawBytes = new Uint8Array(raw.length);
			for (let i=0; i<raw.length; i++) rawBytes[i] = raw.charCodeAt(i);
			const vtx = VersionedTransaction.deserialize(rawBytes);
			vtx.sign([signer]);
			try {
				const sig = await conn.sendRawTransaction(vtx.serialize(), { preflightCommitment: "processed", maxRetries: 3 });
				log(`Swap sent: ${sig}`);
				try { log(`Explorer: https://solscan.io/tx/${sig}`); } catch {}
				try { if (isSell) setTimeout(() => _reconcileSplitSellRemainder(sig), 0); } catch {}
				try {
					if (inputMint === SOL_MINT || outputMint === SOL_MINT) {
						setTimeout(() => { unwrapWsolIfAny?.(signer).catch(()=>{}); }, 1200);
						setTimeout(() => { unwrapWsolIfAny?.(signer).catch(()=>{}); }, 1500);
					}
				} catch {}
				return { ok: true, sig };
			} catch (e) {
				log(`Swap send failed. NO_ROUTES/ROUTER_DUST. export help/wallet.json to recover dust funds. Simulating…`);
				try {
					const sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
					const logs = sim?.value?.logs || e?.logs || [];
					const txt = (logs || []).join(" ");
					const hasDustErr = /0x1788|0x1789/i.test(txt);
					const hasSlipErr = /0x1771/i.test(txt);
					return { ok: false, code: hasDustErr ? "ROUTER_DUST" : (hasSlipErr ? "SLIPPAGE" : "SEND_FAIL"), msg: e.message || String(e) };
				} catch {
					return { ok: false, code: "SEND_FAIL", msg: e.message || String(e) };
				}
			}
		}

		async function manualBuildAndSend(useSharedAccounts = true) {
			const { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } = await loadWeb3();
			try {
				const body = {
					quoteResponse: quote,
					userPublicKey: signer.publicKey.toBase58(),
					wrapAndUnwrapSol: true,
					dynamicComputeUnitLimit: true,
					useSharedAccounts: !!useSharedAccounts,
					asLegacyTransaction: false,
					...(feeAccount && feeBps > 0 ? { feeAccount, platformFeeBps: feeBps } : {}),
				};
				try {
					const { cuPriceMicroLamports } = await getComputeBudgetConfig?.();
					if (Number(cuPriceMicroLamports) > 0) {
						body.computeUnitPriceMicroLamports = Math.floor(Number(cuPriceMicroLamports));
					}
				} catch {}
				log(`Swap-instructions request (manual send) … hasFee=${!!feeAccount}, useSharedAccounts=${!!useSharedAccounts}`);

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
						const lut = await conn.getAddressLookupTable(new PublicKey(addr));
						if (lut?.value) lookups.push(lut.value);
					} catch {}
				}

				const { blockhash } = await conn.getLatestBlockhash("confirmed");
				const msg = new TransactionMessage({
					payerKey: signer.publicKey,
					recentBlockhash: blockhash,
					instructions: ixs,
				}).compileToV0Message(lookups);

				const vtx = new VersionedTransaction(msg);
				vtx.sign([signer]);

				try {
					const sig = await conn.sendRawTransaction(vtx.serialize(), {
						preflightCommitment: "confirmed",
						maxRetries: 3,
					});
					const ok = await confirmSig?.(sig, { commitment: "confirmed", timeoutMs: 15000 });
					if (!ok) {
						const st = await conn.getSignatureStatuses([sig]).catch(()=>null);
						const status = st?.value?.[0]?.err ? "TX_ERR" : "NO_CONFIRM";
						return { ok: false, code: status, msg: "not confirmed" };
					}
					log(`Swap (manual send v1) sent: ${sig}`);
					try { log(`Explorer: https://solscan.io/tx/${sig}`); } catch {}
					try { if (isSell) setTimeout(() => _reconcileSplitSellRemainder(sig), 0); } catch {}
					try {
						if (inputMint === SOL_MINT || outputMint === SOL_MINT) {
							setTimeout(() => { unwrapWsolIfAny?.(signer).catch(()=>{}); }, 1200);
							setTimeout(() => { unwrapWsolIfAny?.(signer).catch(()=>{}); }, 1500);
						}
					} catch {}
					return { ok: true, sig };
				} catch (e) {
					log(`Manual send failed: ${e.message || e}. Simulating…`);
					try {
						const sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
						const logs = sim?.value?.logs || e?.logs || [];
						const txt = (logs || []).join(" ");
						const hasDustErr = /0x1788|0x1789/i.test(txt);
						const hasSlipErr = /0x1771/i.test(txt);
						if (hasDustErr) return { ok: false, code: "ROUTER_DUST", msg: e.message || String(e) };
						if (hasSlipErr) return { ok: false, code: "SLIPPAGE", msg: e.message || String(e) };
						return { ok: false, code: "SEND_FAIL", msg: e.message || String(e) };
					} catch {
						return { ok: false, code: "SEND_FAIL", msg: e.message || String(e) };
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
						const alt = buildQuoteUrl({ outMint: outputMint, slipBps: baseSlip, restrict: altRestrict, withFee: false });
						log(`Primary sell quote failed (${qRes.status}). Retrying with restrictIntermediateTokens=${alt.searchParams.get("restrictIntermediateTokens")} …`);
						const qRes2 = await jupFetch(alt.pathname + alt.search);
						if (qRes2.ok) {
							quote = await qRes2.json();
							haveQuote = true;
						} else {
							const body = await qRes2.text().catch(() => "");
							log(`Sell quote retry failed: ${body || qRes2.status}`);
							haveQuote = false;
						}
					} else {
						throw new Error(`quote ${qRes.status}`);
					}
				} else {
					quote = await qRes.json();
					haveQuote = true;
				}

				if (haveQuote) {
					if (isSell) {
						const outRaw = Number(quote?.outAmount || 0);
						const outSol = outRaw / 1e9;
						const eligible = feeBps > 0 && !!feeDestCandidate;
						if (eligible) {
							const qFee = buildQuoteUrl({ outMint: outputMint, slipBps: baseSlip, restrict: restrictIntermediates, withFee: true });
							const qFeeRes = await jupFetch(qFee.pathname + qFee.search);
							if (qFeeRes.ok) {
								quote = await qFeeRes.json();
								feeAccount = feeDestCandidate;
								quoteIncludesFee = true;
								log(`Sell fee enabled @ ${feeBps} bps (est out ${outSol.toFixed(6)} SOL)`);
							} else {
								log("Fee quote failed; proceeding without fee for this sell.");
								quoteIncludesFee = false;
							}
						} else {
							feeAccount = null;
							quoteIncludesFee = false;
							if (outSol > 0) log(`Small sell detected (${outSol.toFixed(6)} SOL). Fee disabled.`);
						}
					}
					logObj("Quote", { inAmount: quote?.inAmount, outAmount: quote?.outAmount, routePlanLen: quote?.routePlan?.length });
				}
			} catch (e) {
				if (!isSell) throw e;
				haveQuote = false;
				log(`Sell quote error; will try fallbacks: ${e.message || e}`, "err");
			}
		}

		if (haveQuote) {
			if (isSell) {
				const outRaw = Number(quote?.outAmount || 0);
				const minOutLamports = Math.floor(Number(minSellNotionalSol?.() || 0) * 1e9);
				if (!Number.isFinite(outRaw) || outRaw <= 0 || outRaw < minOutLamports) {
					log(`Sell below minimum; skipping (${(outRaw / 1e9).toFixed(6)} SOL < ${(minOutLamports / 1e9).toFixed(6)})`);
					log("Consider exporting your wallet and selling DUST manually.");
					throw new Error("BELOW_MIN_NOTIONAL");
				}
			}

			if (isSell && feeDestCandidate) {
				try {
					const outRawNoFee = Number(quote?.outAmount || 0);
					const profitableNoFee = shouldAttachFeeForSell?.({
						mint: inputMint,
						amountRaw: amountRaw,
						inDecimals: inDecimals,
						quoteOutLamports: outRawNoFee,
					});

					if (profitableNoFee) {
						const qFee = buildQuoteUrl({ outMint: outputMint, slipBps: baseSlip, restrict: restrictIntermediates, withFee: true });
						const qFeeRes = await jupFetch(qFee.pathname + qFee.search);
						if (qFeeRes.ok) {
							const quoteWithFee = await qFeeRes.json();
							const outRawWithFee = Number(quoteWithFee?.outAmount || 0);
							const stillProfitable = shouldAttachFeeForSell?.({
								mint: inputMint,
								amountRaw: amountRaw,
								inDecimals: inDecimals,
								quoteOutLamports: outRawWithFee,
							});
							if (stillProfitable) {
								quote = quoteWithFee;
								feeAccount = feeDestCandidate;
								quoteIncludesFee = true;
								const outSol = outRawWithFee / 1e9;
								log(`Sell fee enabled @ ${feeBps} bps (est PnL>0, out ${outSol.toFixed(6)} SOL).`);
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
				} catch {
					feeAccount = null;
					quoteIncludesFee = false;
					log("Profit check failed; fee disabled for this sell.");
				}
			}

			const first = await buildAndSend(false);
			if (first.ok) {
				await notePendingBuySeed();
				await seedCacheIfBuy();
				return first.sig;
			}
			if (!first.ok) lastErrCode = first.code || lastErrCode;

			if (first.code === "NOT_SUPPORTED") {
				log("Retrying with shared accounts …");
				const second = await buildAndSend(true);
				if (second.ok) {
					await notePendingBuySeed();
					await seedCacheIfBuy();
					return second.sig;
				}
				if (!second.ok) lastErrCode = second.code || lastErrCode;
			} else {
				log("Primary swap failed. Fallback: shared accounts …");
				const fallback = await buildAndSend(true);
				if (fallback.ok) {
					await notePendingBuySeed();
					await seedCacheIfBuy();
					return fallback.sig;
				}
				if (!fallback.ok) lastErrCode = fallback.code || lastErrCode;
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
						if (!a.ok) lastErrCode = a.code || lastErrCode;
						const b = await buildAndSend(true, true);
						if (b.ok) {
							await seedCacheIfBuy();
							return b.sig;
						}
						if (!b.ok) lastErrCode = b.code || lastErrCode;
					}
				} catch {}
			}

			{
				const manualSeq = [
					() => manualBuildAndSend(false),
					() => manualBuildAndSend(true),
				];
				for (const t of manualSeq) {
					try {
						const r = await t();
						if (r?.ok) {
							await notePendingBuySeed();
							await seedCacheIfBuy();
							return r.sig;
						}
						if (r && !r.ok) lastErrCode = r.code || lastErrCode;
					} catch {}
				}
			}

			{
				log("Swap API failed - trying manual build/sign …");
				const tries = [
					() => manualBuildAndSend(false),
					() => manualBuildAndSend(true),
				];
				for (const t of tries) {
					try {
						const r = await t();
						if (r?.ok) {
							await notePendingBuySeed();
							await seedCacheIfBuy();
							return r.sig;
						}
						if (r && !r.ok) lastErrCode = r.code || lastErrCode;
					} catch {}
				}
			}

			if (isSell) {
				try {
					const slip2 = 2000;
					const rFlag = restrictAllowed ? "false" : "true";
					const q2 = buildQuoteUrl({ outMint: outputMint, slipBps: slip2, restrict: rFlag, withFee: !!(feeAccount && feeBps > 0) });
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
						return null;
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
									try { await confirmSig?.(sig1, { commitment: "confirmed", timeoutMs: 12000 }); } catch {}
									try { await waitForTokenCredit?.(userPub, USDC, { timeoutMs: 12000, pollMs: 300 }); } catch {}
									let usdcUi = 0;
									try {
										const b = await getAtaBalanceUi?.(userPub, USDC, 6);
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
							if (feeBps > 0 && feeDestCandidate) {
								try {
									const decIn = Number.isFinite(inDecimals) ? inDecimals : (_decHint ?? 6);
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
												log(`Split-sell fee enabled @ ${feeBps} bps for f=${f}.`);
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
						}
					}
				} catch (e) {
					log(`Split-sell fallback error: ${e.message || e}`, "err");
				}
			}

			throw new Error(lastErrCode || "swap failed");
		}
	}

	async function executeSwapWithConfirm(opts, { retries = 2, confirmMs = 15000 } = {}) {
		let slip = Math.max(150, Number(opts.slippageBps ?? getState().slippageBps ?? 150) | 0);
		const isBuy = (opts?.inputMint === SOL_MINT && opts?.outputMint && opts.outputMint !== SOL_MINT);
		if (isBuy) slip = Math.min(300, Math.max(200, slip));

		const prevDefer = !!window._fdvDeferSeed;
		window._fdvDeferSeed = true;
		let lastSig = null;
		try {
			const needFinal = false;
			for (let attempt = 0; attempt <= retries; attempt++) {
				try {
					const sig = await jupSwapWithKeypair({ ...opts, slippageBps: slip });
					lastSig = sig;

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

					const ok = await confirmSig?.(sig, {
						commitment: "confirmed",
						timeoutMs: Math.max(confirmMs, 22_000),
						requireFinalized: needFinal,
					}).catch(() => false);
					if (ok) return { ok: true, sig, slip };

					if (isBuy) {
						log("Buy sent; skipping retries and relying on pending credit.");
						return { ok: false, sig, slip };
					}
				} catch (e) {
					const msg = String(e?.message || e || "");
					log(`Swap attempt ${attempt + 1} failed: ${msg}`);
					if (/INSUFFICIENT_LAMPORTS/i.test(msg)) {
						return { ok: false, insufficient: true, msg, sig: lastSig };
					}
					if (/ROUTER_DUST|COULD_NOT_FIND_ANY_ROUTE|NO_ROUTE|BELOW_MIN_NOTIONAL|0x1788/i.test(msg)) {
						if (opts?.inputMint && opts?.outputMint === SOL_MINT && opts.inputMint !== SOL_MINT) {
							setRouterHold?.(opts.inputMint, ROUTER_COOLDOWN_MS);
						}
						return { ok: false, noRoute: true, msg, sig: lastSig };
					}
				}
				slip = Math.min(2000, Math.floor(slip * 1.6));
				log(`Swap not confirmed; retrying with slippage=${slip} bps…`);
			}
			return { ok: false, sig: lastSig };
		} finally {
			window._fdvDeferSeed = prevDefer;
		}
	}

	async function closeEmptyTokenAtas(signer, mint) {
		try {
			const { Transaction, TransactionInstruction } = await loadWeb3();
			const conn = await getConn();
			const { createCloseAccountInstruction } = await loadSplToken();

			const ownerPk = signer.publicKey;
			const owner = ownerPk.toBase58();

			if (!mint || mint === SOL_MINT) return false;
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

			const tx = new Transaction();
			for (const ix of ixs) tx.add(ix);
			tx.feePayer = ownerPk;
			tx.recentBlockhash = (await conn.getLatestBlockhash("processed")).blockhash;
			tx.sign(signer);
			const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "processed", maxRetries: 2 });
			log(`Closed empty ATAs for ${mint.slice(0, 4)}…: ${sig}`);
			return true;
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

	return {
		getJupBase,
		getMintDecimals,
		jupFetch,
		quoteGeneric,
		jupSwapWithKeypair,
		executeSwapWithConfirm,
		closeEmptyTokenAtas,
		closeAllEmptyAtas,
	};
}