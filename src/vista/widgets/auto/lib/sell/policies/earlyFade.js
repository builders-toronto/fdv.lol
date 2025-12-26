export function createEarlyFadePolicy({ log, clamp, getState, getLeaderSeries, slope3pm }) {
  return function earlyFadePolicy(ctx) {
    try {
      const state = getState();
      const series = getLeaderSeries(ctx.mint, 3);
      const last = series && series.length ? series[series.length - 1] : null;
      const curChg5m = Number(last?.chg5m || 0);
      const scSlopeMin = clamp(slope3pm(series || [], "pumpScore"), -20, 20);

      const scNeg = Number(scSlopeMin) <= Math.min(-1, Number(state.earlyExitScSlopeNeg || -10));
      ctx.pos.earlyNegScCount = scNeg ? (Number(ctx.pos.earlyNegScCount || 0) + 1) : 0;

      const entryChg = Number(ctx.pos.entryChg5m || NaN);
      if (Number.isFinite(entryChg) && entryChg > 0) {
        const dropFrac = (entryChg - curChg5m) / Math.max(1e-6, entryChg);
        if (dropFrac >= Math.max(0.30, Number(state.earlyExitChgDropFrac || 0.4))) {
          ctx.forceObserverDrop = true;
          ctx.earlyReason = `FAST_FADE chg5m -${(dropFrac*100).toFixed(1)}%`;
        }
      }

      if (!ctx.forceObserverDrop) {
        const needConsec = Math.max(1, Number(state.earlyExitConsec || 2));
        if (Number(ctx.pos.earlyNegScCount || 0) >= needConsec) {
          ctx.forceObserverDrop = true;
          ctx.earlyReason = `FAST_FADE scSlope ${scSlopeMin.toFixed(2)}/m x${ctx.pos.earlyNegScCount}`;
        }
      }

      const extended = getLeaderSeries(ctx.mint, 5);
      if (extended && extended.length >= 3) {
        let changes = 0;
        for (let i = 2; i < extended.length; i++) {
          const a = Number(extended[i-2].chg5m || 0);
          const b = Number(extended[i-1].chg5m || 0);
          const c = Number(extended[i].chg5m   || 0);
          const dir1 = Math.sign(b - a);
          const dir2 = Math.sign(c - b);
          if (dir1 && dir2 && dir1 !== dir2) changes++;
        }

        if (!ctx.forceObserverDrop && changes >= 2 && scSlopeMin > -2) {
          ctx.pos.earlyNegScCount = 0;
          ctx.earlyReason = "";
          log(`Jiggle hold: ${ctx.mint.slice(0,4)}… direction changes=${changes} scSlope=${scSlopeMin.toFixed(2)}/m`);
        }

        if (extended.length === 5) {
          let allDown = true;
          for (let i = 1; i < extended.length; i++) {
            if (!(Number(extended[i].chg5m || 0) < Number(extended[i-1].chg5m || 0))) {
              allDown = false; break;
            }
          }
          if (allDown && scSlopeMin < 0) {
            ctx.forceObserverDrop = true;
            ctx.earlyReason = `DOWN_SLOPE_5 scSlope ${scSlopeMin.toFixed(2)}/m`;
          }
        }
      }

      if (ctx.forceObserverDrop) {
        log(`Early-exit: ${ctx.mint.slice(0,4)}… ${ctx.earlyReason} — overriding warming sell guard.`);
      }
    } catch {}
  };
}
