export function createPosCacheStore({ keyPrefix, log } = {}) {
  const prefix = String(keyPrefix || "");
  const _log = typeof log === "function" ? log : () => {};

  function _key(ownerPubkeyStr) {
    return prefix + String(ownerPubkeyStr || "");
  }

  function loadPosCache(ownerPubkeyStr) {
    const k = _key(ownerPubkeyStr);
    if (localStorage.getItem(k) === null) {
      localStorage.setItem(k, JSON.stringify({}));
    }
    try {
      const obj = JSON.parse(localStorage.getItem(k) || "{}") || {};
      _log(`Loaded position cache for ${String(ownerPubkeyStr || "").slice(0, 4)}… with ${Object.keys(obj).length} entries.`);
      return obj;
    } catch {
      return {};
    }
  }

  function savePosCache(ownerPubkeyStr, data) {
    const k = _key(ownerPubkeyStr);
    try {
      localStorage.setItem(k, JSON.stringify(data || {}));
      _log(`Saved position cache for ${String(ownerPubkeyStr || "").slice(0, 4)}… with ${Object.keys(data || {}).length} entries.`);
    } catch {
      _log(`Failed to save position cache for ${String(ownerPubkeyStr || "").slice(0, 4)}…`, "err");
    }
  }

  function updatePosCache(ownerPubkeyStr, mint, sizeUi, decimals) {
    if (!ownerPubkeyStr || !mint) return;
    const k = _key(ownerPubkeyStr);
    if (localStorage.getItem(k) === null) {
      localStorage.setItem(k, JSON.stringify({}));
    }
    const cache = loadPosCache(ownerPubkeyStr);
    if (Number(sizeUi) > 0) {
      cache[mint] = { sizeUi: Number(sizeUi), decimals: Number.isFinite(decimals) ? decimals : 6 };
      savePosCache(ownerPubkeyStr, cache);
      _log(`Updated position cache for ${String(ownerPubkeyStr).slice(0, 4)}… mint ${String(mint).slice(0, 4)}… size ${sizeUi}`);
    }
  }

  function removeFromPosCache(ownerPubkeyStr, mint) {
    if (!ownerPubkeyStr || !mint) return;
    const cache = loadPosCache(ownerPubkeyStr);
    if (cache[mint]) {
      delete cache[mint];
      savePosCache(ownerPubkeyStr, cache);
    }
    _log(`Removed from position cache for ${String(ownerPubkeyStr).slice(0, 4)}… mint ${String(mint).slice(0, 4)}…`);
  }

  function cacheToList(ownerPubkeyStr) {
    const cache = loadPosCache(ownerPubkeyStr);
    const list = Object.entries(cache)
      .map(([mint, v]) => ({
        mint,
        sizeUi: Number(v?.sizeUi || 0),
        decimals: Number.isFinite(v?.decimals) ? v.decimals : 6,
      }))
      .filter((x) => x.mint && x.sizeUi > 0);
    _log(`Position cache to list for ${String(ownerPubkeyStr).slice(0, 4)}… ${list.length} entries.`);
    return list;
  }

  return {
    loadPosCache,
    savePosCache,
    updatePosCache,
    removeFromPosCache,
    cacheToList,
  };
}
