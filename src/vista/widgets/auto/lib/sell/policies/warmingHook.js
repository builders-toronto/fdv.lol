export function createWarmingPolicyHook({ applyWarmingPolicy, log }) {
  return function warmingPolicyHook(ctx) {
    const res = applyWarmingPolicy({
      mint: ctx.mint,
      pos: ctx.pos,
      nowTs: ctx.nowTs,
      pnlPct: ctx.pnlPct,
      curSol: ctx.curSol,
      decision: ctx.decision,
      forceRug: ctx.forceRug,
      forcePumpDrop: ctx.forcePumpDrop,
      forceObserverDrop: ctx.forceObserverDrop,
      forceEarlyFade: !!ctx.earlyReason,
    });
    ctx.decision = res.decision || ctx.decision;
    ctx.forceObserverDrop = res.forceObserverDrop;
    ctx.forcePumpDrop = res.forcePumpDrop;
    if (res.decision?.hardStop && /WARMING_TARGET|warming[-\s]*max[-\s]*loss/i.test(String(res.decision.reason || ""))) {
      ctx.isFastExit = true;
    }
    ctx.warmingHoldActive = !!res.warmingHoldActive;
  };
}
