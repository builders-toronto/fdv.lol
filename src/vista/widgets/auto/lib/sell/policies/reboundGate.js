export function createReboundGatePolicy({ log, getState, shouldDeferSellForRebound, wakeSellEval, save }) {
  return function reboundGatePolicy(ctx) {
    const state = getState();
    ctx.skipSoftGates = !!(ctx.decision?.hardStop) || /HARD_STOP|FAST_/i.test(String(ctx.decision?.reason||""));
    if (!ctx.decision || ctx.decision.action === "none" || ctx.forceRug) return;

    if (ctx.skipSoftGates) return;
    const stillDeferred = Number(ctx.pos.reboundDeferUntil || 0) > ctx.nowTs;
    if (stillDeferred) {
      log(`Rebound gate: deferral active for ${ctx.mint.slice(0,4)}… skipping sell this tick.`);
      ctx.decision = { action: "none", reason: "rebound-deferral" };
      return;
    }

    const wantDefer = shouldDeferSellForRebound(ctx.mint, ctx.pos, ctx.pnlPct, ctx.nowTs, ctx.decision.reason || "");
    if (wantDefer) {
      ctx.decision = { action: "none", reason: "rebound-predict-hold" };
      const waitMs = Math.max(800, Number(state.reboundHoldMs || 4000));
      setTimeout(() => { try { wakeSellEval(); } catch {} }, waitMs);
    } else if (ctx.pos.reboundDeferUntil || ctx.pos.reboundDeferStartedAt) {
      delete ctx.pos.reboundDeferUntil;
      delete ctx.pos.reboundDeferStartedAt;
      delete ctx.pos.reboundDeferCount;
      save();
    }
  };
}
