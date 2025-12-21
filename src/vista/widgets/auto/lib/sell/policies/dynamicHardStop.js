export function createDynamicHardStopPolicy({ log, getState, DYN_HS, computeFinalGateIntensity, computeDynamicHardStopPct }) {
  return function dynamicHardStopPolicy(ctx) {
    const state = getState();
    ctx.ageSec = (ctx.nowTs - Number(ctx.pos.lastBuyAt || ctx.pos.acquiredAt || 0)) / 1000;
    ctx.remorseSecs = Math.max(5, Number(DYN_HS?.remorseSecs ?? 6));
    ctx.creditsPending = ctx.pos.awaitingSizeSync === true || ctx.pos._pendingCostAug === true;
    ctx.canHardStop = ctx.ageSec >= ctx.remorseSecs && !ctx.creditsPending;

    if (state.rideWarming && ctx.pos.warmingHold === true) {
      const warmNoHs = Math.max(ctx.remorseSecs, Number(state.warmingNoHardStopSecs || 35));
      if (ctx.ageSec < warmNoHs) {
        ctx.canHardStop = false;
        log(`Hard stop suppressed by warming window (${ctx.ageSec.toFixed(1)}s < ${warmNoHs}s) for ${ctx.mint.slice(0,4)}…`);
      }
    }

    if (ctx.canHardStop) {
      const ddPct = (Number(ctx.pos.hwmPx || 0) > 0 && ctx.pxNow > 0)
        ? ((ctx.pos.hwmPx - ctx.pxNow) / ctx.pos.hwmPx) * 100
        : 0;
      const gate = computeFinalGateIntensity(ctx.mint);
      ctx.dynStopPct = computeDynamicHardStopPct(ctx.mint, ctx.pos, ctx.nowTs, {
        pnlNetPct: ctx.pnlNetPct,
        drawdownPct: ddPct,
        intensity: Number(gate?.intensity || 1)
      });
    }

    if (ctx.canHardStop &&
        Number.isFinite(ctx.pnlNetPct) && Number.isFinite(ctx.dynStopPct) &&
        ctx.pnlNetPct <= -Math.abs(ctx.dynStopPct)) {
      ctx.decision = { action: "sell_all", reason: `HARD_STOP ${ctx.pnlNetPct.toFixed(2)}%<=-${Math.abs(ctx.dynStopPct).toFixed(2)}%`, hardStop: true };
      ctx.isFastExit = true;
      log(`Dynamic hard stop for ${ctx.mint.slice(0,4)}… netPnL=${ctx.pnlNetPct.toFixed(2)}% thr=-${Math.abs(ctx.dynStopPct).toFixed(2)}% (age ${ctx.ageSec.toFixed(1)}s)`);
    } else if (!ctx.canHardStop) {
      log(`Hard stop suppressed (age ${ctx.ageSec.toFixed(1)}s${ctx.creditsPending ? ", pending credit" : ""}) for ${ctx.mint.slice(0,4)}… netPnL=${ctx.pnlNetPct.toFixed(2)}%`);
    }
  };
}
