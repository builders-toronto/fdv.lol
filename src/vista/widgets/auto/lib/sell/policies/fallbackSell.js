export function createFallbackSellPolicy({
  log,
  getState,
  minSellNotionalSol,
  shouldSell,
  MIN_SELL_SOL_OUT,
}) {
  return function fallbackSellPolicy(ctx) {
    const state = getState();
    ctx.minNotional = minSellNotionalSol();

    if (ctx.isFastExit) return; // skip fallback when fast exit already set

    const canRunFallback =
      !(ctx.warmingHoldActive && !ctx.forceRug && !ctx.forcePumpDrop && !ctx.forceObserverDrop && !ctx.forceExpire);

    if (!canRunFallback) {
      log(`Warming hold active; skipping fallback sell checks for ${ctx.mint.slice(0,4)}…`);
      return;
    }

    let d = null;
    if (ctx.curSol < ctx.minNotional && !ctx.forceExpire && !ctx.forceRug && !ctx.forcePumpDrop && !ctx.forceObserverDrop) {
      d = shouldSell(ctx.pos, ctx.curSolNet, ctx.nowTs);
      const dustMin = Math.max(MIN_SELL_SOL_OUT, Number(state.dustMinSolOut || 0));
      if (!(state.dustExitEnabled && d.action === "sell_all" && ctx.curSol >= dustMin)) {
        log(`Skip sell eval ${ctx.mint.slice(0,4)}… (notional ${ctx.curSol.toFixed(6)} SOL < ${ctx.minNotional})`);
        return { d };
      } else {
        log(`Dust exit enabled for ${ctx.mint.slice(0,4)}… (est ${ctx.curSol.toFixed(6)} SOL >= ${dustMin})`);
      }
    } else if (ctx.curSol < ctx.minNotional && !ctx.forceExpire && (ctx.forceRug || ctx.forcePumpDrop || ctx.forceObserverDrop)) {
      const why = ctx.forceRug ? "Rug" : (ctx.forcePumpDrop ? "Pump->Calm" : "Observer");
      log(`${why} exit for ${ctx.mint.slice(0,4)}… ignoring min-notional (${ctx.curSol.toFixed(6)} SOL < ${ctx.minNotional}).`);
    }

    if (!ctx.decision || ctx.decision.action === "none") {
      ctx.decision = d || shouldSell(ctx.pos, ctx.curSol, ctx.nowTs);
    }
  };
}
