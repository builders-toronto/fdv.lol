export function createObserverPolicy({
  log,
  getState,
  observeMintOnce,
  recordObserverPasses,
  normBadge,
  getRugSignalForMint,
  getDropGuardStore,
  setMintBlacklist,
  noteObserverConsider,
}) {
  return async function observerPolicy(ctx) {
    if (ctx.leaderMode || ctx.forceRug || ctx.forcePumpDrop) return;
    const state = getState();
    try {
      const obs = await observeMintOnce(ctx.mint, { windowMs: 2000, sampleMs: 600, minPasses: 4, adjustHold: !!state.dynamicHoldEnabled });
      if (!obs.ok) {
        if (obs?.unavailable) {
          noteObserverConsider(ctx.mint, 30_000);
          return;
        }
        const p = Number(obs.passes || 0);
        recordObserverPasses(ctx.mint, p);
        const thr = Math.max(0, Number(state.observerDropSellAt ?? 4));

        const badgeNow = normBadge(getRugSignalForMint(ctx.mint)?.badge);
        const pumpingish = (badgeNow === "pumping" || badgeNow === "warming");

        const needLowConsec = pumpingish ? 2 : 1;
        const dg = getDropGuardStore().get(ctx.mint) || {};
        const lowConsec = Number(dg.consecLow || 0);
        const bypassAt = Math.max(0, Number(1));
        const hardBypass = (p <= bypassAt);

        if (p <= 2) {
          if (hardBypass) {
            ctx.forceObserverDrop = true;
            setMintBlacklist(ctx.mint);
            log(`Observer hard drop for ${ctx.mint.slice(0,4)}… (${p}/5 <= ${bypassAt}) forcing sell (staged blacklist).`);
          } else if (ctx.inSellGuard) {
            log(`Sell guard active; suppressing observer drop (${p}/5) for ${ctx.mint.slice(0,4)}…`);
          } else if (lowConsec < needLowConsec) {
            log(`Observer low-pass ${p}/5 while ${badgeNow}; debounce ${lowConsec}/${needLowConsec}. Holding & watching.`);
            noteObserverConsider(ctx.mint, 30_000);
          } else {
            ctx.forceObserverDrop = true;
            setMintBlacklist(ctx.mint);
            log(`Observer drop for ${ctx.mint.slice(0,4)}… (${p}/5 <= 2) forcing sell (staged blacklist).`);
          }
        } else if (p === 3 && thr >= 3) {
          ctx.obsPasses = 3;
        }
      } else {
        recordObserverPasses(ctx.mint, Number(obs.passes || 5));
      }
    } catch {}
  };
}
