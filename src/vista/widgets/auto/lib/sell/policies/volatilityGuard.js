export function createVolatilityGuardPolicy({ log, getState }) {
  return function volatilityGuardPolicy(ctx) {
    const state = getState();
    const postBuyCooldownMs = Math.max(8_000, Number(state.coolDownSecsAfterBuy || 0) * 1000);
    ctx.inWarmingHold = !!(state.rideWarming && ctx.pos.warmingHold === true);
    if (!ctx.leaderMode && (ctx.inSellGuard || ctx.ageMs < postBuyCooldownMs) &&
        (ctx.forceObserverDrop || ctx.forcePumpDrop) && !ctx.inWarmingHold && !ctx.forceRug && !ctx.earlyReason) {
      log(`Volatility sell guard active; suppressing observer/pump drop for ${ctx.mint.slice(0,4)}…`);
      ctx.forceObserverDrop = false;
      ctx.forcePumpDrop = false;
    }
  };
}
