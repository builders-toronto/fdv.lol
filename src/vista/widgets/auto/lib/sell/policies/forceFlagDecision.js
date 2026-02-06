export function createForceFlagDecisionPolicy({ log, getState }) {
  return function forceFlagDecisionPolicy(ctx) {
    const state = getState();

    const pnlNetPct = (() => {
      try {
        const n = Number.isFinite(ctx?.pnlNetPct) ? Number(ctx.pnlNetPct) : Number(ctx?.pnlPct);
        return Number.isFinite(n) ? n : NaN;
      } catch {
        return NaN;
      }
    })();

    const stopLossPct = (() => {
      try {
        const posSl = Math.max(0, Number(ctx?.pos?.slPct ?? 0));
        const stateSl = Math.max(0, Number(state?.stopLossPct ?? 0));
        const base = Math.max(10, posSl, stateSl);
        return Number.isFinite(base) ? base : 10;
      } catch {
        return 10;
      }
    })();

    const inWarmingHold = (() => {
      try {
        return !!(state?.rideWarming && ctx?.pos?.warmingHold === true);
      } catch {
        return false;
      }
    })();

    const agentRisk = (() => {
      try {
        const raw = String(ctx?.agentSignals?.agentRisk || ctx?.agentRisk || "").trim().toLowerCase();
        return (raw === "safe" || raw === "medium" || raw === "degen") ? raw : "";
      } catch {
        return "";
      }
    })();

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
      const hardRugSev = 3.0;

      // DEGEN mode: allow the agent to bypass rug severity force-sells unless it's extremely severe.
      if (agentRisk === "degen" && Number.isFinite(sev) && sev < hardRugSev) {
        try {
          log(`DEGEN: bypassing rug force sell for ${ctx.mint.slice(0,4)}… sev=${sev.toFixed(2)} < ${hardRugSev.toFixed(2)}`);
        } catch {}
        void state;
        return;
      }

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
      const obsReason = String(ctx?.observerReason || "observer detection system");

      if (inMinHold) {
        try {
          log(`Min-hold active; suppressing observer force sell for ${ctx.mint.slice(0,4)}… (${obsReason})`);
        } catch {}
        void state;
        return;
      }

      // Avoid churn: observer-based force sells should not front-run the configured stop-loss.
      // Let standard SL/fast-exit/rug logic handle early/noisy conditions.
      if (Number.isFinite(pnlNetPct) && pnlNetPct > -stopLossPct) {
        try {
          log(
            `${inWarmingHold ? "Warming" : "Observer"}: suppressing force sell for ${ctx.mint.slice(0,4)}… ` +
            `netPnL=${pnlNetPct.toFixed(2)}% > -${stopLossPct.toFixed(2)}% (${obsReason})`
          );
        } catch {}
        try {
          ctx.observerDropSuppressed = true;
          ctx.forceObserverDrop = false;
        } catch {}
        void state;
        return;
      }

      ctx.decision = { action: "sell_all", reason: obsReason };
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
