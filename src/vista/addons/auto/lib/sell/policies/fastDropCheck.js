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
        return {
          trigger: true,
          hard: true,
          kind: "rug",
          score: Math.max(1.5, sev),
          reason: `rug sev=${sev.toFixed(2)}`,
          sev,
          evidence: { sev },
        };
      }

      const badge = typeof normBadge === "function" ? normBadge(sig?.badge) : String(sig?.badge || "").toLowerCase();
      const series = typeof getLeaderSeries === "function" ? getLeaderSeries(mint, 3) : null;
      let scSlopeMin = 0;
      let chgSlopeMin = 0;
      let passChg = false;
      let passScore = false;
      if (series && series.length >= 3) {
        const a = series[0];
        const c = series[series.length - 1];
        scSlopeMin = typeof clamp === "function"
          ? clamp(slope3pm(series, "pumpScore"), -20, 20)
          : Number(slope3pm(series, "pumpScore") || 0);
        chgSlopeMin = typeof clamp === "function"
          ? clamp(slope3pm(series, "chg5m"), -60, 60)
          : Number(slope3pm(series, "chg5m") || 0);
        passChg = Number(c?.chg5m || 0) <= Number(a?.chg5m || 0);
        passScore = Number(c?.pumpScore || 0) <= Number(a?.pumpScore || 0) * 0.97;
      }

      if (badge === "cooling") {
        const sz = Number(pos?.sizeUi || 0);
        const curSol = Number(pos?.lastQuotedSol || 0);
        if (sz > 0 && curSol > 0 && Number(pos?.hwmPx || 0) > 0) {
          const pxNow = curSol / sz;
          const ddPct = ((Number(pos.hwmPx) - pxNow) / Math.max(1e-12, Number(pos.hwmPx))) * 100;
          const trailReq = Math.max(1.5, Number(state?.observerDropTrailPct || 2.5));
          const score =
            0.35 +
            Math.min(1.15, ddPct / Math.max(1, trailReq + 0.5)) +
            (chgSlopeMin < 0 ? 0.20 : 0) +
            (scSlopeMin < 0 ? 0.20 : 0) +
            (passChg ? 0.10 : 0) +
            (passScore ? 0.10 : 0);
          const evidence = {
            badge,
            ddPct,
            trailReq,
            chgSlopeMin,
            scSlopeMin,
            passChg,
            passScore,
          };
          if (ddPct >= trailReq) {
            return {
              trigger: score >= 1.2,
              hard: false,
              kind: "cooling",
              score,
              reason: "pump->cooling drawdown",
              sev: Math.max(0.65, Math.min(1.1, 0.45 + score * 0.35)),
              evidence,
            };
          }
        }
      }

      if (series && series.length >= 3) {
        if (passChg && passScore && (scSlopeMin < 0 || chgSlopeMin < 0)) {
          // Momentum drops are informational only (used for risk/rug context), not exit triggers.
          return {
            trigger: false,
            hard: false,
            kind: "momentum",
            score: 0.55,
            reason: "momentum drop (3/5)",
            sev: 0.55,
            momentum: true,
            evidence: { chgSlopeMin, scSlopeMin, passChg, passScore },
          };
        }
      }
    } catch {}

    return { trigger: false, hard: false, kind: "none", score: 0, sev: 0, evidence: null };
  };
}
