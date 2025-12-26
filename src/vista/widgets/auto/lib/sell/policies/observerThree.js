export function createObserverThreePolicy({ log, shouldForceSellAtThree, setMintBlacklist, MINT_RUG_BLACKLIST_MS, noteObserverConsider }) {
  return function observerThreePolicy(ctx) {
    if (ctx.forceRug || ctx.forcePumpDrop || ctx.forceObserverDrop) return;
    if (ctx.obsPasses !== 3) return;
    const should = shouldForceSellAtThree(ctx.mint, ctx.pos, ctx.curSol, ctx.nowTs);
    if (should) {
      if (ctx.inSellGuard) {
        log(`Sell guard active; deferring 3/5 observer sell for ${ctx.mint.slice(0,4)}…`);
      } else {
        ctx.forceObserverDrop = true;
        setMintBlacklist(ctx.mint, MINT_RUG_BLACKLIST_MS);
        log(`Observer 3/5 debounced -> forcing sell (${ctx.mint.slice(0,4)}…) and blacklisting 30m.`);
      }
    } else {
      log(`Observer 3/5 for ${ctx.mint.slice(0,4)}… soft-watch; debounce active (no sell).`);
      noteObserverConsider(ctx.mint, 30_000);
    }
  };
}
