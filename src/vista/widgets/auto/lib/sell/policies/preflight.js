export function createPreflightSellPolicy({
  now,
  log,
  getState,
  shouldForceMomentumExit,
  verifyRealTokenBalance,
  hasPendingCredit,
} = {}) {
  const _now = typeof now === "function" ? now : () => Date.now();
  const _log = typeof log === "function" ? log : () => {};
  const _getState = typeof getState === "function" ? getState : () => ({});

  return async function preflightSellPolicy(ctx) {
    const { mint, pos, nowTs } = ctx;
    const state = _getState();

    ctx.ageMs = nowTs - Number(pos.lastBuyAt || pos.acquiredAt || 0);
    ctx.maxHold = Math.max(0, Number(state.maxHoldSecs || 0));
    ctx.forceExpire = ctx.maxHold > 0 && ctx.ageMs >= ctx.maxHold * 1000;

    // Router cooldown gate (unless we're at forceExpire)
    try {
      if (!ctx.forceExpire && window._fdvRouterHold && window._fdvRouterHold.get(mint) > _now()) {
        const until = window._fdvRouterHold.get(mint);
        _log(`Router cooldown for ${mint.slice(0, 4)}… until ${new Date(until).toLocaleTimeString()}`);
        return { stop: true };
      }
    } catch {}

    const sz = Number(pos.sizeUi || 0);
    if (sz <= 0) {
      _log(`Skip sell eval for ${mint.slice(0, 4)}… (no size)`);
      return { stop: true };
    }

    ctx.forceMomentum = shouldForceMomentumExit ? shouldForceMomentumExit(mint) : false;

    ctx.inSellGuard = Number(pos.sellGuardUntil || 0) > nowTs;

    // Verify chain balance to avoid phantom exits
    const vr = verifyRealTokenBalance
      ? await verifyRealTokenBalance(ctx.ownerStr, mint, pos)
      : { ok: false, reason: "missing_verify" };

    if (!vr.ok && vr.purged) return { stop: true };
    if (!vr.ok) {
      _log(`Sell skip (unverified balance) ${mint.slice(0, 4)}…`);
      return { stop: true };
    }
    if (Number(vr.sizeUi || 0) <= 1e-9) return { stop: true };

    // Pending credits grace
    ctx.hasPending = typeof hasPendingCredit === "function" ? hasPendingCredit(ctx.ownerStr, mint) : false;
    ctx.creditGraceMs = Math.max(8_000, Number(state.pendingGraceMs || 20_000));
    if ((pos.awaitingSizeSync || ctx.hasPending) && ctx.ageMs < ctx.creditGraceMs) {
      _log(`Sell skip ${mint.slice(0, 4)}… awaiting credit/size sync (${Math.round(ctx.ageMs / 1000)}s).`);
      return { stop: true };
    }

    ctx.sizeOk = true;
    return { stop: false };
  };
}
