export function createUrgentSellPolicy({
  log,
  takeUrgentSell,
  peekUrgentSell,
  clearUrgentSell,
  urgentSellMinAgeMs,
} = {}) {
  const _log = typeof log === "function" ? log : () => {};
  const _minAgeMs = Number.isFinite(urgentSellMinAgeMs) ? urgentSellMinAgeMs : 7000;

  const _num = (v, fallback = NaN) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  return function urgentSellPolicy(ctx) {
    const hasPeekClear = typeof peekUrgentSell === "function" && typeof clearUrgentSell === "function";
    const urgent = hasPeekClear
      ? peekUrgentSell(ctx.mint)
      : (typeof takeUrgentSell === "function" ? takeUrgentSell(ctx.mint) : null);
    if (!urgent) return;

    const urgentReason = String(urgent.reason || "");
    const isMomentumUrg = /momentum/i.test(urgentReason);
    const isRugUrg = /rug/i.test(urgentReason);
    const urgentKind = String(urgent.kind || (isRugUrg ? "rug" : "")).trim().toLowerCase();
    const urgentCount = Math.max(1, _num(urgent.count, 1));
    const urgentNeedCount = Math.max(1, _num(urgent.needCount, 1));
    const urgentScore = _num(urgent?.evidence?.score, 0);

    const highSev = Number(urgent.sev || 0) >= 0.75;
    const hardUrg = urgent?.hard === true || isRugUrg || Number(urgent.sev || 0) >= 0.9;

    ctx.urgentMeta = {
      reason: urgentReason,
      sev: Number(urgent.sev || 0),
      kind: urgentKind,
      count: urgentCount,
      needCount: urgentNeedCount,
      hard: hardUrg,
      evidence: urgent?.evidence || null,
    };

    const agentRisk = (() => {
      try {
        const raw = String(ctx?.agentSignals?.agentRisk || ctx?.agentRisk || "").trim().toLowerCase();
        return (raw === "safe" || raw === "medium" || raw === "degen") ? raw : "";
      } catch {
        return "";
      }
    })();

    const stopLossPct = (() => {
      try {
        const posSl = Math.max(0, Number(ctx?.pos?.slPct ?? 0));
        const cfgSl = Math.max(0, Number(ctx?.agentSignals?.cfg?.stopLossPct ?? 0));
        return Math.max(posSl, cfgSl, 0);
      } catch {
        return 0;
      }
    })();

    const pnlNetPct = (() => {
      try {
        const n = Number.isFinite(ctx?.pnlNetPct) ? Number(ctx.pnlNetPct) : Number(ctx?.pnlPct);
        return Number.isFinite(n) ? n : NaN;
      } catch {
        return NaN;
      }
    })();

    const quoteTrust = (() => {
      try {
        const n = Number(ctx?.quoteTrust);
        return Number.isFinite(n) ? n : 1;
      } catch {
        return 1;
      }
    })();

    const trustFloor = (() => {
      const explicit = Number(urgent?.quoteTrustFloor);
      if (Number.isFinite(explicit)) return explicit;
      if (urgentKind === "quote_shock") return 0.6;
      if (urgentKind === "cooling") return 0.45;
      return 0.35;
    })();

    // DEGEN mode: allow bypassing rug severity urgent exits unless extremely severe.
    if (agentRisk === "degen" && isRugUrg) {
      const sev = Number(urgent.sev || 0);
      const hardRugSev = 3.0;
      if (Number.isFinite(sev) && sev < hardRugSev) {
        if (hasPeekClear) clearUrgentSell(ctx.mint);
        _log(`DEGEN: bypassing urgent rug exit for ${ctx.mint.slice(0, 4)}… (sev=${sev.toFixed(2)} < ${hardRugSev.toFixed(2)})`);
        return;
      }
    }

    if (!hardUrg) {
      if (quoteTrust < trustFloor) {
        if (hasPeekClear) clearUrgentSell(ctx.mint);
        _log(`Urgent sell suppressed for ${ctx.mint.slice(0, 4)}… low quote trust ${quoteTrust.toFixed(2)} < ${trustFloor.toFixed(2)} (${urgentReason})`);
        return;
      }

      const softNeedsConfirm = urgentKind === "cooling" || urgentKind === "quote_shock" || /observer|cooling|quote/i.test(urgentReason);
      if (softNeedsConfirm && urgentCount < urgentNeedCount && urgentScore < 1.25) {
        if (hasPeekClear) clearUrgentSell(ctx.mint);
        _log(`Urgent sell deferred for ${ctx.mint.slice(0, 4)}… awaiting confirmation ${urgentCount}/${urgentNeedCount} (${urgentReason})`);
        return;
      }
    }

    // During min-hold, drop non-rug / non-high-severity urgent signals.
    // This prevents force-sells from noisy observers/momentum immediately after entry.
    if (ctx.inMinHold && !hardUrg && !highSev) {
      if (hasPeekClear) clearUrgentSell(ctx.mint);
      _log(
        `Min-hold active; dropping urgent sell for ${ctx.mint.slice(0, 4)}… (${Math.round(ctx.ageMs / 1000)}s < ${Math.round((Number(ctx.minHoldMs || 0) || 0) / 1000)}s)`
      );
      return;
    }

    if (ctx.ageMs < _minAgeMs) {
      _log(`Urgent sell suppressed (warmup ${Math.round(ctx.ageMs / 1000)}s) for ${ctx.mint.slice(0, 4)}…`);
      return;
    }

    if (ctx.inSellGuard && !hardUrg && !highSev) {
      _log(`Sell guard active; deferring urgent sell for ${ctx.mint.slice(0, 4)}…`);
      return;
    }

    if (!hardUrg && agentRisk === "degen" && !isMomentumUrg) {
      const mildLossFloor = -Math.max(stopLossPct + 2, 10);
      if (Number.isFinite(pnlNetPct) && pnlNetPct >= mildLossFloor) {
        const pct = Math.max(20, Math.min(80, Number.isFinite(pnlNetPct) && pnlNetPct > 0 ? 50 : 35));
        if (hasPeekClear) clearUrgentSell(ctx.mint);
        ctx.isFastExit = true;
        ctx.forceObserverDrop = true;
        ctx.decision = {
          action: "sell_partial",
          pct,
          reason: `URGENT_PARTIAL:${String(urgent.reason || "unknown")}`,
        };
        _log(`Urgent de-risk for ${ctx.mint.slice(0, 4)}… selling ${pct}% (${urgentReason})`);
        return;
      }
    }

    // Only consume the urgent signal when we're actually going to act on it.
    if (hasPeekClear) clearUrgentSell(ctx.mint);

    // Urgent exits must survive downstream
    ctx.isFastExit = true;
    ctx.forceObserverDrop = !isRugUrg;
    if (isRugUrg) {
      ctx.forceRug = true;
      ctx.rugSev = Number(urgent.sev || 1);
    } else {
      ctx.rugSev = Number(ctx.rugSev || 0);
    }
    ctx.decision = {
      action: "sell_all",
      reason: `URGENT:${String(urgent.reason || "unknown")}`,
      hardStop: hardUrg,
    };
    _log(`Urgent sell for ${ctx.mint.slice(0, 4)}… (${urgent.reason}); forcing sell now.`);
  };
}
