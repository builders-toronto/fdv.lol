export function createProfitLockPolicy({ log, save }) {
  return function profitLockPolicy(ctx) {
    const armAt   = 10;   // % net
    const retain  = 0.55; // keep 55% of peak
    const bepCush = 0.6;  // % net floor above breakeven
    const harvest = 30;   // % to sell on arm

    if (Number.isFinite(ctx.pnlNetPct)) {
      ctx.pos._peakNetPct = Number.isFinite(ctx.pos._peakNetPct)
        ? Math.max(ctx.pos._peakNetPct, ctx.pnlNetPct)
        : ctx.pnlNetPct;
    }

    if (!ctx.pos._lockArmed && Number.isFinite(ctx.pnlNetPct) && ctx.pnlNetPct >= armAt) {
      ctx.pos._lockArmed = true;
      ctx.pos._lockArmedAt = ctx.nowTs;
      ctx.pos._lockFloorNetPct = Math.max(bepCush, (ctx.pos._peakNetPct || ctx.pnlNetPct) * retain);
      save();
      log(`Profit lock armed ${ctx.mint.slice(0,4)}… peak=${(ctx.pos._peakNetPct||ctx.pnlNetPct).toFixed(2)}% floor≈${ctx.pos._lockFloorNetPct.toFixed(2)}%`);

      if ((!ctx.decision || ctx.decision.action === "none") && harvest > 0) {
        ctx.decision = { action: "sell_partial", pct: harvest, reason: `TP PROFIT_LOCK_ARM ${ctx.pnlNetPct.toFixed(2)}%` };
      }
    }

    if (ctx.pos._lockArmed && Number.isFinite(ctx.pnlNetPct)) {
      const peak = Number(ctx.pos._peakNetPct || ctx.pnlNetPct);
      const floor = Math.max(Number(ctx.pos._lockFloorNetPct || 0), bepCush);
      if (peak > floor / Math.max(1e-9, retain)) {
        ctx.pos._lockFloorNetPct = Math.max(floor, peak * retain);
      }
      if ((!ctx.decision || ctx.decision.action === "none") && ctx.pnlNetPct <= Number(ctx.pos._lockFloorNetPct || floor)) {
        ctx.decision = { action: "sell_all", reason: `TP PROFIT_LOCK_STOP floor=${(ctx.pos._lockFloorNetPct||floor).toFixed(2)}%`, hardStop: false };
        log(`Profit lock stop ${ctx.mint.slice(0,4)}… cur=${ctx.pnlNetPct.toFixed(2)}% <= floor=${(ctx.pos._lockFloorNetPct||floor).toFixed(2)}%`);
      }
    }
  };
}
