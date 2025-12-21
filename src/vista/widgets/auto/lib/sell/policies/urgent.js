export function createUrgentSellPolicy({ log, takeUrgentSell, urgentSellMinAgeMs } = {}) {
  const _log = typeof log === "function" ? log : () => {};
  const _minAgeMs = Number.isFinite(urgentSellMinAgeMs) ? urgentSellMinAgeMs : 7000;

  return function urgentSellPolicy(ctx) {
    const urgent = typeof takeUrgentSell === "function" ? takeUrgentSell(ctx.mint) : null;
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

    ctx.forceObserverDrop = true;
    ctx.rugSev = Number(urgent.sev || 1);
    _log(`Urgent sell for ${ctx.mint.slice(0, 4)}… (${urgent.reason}); bypassing notional/cooldowns.`);
  };
}
