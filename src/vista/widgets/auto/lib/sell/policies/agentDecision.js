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

      const fullAiControl = !!(ctx?.agentSignals && ctx.agentSignals.fullAiControl === true);

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

      const cfg = (() => {
        try {
          return agent && typeof agent.getConfigFromRuntime === "function" ? agent.getConfigFromRuntime() : {};
        } catch {
          return {};
        }
      })();

      const _riskRaw = String(cfg?.riskLevel || "safe").trim().toLowerCase();
      const _riskLevel = (_riskRaw === "safe" || _riskRaw === "medium" || _riskRaw === "degen") ? _riskRaw : "safe";

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
          const action = String(d.action || "").toLowerCase();
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
          const action = String(d.action || "").toLowerCase();
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

      if (d.action === "hold") {
        // Agent HOLD veto: in volatile regimes, allow Gary to suppress some system exits
        // (e.g., SL / Trail / FAST_ fades) within bounded risk.
        if (!fullAiControl) {
          try {
            const decision = ctx?.decision;
            const hardExit = !!(
              ctx?.forceRug ||
              ctx?.forcePumpDrop ||
              ctx?.forceExpire ||
              ctx?.isFastExit ||
              _isSystemHardExit(decision)
            );
            if (hardExit) {
              try { _log(`hold ignored (hard exit active)`); } catch {}
              return;
            }

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
          } catch {}
        }

        ctx.decision = { action: "none", reason: `agent-hold ${String(d.reason || "")}`.trim() };
        try { _log(`sell mapped -> none (hold)`); } catch {}
        return;
      }

      if (d.action === "sell_all") {
        ctx.decision = {
          action: "sell_all",
          reason: `agent-sell ${String(d.reason || "")}`.trim(),
        };

        try { _log(`sell mapped -> sell_all`); } catch {}
        return;
      }

      if (d.action === "sell_partial") {
        const pct = Math.max(1, Math.min(100, Number(d?.sell?.pct ?? 50)));
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
