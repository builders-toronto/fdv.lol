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
  function _mergeEvidence(prev, next) {
    try {
      if (!prev && !next) return null;
      if (!prev) return next && typeof next === "object" ? { ...next } : null;
      if (!next) return prev && typeof prev === "object" ? { ...prev } : null;
      const out = { ...prev, ...next };
      const prevScore = Number(prev?.score);
      const nextScore = Number(next?.score);
      if (Number.isFinite(prevScore) || Number.isFinite(nextScore)) {
        out.score = Math.max(Number.isFinite(prevScore) ? prevScore : -Infinity, Number.isFinite(nextScore) ? nextScore : -Infinity);
      }
      const prevDd = Number(prev?.ddPct);
      const nextDd = Number(next?.ddPct);
      if (Number.isFinite(prevDd) || Number.isFinite(nextDd)) {
        out.ddPct = Math.max(Number.isFinite(prevDd) ? prevDd : -Infinity, Number.isFinite(nextDd) ? nextDd : -Infinity);
      }
      return out;
    } catch {
      return next && typeof next === "object" ? { ...next } : null;
    }
  }

  function getStore() {
    if (!window._fdvUrgentSell) window._fdvUrgentSell = new Map();
    return window._fdvUrgentSell;
  }

  function flagUrgentSell(mint, reason = "observer", sev = 1, meta = null) {
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
    const nowTs = now();
    const prev = store.get(mint) || { until: 0 };
    const kind = String(meta?.kind || "").trim().toLowerCase();
    const source = String(meta?.source || "").trim();
    const hard = meta?.hard === true || /rug/i.test(String(reason || "")) || Number(sev || 0) >= 0.95;
    const nextUntil = nowTs + Number(urgentSellCooldownMs || 0);
    const nextNeedCount = Math.max(1, Number(meta?.needCount || prev?.needCount || 1));
    const nextQuoteTrustFloor = Number(meta?.quoteTrustFloor);
    const nextEvidence = _mergeEvidence(prev?.evidence, meta?.evidence);
    const sameReason = String(prev?.reason || "") === String(reason || "");

    const rec = (prev.until && nowTs < prev.until)
      ? {
          ...prev,
          reason,
          sev: Math.max(Number(prev?.sev || 0), Number(sev || 0)),
          until: Math.max(Number(prev?.until || 0), nextUntil),
          firstAt: sameReason ? Number(prev?.firstAt || nowTs) : nowTs,
          lastAt: nowTs,
          count: sameReason ? Math.max(1, Number(prev?.count || 1) + 1) : 1,
          kind: kind || String(prev?.kind || ""),
          source: source || String(prev?.source || ""),
          hard: hard || prev?.hard === true,
          needCount: nextNeedCount,
          quoteTrustFloor: Number.isFinite(nextQuoteTrustFloor) ? nextQuoteTrustFloor : prev?.quoteTrustFloor,
          evidence: nextEvidence,
          consumed: sameReason ? false : !!prev?.consumed,
        }
      : {
          reason,
          sev: Number(sev || 0),
          until: nextUntil,
          firstAt: nowTs,
          lastAt: nowTs,
          count: 1,
          kind,
          source,
          hard,
          needCount: nextNeedCount,
          quoteTrustFloor: Number.isFinite(nextQuoteTrustFloor) ? nextQuoteTrustFloor : null,
          evidence: nextEvidence,
          consumed: false,
        };

    store.set(mint, rec);
    const soft = !(rec.hard === true) && Number(rec.sev || 0) < 0.75;
    try {
      if (soft) setMintBlacklist?.(mint);
      else setMintBlacklist?.(mint, mintRugBlacklistMs);
    } catch {}

    try {
      if (Number(rec.count || 1) <= 1) {
        log?.(`URGENT: ${reason} for ${mint.slice(0, 4)}… flagged for immediate sell.`);
      } else {
        log?.(`URGENT: ${reason} for ${mint.slice(0, 4)}… confirm ${Number(rec.count || 1)}/${Number(rec.needCount || 1)}.`);
      }
    } catch {}

    try {
      wakeSellEval?.();
    } catch {}
  }

  function takeUrgentSell(mint) {
    const rec = peekUrgentSell(mint);
    if (!rec) return null;
    clearUrgentSell(mint);
    return rec;
  }

  function peekUrgentSell(mint) {
    const store = getStore();
    const rec = store.get(mint);
    if (!rec) return null;
    if (now() > rec.until) {
      store.delete(mint);
      return null;
    }
    // If already consumed, keep it as a cooldown sentinel but don't surface it.
    if (rec.consumed) return null;
    return rec;
  }

  function clearUrgentSell(mint) {
    const store = getStore();
    const rec = store.get(mint);
    if (!rec) return;
    // Preserve the record until expiry so `flagUrgentSell()` cooldown remains effective.
    // This prevents high-frequency triggers (e.g. fast observer loops) from re-flagging
    // the same mint immediately after the policy consumes the signal.
    store.set(mint, { ...rec, consumed: true, consumedAt: now() });
  }

  return { flagUrgentSell, peekUrgentSell, clearUrgentSell, takeUrgentSell };
}
