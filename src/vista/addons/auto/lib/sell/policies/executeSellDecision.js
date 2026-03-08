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
    const effectiveMinNotional = Math.max(
      0,
      Number(ctx?.minNotional || 0),
      Number(minSellNotionalSol?.() || 0),
    );

    if (ctx.decision.action === "sell_all" && ctx.curSol < effectiveMinNotional && !isFastExit) {
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
      let runPartial = ctx.decision.action === "sell_partial";
      if (runPartial) {
        const pct = Math.min(100, Math.max(1, Number(ctx.decision.pct || 50)));
        const preSizeUi = Math.max(0, Number(pos.sizeUi || 0));
        const preCostSol = Math.max(0, Number(pos.costSol || 0));
        const preHwmSol = Math.max(0, Number(pos.hwmSol || 0));
        let sellUi = pos.sizeUi * (pct / 100);
        try {
          const b = await getAtaBalanceUi(kp.publicKey.toBase58(), mint, pos.decimals);
          if (Number(b.sizeUi || 0) > 0) sellUi = Math.min(sellUi, Number(b.sizeUi));
        } catch {}

        const estSol = await quoteOutSol(mint, sellUi, pos.decimals).catch(() => 0);
        if (estSol < effectiveMinNotional && !isFastExit) {
          const fullEstSol = Math.max(0, Number(ctx.curSol || 0));
          if (fullEstSol >= effectiveMinNotional) {
            const prevReason = String(ctx?.decision?.reason || "partial-below-min-notional").trim();
            ctx.decision = {
              ...ctx.decision,
              action: "sell_all",
              reason: `${prevReason} [escalated:partial<min-notional]`,
            };
            runPartial = false;
            log(
              `Partial ${pct}% ${mint.slice(0,4)}… is below min-notional (${estSol.toFixed(6)} SOL < ${effectiveMinNotional.toFixed(6)}); escalating to full exit.`
            );
          } else {
            try { addToDustCache(ownerStr, mint, pos.sizeUi, pos.decimals ?? 6); } catch {}
            try { removeFromPosCache(ownerStr, mint); } catch {}
            delete state.positions[mint];
            save();
            log(`Below notional for ${mint.slice(0,4)}… moved to dust (partial and full size are both too small).`);
            return { done: true, returned: true };
          }
        }

        if (runPartial) {
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

          // Optimistic local update; final accounting is corrected from on-chain debit result below.
          pos.sizeUi = Math.max(0, preSizeUi - sellUi);
          pos.hwmPx = Number(pos.hwmPx || 0);
          pos.lastSellAt = now();
          pos.allowRebuy = true;
          pos.lastSplitSellAt = now();

          let remainUiActual = Math.max(0, Number(pos.sizeUi || 0));
          try {
            const debit = await waitForTokenDebit(kp.publicKey.toBase58(), mint, sellUi, { timeoutMs: 20000, pollMs: 350 });
            remainUiActual = Math.max(0, Number(debit.remainUi || remainUiActual || 0));
            if (remainUiActual > 1e-9) {
              const estRemainSol = await quoteOutSol(mint, remainUiActual, pos.decimals).catch(() => 0);
              const minN = minSellNotionalSol();
              if (estRemainSol >= minN) {
                pos.sizeUi = remainUiActual;
                if (Number.isFinite(debit.decimals)) pos.decimals = debit.decimals;
                updatePosCache(kp.publicKey.toBase64 ? kp.publicKey.toBase64() : kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
                updatePosCache(kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
              } else {
                try { addToDustCache(kp.publicKey.toBase58(), mint, remainUiActual, pos.decimals ?? 6); } catch {}
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
            remainUiActual = Math.max(0, Number(pos.sizeUi || 0));
            updatePosCache(kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
          }

          const safePreSize = Math.max(1e-12, preSizeUi);
          const soldFrac = Math.min(1, Math.max(0, (preSizeUi - remainUiActual) / safePreSize));
          const costSold = preCostSol * soldFrac;
          const remainCostSol = Math.max(0, preCostSol - costSold);
          const remainHwmSol = Math.max(0, preHwmSol * (1 - soldFrac));

          if (state.positions[mint]) {
            pos.sizeUi = remainUiActual;
            pos.costSol = remainCostSol;
            pos.hwmSol = remainHwmSol;
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
                quoteTrust: Number(ctx?.quoteTrust ?? 1),
                quoteTrustFlags: Array.isArray(ctx?.quoteTrustFlags) ? ctx.quoteTrustFlags : [],
                quoteMetrics: ctx?.quoteMetrics || null,
                urgentMeta: ctx?.urgentMeta || null,
                badge: String(ctx?.agentSignals?.badge || ""),
                regime: String(ctx?.agentSignals?.past?.regime || ctx?.agentSignals?.past?.label || ""),
              });
            }
          } catch {}
        }
      }

      if (!runPartial) {
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
                quoteTrust: Number(ctx?.quoteTrust ?? 1),
                quoteTrustFlags: Array.isArray(ctx?.quoteTrustFlags) ? ctx.quoteTrustFlags : [],
                quoteMetrics: ctx?.quoteMetrics || null,
                urgentMeta: ctx?.urgentMeta || null,
                badge: String(ctx?.agentSignals?.badge || ""),
                regime: String(ctx?.agentSignals?.past?.regime || ctx?.agentSignals?.past?.label || ""),
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
