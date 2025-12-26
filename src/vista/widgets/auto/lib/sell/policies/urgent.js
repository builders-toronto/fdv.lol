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

    if (ctx.ageMs < _minAgeMs) {
      _log(`Urgent sell suppressed (warmup ${Math.round(ctx.ageMs / 1000)}s) for ${ctx.mint.slice(0, 4)}…`);
      return;
    }

    const isRugUrg = /rug/i.test(String(urgent.reason || ""));
    const highSev = Number(urgent.sev || 0) >= 0.75;

    if (ctx.inSellGuard && !isRugUrg && !highSev) {
      _log(`Sell guard active; deferring urgent sell for ${ctx.mint.slice(0, 4)}…`);
      return;
    }

    // Only consume the urgent signal when we're actually going to act on it.
    if (hasPeekClear) clearUrgentSell(ctx.mint);

    // Urgent exits must survive downstream soft gates (e.g. warming hold) and must not
    // be blocked by notional thresholds. Represent them as an explicit hard-stop decision.
    ctx.isFastExit = true;
    ctx.forceObserverDrop = true;
    ctx.rugSev = Number(urgent.sev || 1);
    ctx.decision = {
      action: "sell_all",
      reason: `URGENT:${String(urgent.reason || "unknown")}`,
      hardStop: true,
    };
    _log(`Urgent sell for ${ctx.mint.slice(0, 4)}… (${urgent.reason}); forcing sell now.`);
  };
}
