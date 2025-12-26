export function createDustCacheStore({ keyPrefix, log } = {}) {
  const prefix = String(keyPrefix || "");
  const _log = typeof log === "function" ? log : () => {};

  function _key(ownerPubkeyStr) {
    return prefix + String(ownerPubkeyStr || "");
  }

  function loadDustCache(ownerPubkeyStr) {
    const k = _key(ownerPubkeyStr);
    if (localStorage.getItem(k) === null) {
      localStorage.setItem(k, JSON.stringify({}));
    }
    try {
      const raw = localStorage.getItem(k) || "{}";
      const obj = JSON.parse(raw) || {};
      _log(`Loaded dust cache for ${String(ownerPubkeyStr || "").slice(0, 4)}… with ${Object.keys(obj).length} entries.`);
      return obj;
    } catch {
      return {};
    }
  }

  function saveDustCache(ownerPubkeyStr, data) {
    const k = _key(ownerPubkeyStr);
    try {
      localStorage.setItem(k, JSON.stringify(data || {}));
      _log(`Saved dust cache for ${String(ownerPubkeyStr || "").slice(0, 4)}… with ${Object.keys(data || {}).length} entries.`);
    } catch {
      _log(`Failed to save dust cache for ${String(ownerPubkeyStr || "").slice(0, 4)}…`, "err");
    }
  }

  function addToDustCache(ownerPubkeyStr, mint, sizeUi, decimals) {
    if (!ownerPubkeyStr || !mint) return;
    const cache = loadDustCache(ownerPubkeyStr);
    cache[mint] = { sizeUi: Number(sizeUi || 0), decimals: Number.isFinite(decimals) ? decimals : 6 };
    saveDustCache(ownerPubkeyStr, cache);
    _log(`Moved to dust cache: ${String(mint).slice(0, 4)}… amt=${Number(sizeUi || 0).toFixed(6)}`);
  }

  function removeFromDustCache(ownerPubkeyStr, mint) {
    if (!ownerPubkeyStr || !mint) return;
    const cache = loadDustCache(ownerPubkeyStr);
    if (cache[mint]) {
      delete cache[mint];
      saveDustCache(ownerPubkeyStr, cache);
    }
  }

  function dustCacheToList(ownerPubkeyStr) {
    const cache = loadDustCache(ownerPubkeyStr);
    return Object.entries(cache)
      .map(([mint, v]) => ({
        mint,
        sizeUi: Number(v?.sizeUi || 0),
        decimals: Number.isFinite(v?.decimals) ? v.decimals : 6,
      }))
      .filter((x) => x.mint && x.sizeUi > 0);
  }

  function isMintInDustCache(ownerPubkeyStr, mint) {
    const cache = loadDustCache(ownerPubkeyStr);
    return !!cache[mint];
  }

  return {
    loadDustCache,
    saveDustCache,
    addToDustCache,
    removeFromDustCache,
    dustCacheToList,
    isMintInDustCache,
  };
}
