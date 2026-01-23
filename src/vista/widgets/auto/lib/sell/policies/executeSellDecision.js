export function createExecuteSellDecisionPolicy({
  log,
  now,
  getState,
  save,
  setInFlight,
  lockMint,
  unlockMint,
  SOL_MINT,
  MINT_OP_LOCK_MS,
  ROUTER_COOLDOWN_MS,
  MIN_SELL_SOL_OUT,
  addToDustCache,
  removeFromPosCache,
  updatePosCache,
  clearPendingCredit,
  setRouterHold,
  closeEmptyTokenAtas,
  quoteOutSol,
  getAtaBalanceUi,
  minSellNotionalSol,
  executeSwapWithConfirm,
  waitForTokenDebit,
  addRealizedPnl,
  onRealizedPnl,
  maybeStealthRotate,
  clearRouteDustFails,
}) {
  return async function executeSellDecisionPolicy(ctx) {
    const state = getState();

    const actionLabel = ctx?.decision && ctx.decision.action !== "none" ? ctx.decision.action : "NO";
    const reasonLabel = (() => {
      try {
        const rawReason = String(ctx?.decision?.reason || "").trim();
        if (rawReason) {
          const m = rawReason.match(/pnl-hold\s+(-?\d+(?:\.\d+)?)%<(-?\d+(?:\.\d+)?)%/i);
          if (m) {
            const pnl = Number(m[1]);
            const target = Number(m[2]);
            if (Number.isFinite(pnl) && Number.isFinite(target)) {
              return `PNL not met pnl=${pnl.toFixed(2)}% target=${target.toFixed(2)}%`;
            }
            return "PNL not met";
          }
          return rawReason;
        }

        const target = Number(ctx?.pnlTargetPct);
        if ((ctx?.decision?.action === "none" || !ctx?.decision) && Number.isFinite(target)) {
          const pnl = Number.isFinite(Number(ctx?.pnlAtDecisionPct))
            ? Number(ctx.pnlAtDecisionPct)
            : (Number.isFinite(Number(ctx?.pnlNetPct)) ? Number(ctx.pnlNetPct) : (Number.isFinite(Number(ctx?.pnlPct)) ? Number(ctx.pnlPct) : NaN));
          if (Number.isFinite(pnl)) return `PNL not met pnl=${pnl.toFixed(2)}% target=${target.toFixed(2)}%`;
          return `PNL not met target=${target.toFixed(2)}%`;
        }
      } catch {}
      return "criteria not met";
    })();

    log(`Sell decision: ${actionLabel} (${reasonLabel})`);
    if (!ctx.decision || ctx.decision.action === "none") return { done: false, returned: false };

    const { kp, mint, pos } = ctx;
    const ownerStr = ctx.ownerStr;
    const isFastExit = !!ctx.isFastExit;

    if (ctx.decision.action === "sell_all" && ctx.curSol < ctx.minNotional && !isFastExit) {
      try { addToDustCache(ownerStr, mint, pos.sizeUi, pos.decimals ?? 6); } catch {}
      try { removeFromPosCache(ownerStr, mint); } catch {}
      delete state.positions[mint];
      save();
      log(`Below notional for ${mint.slice(0,4)}… moved to dust (skip sell).`);
      return { done: true, returned: true };
    }

    const routerHoldUntil = (() => {
      try {
        if (!window._fdvRouterHold) return 0;
        return Number(window._fdvRouterHold.get(mint) || 0);
      } catch {
        return 0;
      }
    })();
    const routerHoldActive = routerHoldUntil > now();
    const bypassRouterHold = !!(
      ctx.decision?.hardStop ||
      ctx.isFastExit ||
      ctx.forceRug ||
      ctx.forcePumpDrop ||
		ctx.forceObserverDrop
    );
    if (!ctx.forceExpire && routerHoldActive && !bypassRouterHold) {
      log(`Router cooldown for ${mint.slice(0,4)}… until ${new Date(routerHoldUntil).toLocaleTimeString()}`);
      // Not an action; allow the evaluator to consider other mints this tick.
      return { done: false, returned: true };
    }
    if (!ctx.forceExpire && routerHoldActive && bypassRouterHold) {
      try { log(`Router cooldown bypass for ${mint.slice(0,4)}… (${String(ctx.decision?.reason || "hard-exit")})`); } catch {}
    }

    const postGrace = Number(pos.postWarmGraceUntil || 0);
    if (postGrace && ctx.nowTs < postGrace) {
      ctx.forceExpire = false;
    }

    setInFlight(true);
    lockMint(mint, "sell", Math.max(MINT_OP_LOCK_MS, Number(state.sellCooldownMs||20000)));

    try {

      let exitSlip = Math.max(Number(state.slippageBps || 250), Number(state.fastExitSlipBps || 400));
      if (ctx.decision?.hardStop || ctx.forceRug || ctx.forceObserverDrop || ctx.forcePumpDrop) {
        exitSlip = Math.max(exitSlip, 1500);
      }
      const exitConfirmMs = isFastExit ? Math.max(6000, Number(state.fastExitConfirmMs || 9000)) : 15000;

      // PARTIAL
      if (ctx.decision.action === "sell_partial") {
      const pct = Math.min(100, Math.max(1, Number(ctx.decision.pct || 50)));
      let sellUi = pos.sizeUi * (pct / 100);
      try {
        const b = await getAtaBalanceUi(kp.publicKey.toBase58(), mint, pos.decimals);
        if (Number(b.sizeUi || 0) > 0) sellUi = Math.min(sellUi, Number(b.sizeUi));
      } catch {}

      const estSol = await quoteOutSol(mint, sellUi, pos.decimals).catch(() => 0);
      if (estSol < ctx.minNotional && !isFastExit) {
        if (ctx.curSol >= ctx.minNotional) {
          log(`Skip partial ${pct}% ${mint.slice(0,4)}… (below min-notional: est ${estSol.toFixed(6)} SOL < ${ctx.minNotional}; no escalation)`);
          setInFlight(false);
          try { unlockMint(mint); } catch {}
          // Not an action; allow the evaluator to consider other mints this tick.
          return { done: false, returned: true };

        } else {
          log(`Skip partial ${pct}% ${mint.slice(0,4)}… (est ${estSol.toFixed(6)} SOL < ${ctx.minNotional})`);
          setInFlight(false);
          try { unlockMint(mint); } catch {}
          // Not an action; allow the evaluator to consider other mints this tick.
          return { done: false, returned: true };
        }
      }

      const res = await executeSwapWithConfirm({
        signer: kp, inputMint: mint, outputMint: SOL_MINT, amountUi: sellUi, slippageBps: exitSlip,
      }, { retries: isFastExit ? 0 : 1, confirmMs: exitConfirmMs });

      if (!res.ok) {
        if (res.noRoute) setRouterHold(mint, ROUTER_COOLDOWN_MS);
        log(`Sell not confirmed for ${mint.slice(0,4)}… (partial). Keeping position.`);
        setInFlight(false);
        unlockMint(mint);
        return { done: true, returned: true };
      }

      log(`Sold ${sellUi.toFixed(6)} ${mint.slice(0,4)}… (${ctx.decision.reason})`);

      const prevCostSol = Number(pos.costSol || 0);
      const costSold = prevCostSol * (pct / 100);
      const remainPct = 1 - (pct / 100);
      pos.sizeUi = Math.max(0, pos.sizeUi - sellUi);
      pos.costSol = Number(pos.costSol || 0) * remainPct;
      pos.hwmSol = Number(pos.hwmSol || 0) * remainPct;
      pos.hwmPx = Number(pos.hwmPx || 0);
      pos.lastSellAt = now();
      pos.allowRebuy = true;
      pos.lastSplitSellAt = now();

      try {
        const debit = await waitForTokenDebit(kp.publicKey.toBase58(), mint, sellUi, { timeoutMs: 20000, pollMs: 350 });
        const remainUi = Number(debit.remainUi || pos.sizeUi || 0);
        if (remainUi > 1e-9) {
          const estRemainSol = await quoteOutSol(mint, remainUi, pos.decimals).catch(() => 0);
          const minN = minSellNotionalSol();
          if (estRemainSol >= minN) {
            pos.sizeUi = remainUi;
            if (Number.isFinite(debit.decimals)) pos.decimals = debit.decimals;
            updatePosCache(kp.publicKey.toBase64 ? kp.publicKey.toBase64() : kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
            updatePosCache(kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
          } else {
            try { addToDustCache(kp.publicKey.toBase58(), mint, remainUi, pos.decimals ?? 6); } catch {}
            try { removeFromPosCache(kp.publicKey.toBase58(), mint); } catch {}
            try { clearPendingCredit(kp.publicKey.toBase58(), mint); } catch {}
            delete state.positions[mint];
            save();
            log(`Leftover below notional for ${mint.slice(0,4)}… moved to dust cache.`);
          }
        } else {
          delete state.positions[mint];
          removeFromPosCache(kp.publicKey.toBase58(), mint);
          try { clearPendingCredit(kp.publicKey.toBase58(), mint); } catch {}
        }
      } catch {
        updatePosCache(kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
      }
      save();

      await addRealizedPnl(estSol, costSold, "Partial sell PnL");
      try {
        if (typeof onRealizedPnl === "function") {
          onRealizedPnl({
            mint,
            kind: "sell_partial",
            proceedsSol: estSol,
            costSold,
            pnlSol: Number(estSol || 0) - Number(costSold || 0),
            label: "Partial sell PnL",
            decision: ctx?.decision || null,
            nowTs: Number(ctx?.nowTs || 0),
          });
        }
      } catch {}
      } else {
        // FULL SELL (original block)
        let sellUi = pos.sizeUi;
        try {
          const b = await getAtaBalanceUi(kp.publicKey.toBase58(), mint, pos.decimals);
          if (Number(b.sizeUi || 0) > 0) sellUi = Number(b.sizeUi);
        } catch {}

        const res = await executeSwapWithConfirm({
          signer: kp, inputMint: mint, outputMint: SOL_MINT, amountUi: sellUi, slippageBps: exitSlip,
        }, { retries: isFastExit ? 0 : 1, confirmMs: exitConfirmMs });

        if (!res.ok) {
          if (res.noRoute) setRouterHold(mint, ROUTER_COOLDOWN_MS);
          log(`Sell not confirmed for ${mint.slice(0,4)}… Keeping position.`);
          setInFlight(false);
          unlockMint(mint);
          return { done: true, returned: true };
        }

        clearRouteDustFails(mint);

        const prevSize = Number(pos.sizeUi || sellUi);
        const debit = await waitForTokenDebit(kp.publicKey.toBase58(), mint, prevSize, { timeoutMs: 25000, pollMs: 400 });
        const remainUi = Number(debit.remainUi || 0);
        if (remainUi > 1e-9) {
          const estRemainSol = await quoteOutSol(mint, remainUi, pos.decimals).catch(() => 0);
          const minN = minSellNotionalSol();
          if (estRemainSol >= minN) {
            const frac = Math.min(1, Math.max(0, remainUi / Math.max(1e-9, prevSize)));
            pos.sizeUi = remainUi;
            pos.costSol = Number(pos.costSol || 0) * frac;
            pos.hwmSol  = Number(pos.hwmSol  || 0) * frac;
            pos.lastSellAt = now();
            updatePosCache(kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
            save();
            setRouterHold(mint, ROUTER_COOLDOWN_MS);
            log(`Post-sell balance remains ${remainUi.toFixed(6)} ${mint.slice(0,4)}… (keeping position; router cooldown applied)`);
          } else {
            try { addToDustCache(kp.publicKey.toBase58(), mint, remainUi, pos.decimals ?? 6); } catch {}
            try { removeFromPosCache(kp.publicKey.toBase58(), mint); } catch {}
            delete state.positions[mint];
            save();
            log(`Leftover below notional for ${mint.slice(0,4)}… moved to dust cache.`);
          }
        } else {
          const reason = (ctx.decision && ctx.decision.reason) ? ctx.decision.reason : "done";
          const estFullSolGross = ctx.curSol > 0 ? ctx.curSol : await quoteOutSol(mint, sellUi, pos.decimals).catch(()=>0);
          const estFullSolNet = (Number.isFinite(ctx.curSolNet) && ctx.curSolNet > 0) ? ctx.curSolNet : estFullSolGross;
          let reclaimedSol = 0;
          try {
            const closed = await closeEmptyTokenAtas(kp, mint);
            reclaimedSol = Number(closed?.reclaimedLamportsEst || 0) / 1e9;
          } catch {}
          const estTotalSol = estFullSolNet + reclaimedSol;
          log(
            `Sold ${sellUi.toFixed(6)} ${mint.slice(0,4)}… -> ~${estTotalSol.toFixed(6)} SOL (${reason})` +
            (reclaimedSol > 0 ? ` (+rent≈${reclaimedSol.toFixed(6)} SOL)` : "")
          );
          const costSold = Number(pos.costSol || 0);
          await addRealizedPnl(estTotalSol, costSold, "Full sell PnL");
          try {
            if (typeof onRealizedPnl === "function") {
              onRealizedPnl({
                mint,
                kind: "sell_full",
                proceedsSol: estTotalSol,
                costSold,
                pnlSol: Number(estTotalSol || 0) - Number(costSold || 0),
                label: "Full sell PnL",
                decision: ctx?.decision || null,
                nowTs: Number(ctx?.nowTs || 0),
              });
            }
          } catch {}
          delete state.positions[mint];
          removeFromPosCache(kp.publicKey.toBase58(), mint);
          save();
        }
      }
    
      state.lastTradeTs = now();
      save();
      return { done: true, returned: true };
    } catch (err) {
      try {
        const msg = String(err?.message || err || "");
        log(`Sell execution error for ${mint.slice(0,4)}… ${msg.slice(0,160)}`, "warn");
      } catch {}
      return { done: true, returned: true };
    } finally {
      try { setInFlight(false); } catch {}
      try { unlockMint(mint); } catch {}
      try { save(); } catch {}
    }
  };
}
