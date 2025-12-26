export function createFastExitPolicy({ log, checkFastExitTriggers }) {
  return function fastExitPolicy(ctx) {
    const fast = checkFastExitTriggers(ctx.mint, ctx.pos, { pnlPct: ctx.pnlPct, pxNow: ctx.pxNow, nowTs: ctx.nowTs });
    ctx.fastResult = fast;
    if (fast && fast.action !== "none") {
      ctx.decision = { ...fast };
      ctx.isFastExit = true;
      log(`Fast-exit trigger for ${ctx.mint.slice(0,4)}… -> ${ctx.decision.action} (${ctx.decision.reason}${ctx.decision.pct ? ` ${ctx.decision.pct}%` : ""})`);
    }
  };
}
