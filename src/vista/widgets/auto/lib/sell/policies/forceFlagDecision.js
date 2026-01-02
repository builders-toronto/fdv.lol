export function createForceFlagDecisionPolicy({ log, getState }) {
  return function forceFlagDecisionPolicy(ctx) {
    const state = getState();

    const inMinHold = (() => {
      try {
        if (ctx?.inMinHold === true) return true;
        const minHoldMs = Math.max(0, Number(state?.minHoldSecs || 0) * 1000);
        if (minHoldMs <= 0) return false;
        const nowTs = Number(ctx?.nowTs || 0) || Date.now();
        const acquiredAt = Number(ctx?.pos?.acquiredAt || ctx?.pos?.lastBuyAt || 0);
        if (!acquiredAt) return false;
        const ageMs = nowTs - acquiredAt;
        return ageMs >= 0 && ageMs < minHoldMs;
      } catch {
        return false;
      }
    })();

    if (ctx?.decision?.hardStop) {
      void state;
      return;
    }

    // If we're already in a fast-exit path with an explicit decision, preserve it.
    if (ctx?.isFastExit && ctx?.decision && ctx.decision.action && ctx.decision.action !== "none") {
      void state;
      return;
    }

    if (ctx.forceRug) {
      const sev = Number(ctx?.rugSev ?? 0);
      const hardRugSev = 2.0;
      if (inMinHold && Number.isFinite(sev) && sev < hardRugSev) {
        try {
          log(`Min-hold active; suppressing rug force sell for ${ctx.mint.slice(0,4)}… sev=${sev.toFixed(2)} < ${hardRugSev.toFixed(2)}`);
        } catch {}
      } else {
        ctx.decision = { action: "sell_all", reason: `rug sev=${sev.toFixed(2)}` };
      }
    } else if (ctx.forcePumpDrop) {
      if (inMinHold) {
        try { log(`Min-hold active; suppressing pump-drop force sell for ${ctx.mint.slice(0,4)}…`); } catch {}
      } else {
        ctx.decision = { action: "sell_all", reason: "pump->calm" };
      }
    } else if (ctx.forceObserverDrop) {
      if (inMinHold) {
        try {
          const rsn = String(ctx.earlyReason || "observer detection system");
          log(`Min-hold active; suppressing observer force sell for ${ctx.mint.slice(0,4)}… (${rsn})`);
        } catch {}
      } else {
        ctx.decision = { action: "sell_all", reason: ctx.earlyReason || "observer detection system" };
      }
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
