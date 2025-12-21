export function createUrgentSellStore({
  now,
  getState,
  log,
  wakeSellEval,
  getRugSignalForMint,
  setMintBlacklist,
  urgentSellCooldownMs,
  urgentSellMinAgeMs,
  rugForceSellSeverity,
  mintRugBlacklistMs,
}) {
  function getStore() {
    if (!window._fdvUrgentSell) window._fdvUrgentSell = new Map();
    return window._fdvUrgentSell;
  }

  function flagUrgentSell(mint, reason = "observer", sev = 1) {
    if (!mint) return;

    const state = typeof getState === "function" ? getState() : null;

    try {
      if (state?.holdUntilLeaderSwitch) {
        const sig = getRugSignalForMint?.(mint);
        const isRug = !!sig?.rugged || /rug/i.test(String(reason || ""));
        if (!isRug) return;
      }
    } catch {}

    try {
      const pos = state?.positions?.[mint];
      if (pos) {
        const ageMs = now() - Number(pos.lastBuyAt || pos.acquiredAt || 0);
        const postBuyCooldownMs = Math.max(8_000, Number(state?.coolDownSecsAfterBuy || 0) * 1000);
        const isRug = /rug/i.test(String(reason || ""));

        const highSev = Number(sev || 0) >= Math.max(0.60, Number(rugForceSellSeverity || 0.60));

        if (pos.awaitingSizeSync === true && !isRug && !highSev) return;
        if ((state?.rideWarming && pos.warmingHold === true) && !isRug && !highSev) return;
        if (ageMs < Math.max(Number(urgentSellMinAgeMs || 0), postBuyCooldownMs) && !isRug && !highSev) return;
      }
    } catch {}

    const store = getStore();
    const prev = store.get(mint) || { until: 0 };
    const nowTs = now();
    if (prev.until && nowTs < prev.until) return; // cooldown

    store.set(mint, { reason, sev, until: nowTs + Number(urgentSellCooldownMs || 0) });
    const soft = Number(sev || 0) < 0.75;
    try {
      if (soft) setMintBlacklist?.(mint);
      else setMintBlacklist?.(mint, mintRugBlacklistMs);
    } catch {}

    try {
      log?.(`URGENT: ${reason} for ${mint.slice(0, 4)}… flagged for immediate sell.`);
    } catch {}

    try {
      wakeSellEval?.();
    } catch {}
  }

  function takeUrgentSell(mint) {
    const store = getStore();
    const rec = store.get(mint);
    if (!rec) return null;
    if (now() > rec.until) {
      store.delete(mint);
      return null;
    }
    store.delete(mint);
    return rec;
  }

  return { flagUrgentSell, takeUrgentSell };
}
