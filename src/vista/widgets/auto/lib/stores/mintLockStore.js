export function createMintLockStore({ now, defaultMs } = {}) {
  const _now = typeof now === "function" ? now : () => Date.now();
  const _defaultMs = Number.isFinite(defaultMs) ? defaultMs : 30_000;

  function _getStore() {
    if (!window._fdvMintLocks) window._fdvMintLocks = new Map();
    return window._fdvMintLocks;
  }

  function lockMint(mint, mode = "sell", ms = _defaultMs) {
    if (!mint) return;
    const until = _now() + Math.max(5_000, ms | 0);
    _getStore().set(mint, { mode, until });
  }

  function unlockMint(mint) {
    try {
      _getStore().delete(mint);
    } catch {}
  }

  function isMintLocked(mint) {
    const rec = _getStore().get(mint);
    if (!rec) return false;
    if (_now() > rec.until) {
      _getStore().delete(mint);
      return false;
    }
    return true;
  }

  return {
    lockMint,
    unlockMint,
    isMintLocked,
  };
}
