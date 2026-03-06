export function createFastDropCheckPolicy({
  getState,
  getRugSignalForMint,
  rugForceSellSeverity,
  normBadge,
  getLeaderSeries,
  slope3pm,
  clamp,
}) {
  return function fastDropCheck(mint, pos) {
    try {
      const state = typeof getState === "function" ? getState() : {};
      const sig = typeof getRugSignalForMint === "function" ? getRugSignalForMint(mint) : null;

      const sev = Number(sig?.sev ?? 0);
      if (sig?.rugged && sev >= Number(rugForceSellSeverity || 0)) {
        return { trigger: true, reason: `rug sev=${sev.toFixed(2)}`, sev };
      }

      const badge = typeof normBadge === "function" ? normBadge(sig?.badge) : String(sig?.badge || "").toLowerCase();
      if (badge === "cooling") {
        const sz = Number(pos?.sizeUi || 0);
        const curSol = Number(pos?.lastQuotedSol || 0);
        if (sz > 0 && curSol > 0 && Number(pos?.hwmPx || 0) > 0) {
          const pxNow = curSol / sz;
          const ddPct = ((Number(pos.hwmPx) - pxNow) / Math.max(1e-12, Number(pos.hwmPx))) * 100;
          if (ddPct >= Math.max(1.5, Number(state?.observerDropTrailPct || 2.5))) {
            return { trigger: true, reason: "pump->cooling drawdown", sev: 1 };
          }
        }
      }

      const series = typeof getLeaderSeries === "function" ? getLeaderSeries(mint, 3) : null;
      if (series && series.length >= 3) {
        const a = series[0];
        const c = series[series.length - 1];
        const scSlopeMin = typeof clamp === "function"
          ? clamp(slope3pm(series, "pumpScore"), -20, 20)
          : Number(slope3pm(series, "pumpScore") || 0);
        const chgSlopeMin = typeof clamp === "function"
          ? clamp(slope3pm(series, "chg5m"), -60, 60)
          : Number(slope3pm(series, "chg5m") || 0);
        const passChg = Number(c?.chg5m || 0) <= Number(a?.chg5m || 0);
        const passScore = Number(c?.pumpScore || 0) <= Number(a?.pumpScore || 0) * 0.97;
        if (passChg && passScore && (scSlopeMin < 0 || chgSlopeMin < 0)) {
          // Momentum drops are informational only (used for risk/rug context), not exit triggers.
          return { trigger: false, reason: "momentum drop (3/5)", sev: 0.55, momentum: true };
        }
      }
    } catch {}

    return { trigger: false };
  };
}
