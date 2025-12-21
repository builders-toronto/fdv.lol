export function createForceFlagDecisionPolicy({ log, getState }) {
  return function forceFlagDecisionPolicy(ctx) {
    const state = getState();
    if (ctx.forceRug) {
      ctx.decision = { action: "sell_all", reason: `rug sev=${ctx.rugSev.toFixed(2)}` };
    } else if (ctx.forcePumpDrop) {
      ctx.decision = { action: "sell_all", reason: "pump->calm" };
    } else if (ctx.forceObserverDrop) {
      ctx.decision = { action: "sell_all", reason: ctx.earlyReason || "observer detection system" };
    } else if (ctx.forceExpire && (!ctx.decision || ctx.decision.action === "none")) {
      const inPostWarmGrace = Number(ctx.pos.postWarmGraceUntil || 0) > ctx.nowTs;
      if (!inPostWarmGrace) {
        ctx.decision = { action: "sell_all", reason: `max-hold>${ctx.maxHold}s`, hardStop: true };
        log(`Max-hold reached for ${ctx.mint.slice(0,4)}… forcing sell.`);
      } else {
        log(`Max-hold paused by post-warming grace for ${ctx.mint.slice(0,4)}…).`);
      }
    }

    // keep linter happy: state is used indirectly via ctx.maxHold upstream
    void state;
  };
}
