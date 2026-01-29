export function createProfitLockPolicy({ log, save, getState } = {}) {
  const _log = typeof log === "function" ? log : () => {};
  const _save = typeof save === "function" ? save : () => {};
  const _getState = typeof getState === "function" ? getState : () => ({});

  return function profitLockPolicy(ctx) {
    const s = _getState() || {};

    const enabled = (s.profitLockEnabled ?? true) !== false;
    if (!enabled) return;

    // Defaults match prior behavior.
    let armAt   = Number(s.profitLockArmNetPct ?? 10);      // % net
    let retain  = Number(s.profitLockRetainFrac ?? 0.55);   // keep % of peak
    let bepCush = Number(s.profitLockBepCushNetPct ?? 0.6); // % net floor above breakeven
    let harvest = Number(s.profitLockHarvestPct ?? 30);     // % to sell on arm

    armAt = Math.max(0, armAt);
    retain = Math.min(0.95, Math.max(0.05, retain));
    bepCush = Math.max(0, bepCush);
    harvest = Math.min(100, Math.max(0, harvest));

    const inWarmingHold = !!ctx?.warmingHoldActive;
    const allowArmDuringWarming = (s.profitLockArmDuringWarming ?? false) === true;
    const useWarmReqArm = (s.profitLockUseWarmReqArm ?? true) === true;
    const allowHarvestDuringWarming = (s.profitLockHarvestDuringWarming ?? false) === true;

    // Prevent profit-lock from "melting" the warming/decay regime by default.
    // We still allow an *already armed* lock to stop out; we just avoid arming/harvesting during warming unless enabled.
    if (inWarmingHold && !allowArmDuringWarming) {
      harvest = 0;
    }

    if (inWarmingHold && allowArmDuringWarming && useWarmReqArm) {
      const wr = Number(ctx?.warmReq?.req ?? NaN);
      if (Number.isFinite(wr) && wr > 0) armAt = Math.max(armAt, wr);
      if (!allowHarvestDuringWarming) harvest = 0;
    }

    if (Number.isFinite(ctx.pnlNetPct)) {
      ctx.pos._peakNetPct = Number.isFinite(ctx.pos._peakNetPct)
        ? Math.max(ctx.pos._peakNetPct, ctx.pnlNetPct)
        : ctx.pnlNetPct;
    }

    if (!ctx.pos._lockArmed && Number.isFinite(ctx.pnlNetPct) && ctx.pnlNetPct >= armAt) {
      ctx.pos._lockArmed = true;
      ctx.pos._lockArmedAt = ctx.nowTs;
      ctx.pos._lockFloorNetPct = Math.max(bepCush, (ctx.pos._peakNetPct || ctx.pnlNetPct) * retain);
      _save();
      _log(`Profit lock armed ${ctx.mint.slice(0,4)}… peak=${(ctx.pos._peakNetPct||ctx.pnlNetPct).toFixed(2)}% floor≈${ctx.pos._lockFloorNetPct.toFixed(2)}%`);

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
        _log(`Profit lock stop ${ctx.mint.slice(0,4)}… cur=${ctx.pnlNetPct.toFixed(2)}% <= floor=${(ctx.pos._lockFloorNetPct||floor).toFixed(2)}%`);
      }
    }
  };
}
