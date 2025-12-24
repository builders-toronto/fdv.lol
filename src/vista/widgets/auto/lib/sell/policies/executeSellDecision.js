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
  maybeStealthRotate,
  clearRouteDustFails,
}) {
  return async function executeSellDecisionPolicy(ctx) {
    const state = getState();

    log(`Sell decision: ${ctx.decision && ctx.decision.action !== "none" ? ctx.decision.action : "NO"} (${ctx.decision?.reason || "criteria not met"})`);
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
      ctx.forceObserverDrop ||
      ctx.forceMomentum
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
          log(`Partial ${pct}% ${mint.slice(0,4)}… below min (${estSol.toFixed(6)} SOL < ${ctx.minNotional}). Escalating to full sell …`);

          let sellUi2 = pos.sizeUi;
          try {
            const b = await getAtaBalanceUi(kp.publicKey.toBase58(), mint, pos.decimals);
            if (Number(b.sizeUi || 0) > 0) sellUi2 = Number(b.sizeUi);
          } catch {}

          const res2 = await executeSwapWithConfirm({
            signer: kp, inputMint: mint, outputMint: SOL_MINT, amountUi: sellUi2, slippageBps: state.slippageBps,
          }, { retries: 1, confirmMs: 15000 });

          if (!res2.ok) {
            if (res2.noRoute) setRouterHold(mint, ROUTER_COOLDOWN_MS);
            log(`Sell not confirmed for ${mint.slice(0,4)}… Keeping position.`);
            setInFlight(false);
            unlockMint(mint);
            return { done: true, returned: true };
          }

          const prevSize2 = Number(pos.sizeUi || sellUi2);
          const debit = await waitForTokenDebit(kp.publicKey.toBase58(), mint, prevSize2, { timeoutMs: 25000, pollMs: 400 });
          const remainUi2 = Number(debit.remainUi || 0);

          if (remainUi2 > 1e-9) {
            let chkUi = remainUi2, chkDec = pos.decimals;
            try {
              const chk = await getAtaBalanceUi(kp.publicKey.toBase58(), mint, pos.decimals);
              chkUi = Number(chk.sizeUi || 0);
              if (Number.isFinite(chk.decimals)) chkDec = chk.decimals;
            } catch {}
            if (chkUi <= 1e-9) {
              delete state.positions[mint];
              removeFromPosCache(kp.publicKey.toBase58(), mint);
              try { clearPendingCredit(kp.publicKey.toBase58(), mint); } catch {}
            } else {
              const estRemainSol = await quoteOutSol(mint, chkUi, chkDec).catch(() => 0);
              const minN = minSellNotionalSol();
              if (estRemainSol >= minN) {
                pos.sizeUi = chkUi;
                if (Number.isFinite(chkDec)) pos.decimals = chkDec;
                updatePosCache(kp.publicKey.toBase58(), mint, pos.sizeUi, pos.decimals);
              } else {
                try { addToDustCache(kp.publicKey.toBase58(), mint, chkUi, chkDec ?? 6); } catch {}
                try { removeFromPosCache(kp.publicKey.toBase58(), mint); } catch {}
                delete state.positions[mint];
                save();
                log(`Leftover below notional for ${mint.slice(0,4)}… moved to dust cache.`);
              }
            }
          } else {
            const reason = (ctx.decision && ctx.decision.reason) ? ctx.decision.reason : "done";
            const estFullSol = ctx.curSol > 0 ? ctx.curSol : await quoteOutSol(mint, sellUi2, pos.decimals).catch(()=>0);
            log(`Sold ${sellUi2.toFixed(6)} ${mint.slice(0,4)}… -> ~${estFullSol.toFixed(6)} SOL (${reason})`);
            const costSold = Number(pos.costSol || 0);
            await addRealizedPnl(estFullSol, costSold, "Full sell PnL");
            try { await closeEmptyTokenAtas(kp, mint); } catch {}
            delete state.positions[mint];
            removeFromPosCache(kp.publicKey.toBase58(), mint);
            try { clearPendingCredit(kp.publicKey.toBase58(), mint); } catch {}
            save();
          }
          state.lastTradeTs = now();
          try { await maybeStealthRotate("sell"); } catch {}
          setInFlight(false);
          unlockMint(mint);
          save();
          return { done: true, returned: true };
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
          const estFullSol = ctx.curSol > 0 ? ctx.curSol : await quoteOutSol(mint, sellUi, pos.decimals).catch(()=>0);
          log(`Sold ${sellUi.toFixed(6)} ${mint.slice(0,4)}… -> ~${estFullSol.toFixed(6)} SOL (${reason})`);
          const costSold = Number(pos.costSol || 0);
          await addRealizedPnl(estFullSol, costSold, "Full sell PnL");
          try { await closeEmptyTokenAtas(kp, mint); } catch {}
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
