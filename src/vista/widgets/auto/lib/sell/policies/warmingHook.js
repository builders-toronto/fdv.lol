export function createWarmingPolicyHook({ applyWarmingPolicy, log }) {
  return function warmingPolicyHook(ctx) {
    const fullAiControl = !!(ctx?.agentSignals && ctx.agentSignals.fullAiControl === true);
    const res = applyWarmingPolicy({
      mint: ctx.mint,
      pos: ctx.pos,
      nowTs: ctx.nowTs,
      pnlNetPct: ctx.pnlNetPct,
      pnlPct: ctx.pnlPct,
      curSol: ctx.curSol,
      decision: ctx.decision,
      forceRug: ctx.forceRug,
      forcePumpDrop: ctx.forcePumpDrop,
      forceObserverDrop: ctx.forceObserverDrop,
      forceEarlyFade: !!ctx.forceEarlyFade,
      fullAiControl,
    });
    // In Full AI control, warming policy should not override agent decisions.
    if (!fullAiControl) {
      ctx.decision = res.decision || ctx.decision;
      ctx.forceObserverDrop = res.forceObserverDrop;
      ctx.forcePumpDrop = res.forcePumpDrop;
    }
    if (res.decision?.hardStop && /WARMING_TARGET|warming[-\s]*max[-\s]*loss/i.test(String(res.decision.reason || ""))) {
      ctx.isFastExit = true;
    }
    ctx.warmingHoldActive = !!res.warmingHoldActive;

    // Attach computed requirement/timing so Agent Gary can respect decay delay.
    try {
      ctx.warmReq = res.warmReq || null;
      if (ctx.agentSignals && typeof ctx.agentSignals === "object") {
        const wr = res.warmReq || null;
        ctx.agentSignals.warming = wr ? {
          reqPct: Number(wr.req || 0),
          basePct: Number(wr.base || 0),
          floorPct: Number(wr.floor || 0),
          perMinPct: Number(wr.perMin || 0),
          elapsedMin: Number(wr.elapsedMin || 0),
          elapsedTotalSec: Number(wr.elapsedTotalSec || 0),
          autoReleaseDue: !!wr.shouldAutoRelease,
        } : null;
      }
    } catch {}
  };
}
