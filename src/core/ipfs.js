const IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
  'https://cf-ipfs.com/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
];

const _failCounts = new Map();
const _blocked = new Set();
const MAX_FAILS_PER_CID = 6;

export function isLikelyCid(str = '') {
  return !!str && (
    str.startsWith('Qm') && str.length >= 46 ||
    /^[bB]afy[0-9a-zA-Z]{30,}$/.test(str)
  );
}
export function extractCid(raw = '') {
  if (!raw) return '';
  if (raw.startsWith('ipfs://')) return raw.slice(7).replace(/^ipfs\//,'');
  if (raw.startsWith('https://') && /\/ipfs\//.test(raw)) {
    const m = raw.match(/\/ipfs\/([^/?#]+)/);
    return m ? m[1] : '';
  }
  if (isLikelyCid(raw)) return raw;
  return '';
}
export function buildGatewayUrl(cid, gwIndex = 0) {
  if (!cid) return '';
  const gw = IPFS_GATEWAYS[gwIndex] || IPFS_GATEWAYS[0];
  return gw + cid;
}

export function firstIpfsUrl(raw) {
  const cid = extractCid(raw);
  return cid ? buildGatewayUrl(cid, 0) : raw;
}
export function nextGatewayUrl(currentSrc) {
  const cid = extractCid(currentSrc);
  if (!cid) return null;
  if (_blocked.has(cid)) return null;
  const fail = _failCounts.get(cid) || 0;
  if (fail >= MAX_FAILS_PER_CID) {
    _blocked.add(cid);
    return null;
  }
  const idx = fail % IPFS_GATEWAYS.length;
  return buildGatewayUrl(cid, idx);
}
export function markGatewayFailure(src) {
  const cid = extractCid(src);
  if (!cid) return;
  const prev = _failCounts.get(cid) || 0;
  _failCounts.set(cid, prev + 1);
  if (prev + 1 >= MAX_FAILS_PER_CID) _blocked.add(cid);
}
export function isCidBlocked(raw) {
  const cid = extractCid(raw);
  return cid && _blocked.has(cid);
}
export function gatewayStats() {
  return {
    tracked: _failCounts.size,
    blocked: _blocked.size
  };
}

export const FALLBACK_IMG =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
    <rect width="64" height="64" rx="8" fill="#1e1e1e"/>
    <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle"
      font-size="10" fill="#888" font-family="monospace">NO IMG</text>
  </svg>`);

// Central normalization: no errors logged, silent gateway rotation.
export function normalizeTokenLogo(raw) {
  if (!raw) return FALLBACK_IMG;
  try {
    const u = firstIpfsUrl(raw);
    return u || FALLBACK_IMG;
  } catch {
    return FALLBACK_IMG;
  }
}

(function installIpfsImageFallback() {
  if (typeof window === 'undefined') return;
  if (window.__fdvIpfsFallbackInstalled) return;
  window.__fdvIpfsFallbackInstalled = true;

  window.addEventListener('error', (e) => {
    const el = e?.target;
    if (!(el instanceof HTMLImageElement)) return;
    const src = el.getAttribute('src') || '';
    const cid = extractCid(src);
    if (!cid) return;

    const attempts = +(el.dataset.ipfsAttempts || 0);
    if (attempts > 12) {
      el.src = FALLBACK_IMG;
      return;
    }

    try {
      markGatewayFailure(src);
      if (isCidBlocked(src)) {
        el.src = FALLBACK_IMG;
        return;
      }
      const next = nextGatewayUrl(src);
      if (next && next !== src) {
        el.dataset.ipfsAttempts = String(attempts + 1);
        setTimeout(() => { el.src = next; }, 120 + Math.random() * 240);
      } else {
        el.src = FALLBACK_IMG;
      }
    } catch {
      el.src = FALLBACK_IMG;
    }
  }, true);
})();