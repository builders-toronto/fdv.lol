import { createAgentOutcomesStore } from "../../evolve/agentOutcomes.js";

export function createAgentDecisionPolicy({
  log,
  getState,
  getAgent,
} = {}) {
  let _evolveOutcomes;
  const _getEvolveOutcomes = () => {
    try {
      if (_evolveOutcomes) return _evolveOutcomes;
      // Use the shared evolve store (same localStorage key).
      _evolveOutcomes = createAgentOutcomesStore({ storageKey: "fdv_agent_outcomes_v1" });
      return _evolveOutcomes;
    } catch {
      return null;
    }
  };
  const _rawLog = typeof log === "function" ? log : () => {};
  const _log = (msg, type) => {
    try { _rawLog(`[AGENT GARY] ${String(msg ?? "")}`, type); } catch { try { _rawLog(String(msg ?? ""), type); } catch {} }
  };
  const _getState = typeof getState === "function" ? getState : () => ({});
  const _getAgent = typeof getAgent === "function" ? getAgent : () => null;

  return async function agentDecisionPolicy(ctx) {
    try {
      const agent = _getAgent();
      if (!agent || typeof agent.decideSell !== "function") return;

      const state = _getState();

      const cfg = (() => {
        try {
          return agent && typeof agent.getConfigFromRuntime === "function" ? agent.getConfigFromRuntime() : {};
        } catch {
          return {};
        }
      })();

      const _riskRaw = String(cfg?.riskLevel || "safe").trim().toLowerCase();
      const _riskLevel = (_riskRaw === "safe" || _riskRaw === "medium" || _riskRaw === "degen") ? _riskRaw : "safe";

      const fullAiControl = !!(ctx?.agentSignals && ctx.agentSignals.fullAiControl === true);

      const _getHardUrgentSignal = () => {
        try {
          const u = ctx?.agentSignals?.urgent;
          if (!u || typeof u !== "object") return null;
          const reason = String(u.reason || "");
          const sev = Number(u.sev || 0);
          // DEGEN bypass: allow rug severity urgents to be handled by the agent unless extremely severe.
          // Safe/Medium retain the existing hard-urgent behavior.
          const isRug = /rug/i.test(reason);
          const hardRugSev = 3.0;
          if (_riskLevel === "degen" && isRug && Number.isFinite(sev) && sev < hardRugSev) return null;

          const hard = (isRug || (Number.isFinite(sev) && sev >= 0.75));
          return hard ? { reason, sev } : null;
        } catch {
          return null;
        }
      };

      // Safety override: hard urgent signals must force an exit even under full AI control.
      const hardUrg = _getHardUrgentSignal();
      if (hardUrg) {
        try {
          ctx.isFastExit = true;
          if (/rug/i.test(hardUrg.reason)) {
            ctx.forceRug = true;
            ctx.rugSev = Number.isFinite(hardUrg.sev) ? hardUrg.sev : Number(ctx?.rugSev || 1);
          }
          ctx.decision = {
            action: "sell_all",
            reason: `URGENT:${String(hardUrg.reason || "unknown")}`,
            hardStop: true,
          };
        } catch {}

        try { _log(`urgent override active; skipping agent decision`); } catch {}
        return;
      }

      const _isSystemHardExit = (decision) => {
        try {
          if (!decision || decision.action === "none") return false;
          const rsn = String(decision.reason || "");
          return (
            /^WARMING\s+MAX\s+LOSS\b/i.test(rsn) ||
            /^WARMING_TARGET\b/i.test(rsn) ||
            /^WARMING\b/i.test(rsn) ||
            /\bURGENT:/i.test(rsn)
          );
        } catch {
          return false;
        }
      };

      const _isSystemSoftExit = (decision) => {
        try {
          if (!decision || decision.action === "none") return false;
          const rsn = String(decision.reason || "");
          return (
            /^SL\b/i.test(rsn) ||
            /^TP\b/i.test(rsn) ||
            /^Trail\b/i.test(rsn) ||
            /^FAST_/i.test(rsn)
          );
        } catch {
          return false;
        }
      };

      const payloadCtx = {
        agentRisk: _riskLevel,
        nowTs: Number(ctx?.nowTs || 0),
        ownerStr: String(ctx?.ownerStr || ""),

		// Extra market/safety signals provided by Trader when available
		agentSignals: ctx?.agentSignals || null,

        // Current valuation
        curSol: Number(ctx?.curSol ?? 0),
        curSolNet: Number(ctx?.curSolNet ?? 0),
        pnlPct: Number(ctx?.pnlPct ?? 0),
        pnlNetPct: Number(ctx?.pnlNetPct ?? 0),

        // Execution constraints
        minNotionalSol: Number(ctx?.minNotional ?? 0),

        // Signals / force flags
        forceRug: !!ctx?.forceRug,
        rugSev: Number(ctx?.rugSev ?? 0),
        forcePumpDrop: !!ctx?.forcePumpDrop,
        forceObserverDrop: !!ctx?.forceObserverDrop,
        forceMomentum: !!ctx?.forceMomentum,
        forceExpire: !!ctx?.forceExpire,
        inMinHold: !!ctx?.inMinHold,
        hasPending: !!ctx?.hasPending,
        isFastExit: !!ctx?.isFastExit,
        inSellGuard: !!ctx?.inSellGuard,

        // Bot config snapshot (agent may supersede knobs; still useful as priors)
        cfg: {
          minHoldSecs: Number(state?.minHoldSecs ?? 0),
          maxHoldSecs: Number(state?.maxHoldSecs ?? 0),
          takeProfitPct: Number(state?.takeProfitPct ?? 0),
          stopLossPct: Number(state?.stopLossPct ?? 0),
          trailPct: Number(state?.trailPct ?? 0),
          minProfitToTrailPct: Number(state?.minProfitToTrailPct ?? 0),
          minNetEdgePct: Number(state?.minNetEdgePct ?? 0),
          edgeSafetyBufferPct: Number(state?.edgeSafetyBufferPct ?? 0),
        },

        // What the existing system decided so far (if any)
        systemDecision: ctx?.decision || null,
      };

      const res = await agent.decideSell({ mint: ctx?.mint, pos: ctx?.pos || {}, ctx: payloadCtx });
      if (!res?.ok || !res?.decision) return;
      const d = res.decision;

      const action = String(d.action || "").trim().toLowerCase();

      if (!fullAiControl) {
        try {
          const allowDuringMinHold = !!(
            ctx?.forceRug ||
            ctx?.forcePumpDrop ||
            ctx?.isFastExit ||
            ctx?.forceExpire
          );
          if (ctx?.inMinHold && !allowDuringMinHold) {
            if (String(d.action || "").toLowerCase() !== "hold") {
              try { _log(`sell ignored (min-hold)`); } catch {}
            }
            return;
          }
        } catch {}
      }

      if (!fullAiControl) {
        try {
          const wantsSell = (action === "sell_all" || action === "sell_partial");
          if (wantsSell) {
            const pnl = Number.isFinite(ctx?.pnlNetPct) ? Number(ctx?.pnlNetPct) : Number(ctx?.pnlPct);
            if (Number.isFinite(pnl)) {
              const floor = Math.max(0, Number(state?.warmingMinProfitFloorPct ?? 0));
              const lossBypass = Math.min(0, Number(state?.warmingProfitFloorLossBypassPct ?? -60));

              const allowBypass = !!(
                ctx?.forceRug ||
                ctx?.forceExpire ||
                ctx?.forcePumpDrop ||
                ctx?.isFastExit
              );

              // Allow severe losses to exit (avoid being trapped).
              if (!allowBypass && pnl > lossBypass && pnl < floor) {
                ctx.decision = {
                  action: "none",
                  reason: `agent-ignored (profit-floor ${floor.toFixed(2)}% pnl=${pnl.toFixed(2)}%)`,
                };
                try { _log(`sell ignored (profit-floor floor=${floor.toFixed(2)} pnl=${pnl.toFixed(2)})`); } catch {}
                return;
              }
            }
          }
        } catch {}
      }

      if (!fullAiControl) {
        try {
          const pnlNet = Number(ctx?.pnlNetPct ?? ctx?.pnlPct ?? NaN);
          if (action === "sell_partial" && !(Number.isFinite(pnlNet) && pnlNet > 0)) {
            ctx.decision = { action: "none", reason: `agent-partial-ignored pnl=${Number.isFinite(pnlNet) ? pnlNet.toFixed(2) : "?"}%` };
            try { _log(`sell_partial ignored (pnl<=0)`); } catch {}
            return;
          }
        } catch {}
      }

    // Optional evolve feedback: annotate recent outcomes with self-critique/lesson.
    try {
      const ev = d && d.evolve;
      if (ev && typeof ev === "object") {
        const store = _getEvolveOutcomes();
        if (store && typeof store.applyEvolve === "function") store.applyEvolve(ev);
      }
    } catch {}

    // Allow agent to suggest runtime knob tuning (handled by Trader after pipeline).
    if (d && d.tune && typeof d.tune === "object") {
      ctx.agentTune = d.tune;
      ctx.agentTuneMeta = { confidence: Number(d.confidence || 0), reason: String(d.reason || "") };
    }

      try {
        const mint = String(ctx?.mint || "").slice(0, 8);
        const fc = d && d.forecast && typeof d.forecast === "object" ? d.forecast : null;
        let ftxt = "";
        if (fc) {
          const up = Number(fc.upProb);
          const exp = Number(fc.expectedMovePct);
          const hs = Number(fc.horizonSecs);
          if (Number.isFinite(up)) ftxt += ` up=${Math.round(up * 100)}%`;
          if (Number.isFinite(exp)) ftxt += ` exp=${exp.toFixed(1)}%`;
          if (Number.isFinite(hs) && hs > 0) ftxt += ` h=${Math.round(hs / 60)}m`;
          if (ftxt) ftxt = ` fcst{${ftxt.trim()}}`;
        }
        _log(`sell decision mint=${mint} action=${String(d.action||"")} conf=${Number(d.confidence||0).toFixed(2)} reason=${String(d.reason||"")}${ftxt}`);
      } catch {}

      const _isSellAllAction = (a) => {
        const s = String(a || "").trim().toLowerCase();
        return (
          s === "sell_all" ||
          s === "sellall" ||
          s === "sell_full" ||
          s === "sellfull" ||
          s === "sell_100" ||
          s === "sell100" ||
          s === "sell" ||
          s === "exit" ||
          s === "close"
        );
      };

      const _isHoldAction = (a) => {
        const s = String(a || "").trim().toLowerCase();
        return (s === "hold" || s === "none" || s === "skip");
      };

    const _extractPnlNetPctSafe = () => {
      try {
        const pnlNet = Number(ctx?.pnlNetPct);
        if (Number.isFinite(pnlNet)) return pnlNet;
        const pnl = Number(ctx?.pnlPct);
        return Number.isFinite(pnl) ? pnl : NaN;
      } catch {
        return NaN;
      }
    };

    const _isStagnantMarket = () => {
      try {
        const past = ctx?.agentSignals?.past;
        const regime = String(past?.regime || past?.label || "").toLowerCase();
        if (/(chop|flat|range|sideways|stagn|stale)/i.test(regime)) return true;
        // Leader-series flattening heuristic: last few slope-like deltas near zero.
        const series = ctx?.agentSignals?.leaderSeries;
        if (Array.isArray(series) && series.length >= 4) {
          const last = series.slice(-4);
          const scoreVals = last
            .map((x) => Number(x?.score01 ?? x?.score ?? x?.pumpScore ?? NaN))
            .filter((n) => Number.isFinite(n));
          if (scoreVals.length >= 3) {
            const deltas = [];
            for (let i = 1; i < scoreVals.length; i++) deltas.push(scoreVals[i] - scoreVals[i - 1]);
            const maxAbs = Math.max(...deltas.map((d) => Math.abs(d)));
            if (Number.isFinite(maxAbs) && maxAbs <= 0.01) return true;
          }
        }
      } catch {}
      return false;
    };

    const _profitThresholdPct = () => {
      try {
        const cfg = ctx?.agentSignals?.cfg;
        const tp = Number(cfg?.takeProfitPct);
        const trailArm = Number(cfg?.minProfitToTrailPct);
        const t0 = Number.isFinite(tp) ? tp : 0;
        const t1 = Number.isFinite(trailArm) ? trailArm : 0;
        return Math.max(0, t0, t1);
      } catch {
        return 0;
      }
    };

      const _isSellPartialAction = (a) => {
        const s = String(a || "").trim().toLowerCase();
        return (
          s === "sell_partial" ||
          s === "sellpartial" ||
          s === "partial" ||
          s === "trim" ||
          s === "reduce"
        );
      };

      if (_isHoldAction(action)) {
    // Profit policy (Full AI control only): if we're up, do not allow the agent to HOLD and miss the exit.
    try {
      if (fullAiControl) {
        const pnl = _extractPnlNetPctSafe();
        if (Number.isFinite(pnl) && pnl > 0) {
          const thr = _profitThresholdPct();
          const stagnant = _isStagnantMarket();
          if ((thr > 0 && pnl >= thr) || stagnant) {
            ctx.decision = { action: "sell_all", reason: `agent-profit-exit pnl=${pnl.toFixed(2)}%${thr > 0 ? ` thr=${thr.toFixed(2)}%` : ""}${stagnant ? " stagnant" : ""}` };
            try { _log(`hold overridden -> sell_all (profit policy)`); } catch {}
            return;
          }

          // Otherwise harvest some profit rather than holding indefinitely.
          ctx.decision = { action: "sell_partial", pct: 50, reason: `agent-profit-harvest pnl=${pnl.toFixed(2)}%` };
          try { _log(`hold overridden -> sell_partial (profit harvest)`); } catch {}
          return;
        }
      }
    } catch {}

        // Agent HOLD veto: in volatile regimes, allow Gary to suppress some system exits
        // (e.g., SL / Trail / FAST_ fades) within bounded risk.
        try {
          const decision = ctx?.decision;
          const hardExit = !!(
            ctx?.forceRug ||
            ctx?.forcePumpDrop ||
            ctx?.forceExpire ||
            ctx?.isFastExit ||
            decision?.hardStop ||
            !!hardUrg ||
            _isSystemHardExit(decision)
          );
          if (hardExit) {
            try { _log(`hold ignored (hard exit active)`); } catch {}
            return;
          }

          if (!fullAiControl) {
            const softExit = _isSystemSoftExit(decision);
            if (softExit) {
              const enabled = (state?.agentHoldVetoEnabled !== false);
              const minConf = Math.max(0, Math.min(1, Number(state?.agentHoldVetoMinConfidence ?? 0.72)));
              const maxLossPct = Math.max(1, Number(state?.agentHoldVetoMaxLossPct ?? 18));
              const conf = Number(d.confidence || 0);
              const pnl = Number.isFinite(ctx?.pnlNetPct) ? Number(ctx?.pnlNetPct) : Number(ctx?.pnlPct);

              const withinLossBand = Number.isFinite(pnl) ? (pnl > -maxLossPct) : false;
              if (!enabled || conf < minConf || !withinLossBand) {
                try {
                  _log(
                    `hold ignored (soft exit active; veto=${enabled ? "on" : "off"} conf=${conf.toFixed(2)}>=${minConf.toFixed(2)} pnl=${Number.isFinite(pnl) ? pnl.toFixed(2) : "?"}% > -${maxLossPct}%)`
                  );
                } catch {}
                return;
              }
            }
          }
        } catch {}

        ctx.decision = { action: "none", reason: `agent-hold ${String(d.reason || "")}`.trim() };
        try { _log(`sell mapped -> none (hold)`); } catch {}
        return;
      }

      if (_isSellAllAction(action)) {
        ctx.decision = {
          action: "sell_all",
          reason: `agent-sell ${String(d.reason || "")}`.trim(),
        };

        try { _log(`sell mapped -> sell_all`); } catch {}
        return;
      }

      if (_isSellPartialAction(action)) {
        const pct = Math.max(1, Math.min(100, Number(d?.sell?.pct ?? d?.pct ?? 50)));
        ctx.decision = {
          action: "sell_partial",
          pct,
          reason: `agent-partial ${String(d.reason || "")}`.trim(),
        };

        try { _log(`sell mapped -> sell_partial pct=${pct}`); } catch {}
      }
    } catch (e) {
      try { _log(`Agent sell policy failed: ${String(e?.message || e || "")}`, "warn"); } catch {}
    }
  };
}
