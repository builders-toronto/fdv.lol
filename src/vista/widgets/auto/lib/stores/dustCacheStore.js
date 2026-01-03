export function createDustCacheStore({ keyPrefix, log } = {}) {
  const prefix = String(keyPrefix || "");
  const _log = typeof log === "function" ? log : () => {};

  const _mem = new Map();

  // NOTE: `localStorage` is synchronous and can block the UI thread.
  // Keep an in-memory copy and only reload when explicitly invalidated.
  // This avoids repeated reads on hot paths (poll loops, quote loops, etc.).

  function _key(ownerPubkeyStr) {
    return prefix + String(ownerPubkeyStr || "");
  }

  function _getMem(ownerPubkeyStr) {
    const owner = String(ownerPubkeyStr || "");
    if (!owner) return null;
    const hit = _mem.get(owner);
    if (!hit) return null;
    return hit;
  }

  function _setMem(ownerPubkeyStr, data, { loadedAt = Date.now() } = {}) {
    const owner = String(ownerPubkeyStr || "");
    if (!owner) return;
    _mem.set(owner, {
      data: data && typeof data === "object" ? data : {},
      loadedAt,
    });
  }

  function invalidateDustCache(ownerPubkeyStr) {
    try {
      const owner = String(ownerPubkeyStr || "");
      if (!owner) return false;
      _mem.delete(owner);
      return true;
    } catch {
      return false;
    }
  }

  // Best-effort cross-tab consistency without polling localStorage.
  try {
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("storage", (e) => {
        try {
          const k = String(e?.key || "");
          if (!k || !prefix) return;
          if (!k.startsWith(prefix)) return;
          const owner = k.slice(prefix.length);
          if (owner) _mem.delete(owner);
        } catch {}
      });
    }
  } catch {}

  function loadDustCache(ownerPubkeyStr) {
    const mem = _getMem(ownerPubkeyStr);
    if (mem && mem.data && typeof mem.data === "object") return mem.data;

    const k = _key(ownerPubkeyStr);
    try {
      const raw = localStorage.getItem(k);
      if (raw == null) {
        const empty = {};
        _setMem(ownerPubkeyStr, empty);
        return empty;
      }

      const obj = JSON.parse(raw) || {};
      _setMem(ownerPubkeyStr, obj);
      return _mem.get(String(ownerPubkeyStr || ""))?.data || obj;
    } catch {
      return {};
    }
  }

  function saveDustCache(ownerPubkeyStr, data) {
    const k = _key(ownerPubkeyStr);
    try {
      localStorage.setItem(k, JSON.stringify(data || {}));
      _setMem(ownerPubkeyStr, data, { loadedAt: Date.now() });
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
    invalidateDustCache,
    addToDustCache,
    removeFromDustCache,
    dustCacheToList,
    isMintInDustCache,
  };
}
