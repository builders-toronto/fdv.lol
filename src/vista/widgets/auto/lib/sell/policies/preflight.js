export function createPreflightSellPolicy({
  now,
  log,
  getState,
  shouldForceMomentumExit,
  verifyRealTokenBalance,
  hasPendingCredit,
  peekUrgentSell,
} = {}) {
  const _now = typeof now === "function" ? now : () => Date.now();
  const _log = typeof log === "function" ? log : () => {};
  const _getState = typeof getState === "function" ? getState : () => ({});

  return async function preflightSellPolicy(ctx) {
    const { mint, pos, nowTs } = ctx;
    const state = _getState();

    const fullAiControl = !!(ctx?.agentSignals && ctx.agentSignals.fullAiControl === true);

    ctx.ageMs = nowTs - Number(pos.lastBuyAt || pos.acquiredAt || 0);
    ctx.minHoldMs = Math.max(0, Number(state.minHoldSecs || 0)) * 1000;
    ctx.inMinHold = ctx.minHoldMs > 0 && ctx.ageMs < ctx.minHoldMs;
    ctx.maxHold = Math.max(0, Number(state.maxHoldSecs || 0));
    ctx.forceExpire = ctx.maxHold > 0 && ctx.ageMs >= ctx.maxHold * 1000;

  	// Momentum drop is informational/risk-only; it must not force exits.
  	ctx.forceMomentum = false;

    // Peek urgent signal early (if available) so we can bypass cooldown gates when needed.
    const urgent = (typeof peekUrgentSell === "function") ? peekUrgentSell(mint) : null;
    const urgentReason = String(urgent?.reason || "");
    const urgentSev = Number(urgent?.sev || 0);
    const urgentHard = !!urgent && (/rug/i.test(urgentReason) || urgentSev >= 0.75);

    // Router cooldown gate (unless we're at forceExpire)
    try {
      if (!ctx.forceExpire && window._fdvRouterHold && window._fdvRouterHold.get(mint) > _now()) {
        const until = window._fdvRouterHold.get(mint);
		if (urgentHard) {
			_log(`Router cooldown bypass for ${mint.slice(0, 4)}… (urgent hard-exit)`);
        } else {
          _log(`Router cooldown for ${mint.slice(0, 4)}… until ${new Date(until).toLocaleTimeString()}`);
          return { stop: true };
        }
      }
    } catch {}

    ctx.inSellGuard = Number(pos.sellGuardUntil || 0) > nowTs;

    // Min-hold is a soft gate: we still run valuation/policies so we can react to SL/profit-lock.
    // Sell-guard remains a hard gate to prevent thrashy exits.
    if (!fullAiControl && !ctx.forceExpire && !urgentHard && ctx.inSellGuard) {
      const reasons = [
        ctx.inMinHold ? `min-hold ${Math.max(0, Math.ceil((ctx.minHoldMs - ctx.ageMs) / 1000))}s left` : null,
        ctx.inSellGuard ? `sell-guard ${(Math.max(0, Math.ceil((Number(pos.sellGuardUntil || 0) - nowTs) / 1000)))}s left` : null,
      ].filter(Boolean);
      _log(`Sell skip ${mint.slice(0, 4)}… (${reasons.join(", ")}).`);
      return { stop: true };
    }

    if (!fullAiControl && !ctx.forceExpire && !urgentHard && ctx.inMinHold) {
      _log(`Sell eval ${mint.slice(0, 4)}… (min-hold soft; ${Math.max(0, Math.ceil((ctx.minHoldMs - ctx.ageMs) / 1000))}s left).`);
    }

    // Verify chain balance to avoid phantom exits
    const vr = verifyRealTokenBalance
      ? await verifyRealTokenBalance(ctx.ownerStr, mint, pos)
      : { ok: false, reason: "missing_verify" };

    if (!vr.ok && vr.purged) return { stop: true };
    if (!vr.ok) {
      _log(`Sell skip (unverified balance) ${mint.slice(0, 4)}…`);
      return { stop: true };
    }
    if (Number(vr.sizeUi || 0) <= 1e-9) {
      _log(`Skip sell eval for ${mint.slice(0, 4)}… (no on-chain size)`);
      return { stop: true };
    }

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
