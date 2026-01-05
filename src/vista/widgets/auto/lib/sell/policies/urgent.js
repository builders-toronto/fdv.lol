export function createUrgentSellPolicy({
  log,
  takeUrgentSell,
  peekUrgentSell,
  clearUrgentSell,
  urgentSellMinAgeMs,
} = {}) {
  const _log = typeof log === "function" ? log : () => {};
  const _minAgeMs = Number.isFinite(urgentSellMinAgeMs) ? urgentSellMinAgeMs : 7000;

  return function urgentSellPolicy(ctx) {
    const hasPeekClear = typeof peekUrgentSell === "function" && typeof clearUrgentSell === "function";
    const urgent = hasPeekClear
      ? peekUrgentSell(ctx.mint)
      : (typeof takeUrgentSell === "function" ? takeUrgentSell(ctx.mint) : null);
    if (!urgent) return;

    const urgentReason = String(urgent.reason || "");
    const isMomentumUrg = /momentum/i.test(urgentReason);
    const isRugUrg = /rug/i.test(urgentReason);

    const highSev = Number(urgent.sev || 0) >= 0.75;

    // During min-hold, drop non-rug / non-high-severity urgent signals.
    // This prevents force-sells from noisy observers/momentum immediately after entry.
    if (ctx.inMinHold && !isRugUrg && !highSev) {
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

    if (ctx.inSellGuard && !isRugUrg && !highSev) {
      _log(`Sell guard active; deferring urgent sell for ${ctx.mint.slice(0, 4)}…`);
      return;
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
      hardStop: true,
    };
    _log(`Urgent sell for ${ctx.mint.slice(0, 4)}… (${urgent.reason}); forcing sell now.`);
  };
}
