export function createQuoteAndEdgePolicy({
  log,
  getState,
  quoteOutSol,
  flagUrgentSell,
  RUG_QUOTE_SHOCK_WINDOW_MS,
  RUG_QUOTE_SHOCK_FRAC,
  estimateNetExitSolFromQuote,
}) {
  return async function quoteAndEdgePolicy(ctx) {
    const state = getState();
    const sz = Number(ctx.pos.sizeUi || 0);
    let curSol = Number(ctx.pos.lastQuotedSol || 0);
    const lastQ = Number(ctx.pos.lastQuotedAt || 0);
    if (!lastQ || (ctx.nowTs - lastQ) > (state.minQuoteIntervalMs|0)) {
      log(`Evaluating sell for ${ctx.mint.slice(0,4)}… size ${sz.toFixed(6)}`);
      curSol = await quoteOutSol(ctx.mint, sz, ctx.pos.decimals).catch(() => 0);
      ctx.pos.lastQuotedSol = curSol;
      ctx.pos.lastQuotedAt = ctx.nowTs;
    }
    try {
      const prevSol = Number(ctx.pos._lastShockSol || 0);
      const prevAt  = Number(ctx.pos._lastShockAt  || 0);
      if (prevSol > 0 && curSol > 0 && (ctx.nowTs - prevAt) <= RUG_QUOTE_SHOCK_WINDOW_MS) {
        const dropFrac = (prevSol - curSol) / Math.max(prevSol, 1e-12);
        if (dropFrac >= RUG_QUOTE_SHOCK_FRAC) {
          log(`RUG quote-shock ${ctx.mint.slice(0,4)}… drop=${(dropFrac*100).toFixed(1)}% within ${(ctx.nowTs-prevAt)}ms`);
          flagUrgentSell(ctx.mint, "rug_quote_shock", 1.0);
        }
      }
      ctx.pos._lastShockSol = curSol;
      ctx.pos._lastShockAt  = ctx.nowTs;
    } catch {}

    ctx.curSol = curSol;

    ctx.outLamports = Math.floor(Math.max(0, ctx.curSol) * 1e9);
    ctx.decIn = Number.isFinite(ctx.pos.decimals) ? ctx.pos.decimals : 6;
    const net = estimateNetExitSolFromQuote({
      mint: ctx.mint,
      amountUi: sz,
      inDecimals: ctx.decIn,
      quoteOutLamports: ctx.outLamports
    });
    ctx.netEstimate = net;
    ctx.curSolNet = net.netSol;

    if (Number.isFinite(ctx.curSol) && Number.isFinite(ctx.curSolNet)) {
      log(`Edge-aware valuation ${ctx.mint.slice(0,4)}… raw≈${ctx.curSol.toFixed(6)} SOL, net≈${ctx.curSolNet.toFixed(6)} SOL${net.feeApplied ? " (fee)" : ""}`);
    }

    ctx.pxNow  = sz > 0 ? (ctx.curSol / sz) : 0;
    ctx.pxCost = sz > 0 ? (Number(ctx.pos.costSol || 0) / sz) : 0;
    ctx.pnlPct = (ctx.pxNow > 0 && ctx.pxCost > 0) ? ((ctx.pxNow - ctx.pxCost) / ctx.pxCost) * 100 : 0;

    ctx.pxNowNet  = sz > 0 ? (ctx.curSolNet / sz) : 0;
    ctx.pnlNetPct = (ctx.pxNowNet > 0 && ctx.pxCost > 0) ? ((ctx.pxNowNet - ctx.pxCost) / ctx.pxCost) * 100 : 0;

    // Maintain high-water marks from live valuation ticks.
    // - `hwmSol` is used as a peak value hint (prefer net for conservatism).
    // - `hwmPx` is used by several drawdown/trailing checks.
    try {
      if (Number.isFinite(ctx.pxNow) && ctx.pxNow > 0) {
        const prevHwmPx = Number(ctx.pos.hwmPx || 0);
        ctx.pos.hwmPx = Math.max(prevHwmPx || ctx.pxNow, ctx.pxNow);
      }
      const v = (Number.isFinite(ctx.curSolNet) && ctx.curSolNet > 0)
        ? ctx.curSolNet
        : ((Number.isFinite(ctx.curSol) && ctx.curSol > 0) ? ctx.curSol : 0);
      if (v > 0) ctx.pos.hwmSol = Math.max(Number(ctx.pos.hwmSol || 0), v);
    } catch {}
  };
}
