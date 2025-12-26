export function createBuySeedStore({ now, ttlMs } = {}) {
  const _now = typeof now === "function" ? now : () => Date.now();
  const _ttlMs = Number.isFinite(ttlMs) ? ttlMs : 60_000;

  function _getStore() {
    if (!window._fdvBuySeeds) window._fdvBuySeeds = new Map();
    return window._fdvBuySeeds;
  }

  function _seedKey(owner, mint) {
    return `${owner}:${mint}`;
  }

  function putBuySeed(owner, mint, seed) {
    if (!owner || !mint || !seed) return;
    const s = _getStore();
    const k = _seedKey(owner, mint);
    const prev = s.get(k);
    const next = prev
      ? {
          ...prev,
          sizeUi: Number(prev.sizeUi || 0) + Number(seed.sizeUi || 0),
          costSol: Number(prev.costSol || 0) + Number(seed.costSol || 0),
          decimals: Number.isFinite(seed.decimals) ? seed.decimals : (prev.decimals ?? 6),
          at: _now(),
        }
      : { ...seed, owner, mint, at: _now() };
    s.set(k, next);
  }

  function getBuySeed(owner, mint) {
    try {
      const s = _getStore();
      const k = _seedKey(owner, mint);
      const rec = s.get(k);
      if (!rec) return null;
      if ((_now() - Number(rec.at || 0)) > _ttlMs) {
        s.delete(k);
        return null;
      }
      return rec;
    } catch {
      return null;
    }
  }

  function clearBuySeed(owner, mint) {
    try {
      _getStore().delete(_seedKey(owner, mint));
    } catch {}
  }

  return {
    putBuySeed,
    getBuySeed,
    clearBuySeed,
  };
}
