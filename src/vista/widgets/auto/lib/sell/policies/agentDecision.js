export function createAgentDecisionPolicy({
  log,
  getState,
  getAgent,
} = {}) {
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

      const payloadCtx = {
        nowTs: Number(ctx?.nowTs || 0),
        ownerStr: String(ctx?.ownerStr || ""),

		// Extra market/safety signals provided by Trader when available
		agentSignals: ctx?.agentSignals || null,

        // Current valuation
        curSol: Number(ctx?.curSol ?? 0),
        curSolNet: Number(ctx?.curSolNet ?? 0),
        pnlPct: Number(ctx?.pnlPct ?? 0),
        pnlNetPct: Number(ctx?.pnlNetPct ?? 0),

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

    // Allow agent to suggest runtime knob tuning (handled by Trader after pipeline).
    if (d && d.tune && typeof d.tune === "object") {
      ctx.agentTune = d.tune;
      ctx.agentTuneMeta = { confidence: Number(d.confidence || 0), reason: String(d.reason || "") };
    }

      try {
        const mint = String(ctx?.mint || "").slice(0, 8);
        _log(`sell decision mint=${mint} action=${String(d.action||"")} conf=${Number(d.confidence||0).toFixed(2)} reason=${String(d.reason||"")}`);
      } catch {}

      if (d.action === "hold") {
        // Agent explicitly holds: override non-hard forced decisions.
        // Note: execute policy treats action === "none" as no-op.
        ctx.decision = { action: "none", reason: `agent-hold ${String(d.reason || "")}`.trim() };

        try { _log(`sell mapped -> none (hold)`); } catch {}
        return;
      }

      if (d.action === "sell_all") {
        ctx.decision = {
          action: "sell_all",
          reason: `agent-sell ${String(d.reason || "")}`.trim(),
          // preserve hard stop context if already present
          hardStop: !!(ctx?.decision && ctx.decision.hardStop),
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
