export function createRugPumpDropPolicy({
  log,
  getRugSignalForMint,
  recordBadgeTransition,
  normBadge,
  isPumpDropBanned,
  setMintBlacklist,
  RUG_FORCE_SELL_SEVERITY,
  MINT_RUG_BLACKLIST_MS,
}) {
  return function rugPumpDropPolicy(ctx) {
    try {
      const sig = getRugSignalForMint(ctx.mint);
      recordBadgeTransition(ctx.mint, sig.badge);

      const badgeNorm = normBadge(sig.badge);
      const sev = Number(sig?.sev ?? 0);
      const sevThreshold = RUG_FORCE_SELL_SEVERITY;

      if (sig?.rugged && sev >= sevThreshold) {
        ctx.forceRug = true;
        ctx.rugSev = sev;
        setMintBlacklist(ctx.mint, MINT_RUG_BLACKLIST_MS);
        log(`Rug detected for ${ctx.mint.slice(0,4)}… sev=${ctx.rugSev.toFixed(2)} (thr=${sevThreshold.toFixed(2)}). Forcing sell and blacklisting 30m.`);
      } else if (sig?.rugged) {
        setMintBlacklist(ctx.mint);
        log(`Rug soft-flag for ${ctx.mint.slice(0,4)}… sev=${sev.toFixed(2)} < ${sevThreshold.toFixed(2)} — staged blacklist, no forced sell.`);
      } else if (!ctx.leaderMode) {
        const curNorm = badgeNorm;
        // surface transition only in host logger; policy just sets pump-drop ban
        if (curNorm === "calm" && isPumpDropBanned(ctx.mint)) {
          ctx.forcePumpDrop = true;
          log(`Pump->Calm drop for ${ctx.mint.slice(0,4)}… forcing sell and banning re-buys for 30m.`);
        }
      }
    } catch {}
  };
}
