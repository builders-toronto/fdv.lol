import { FALLBACK_LOGO } from "../config/env.js";

const IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
  'https://cf-ipfs.com/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
];

const _failCounts = new Map();
const _blocked = new Set();
const MAX_FAILS_PER_CID = 6;

const SILENCE_STORM_WINDOW_MS = 2000;
const SILENCE_STORM_THRESHOLD = 6; 
let __ipfsErrTimes = [];

function _isDevHost() {
  try {
    const h = (location && location.hostname) || '';
    return /^(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(h);
  } catch { return false; }
}

function shouldSilenceIpfs() {
  try {
    // Only allow "full blackout" on dev hosts
    if (!_isDevHost()) return false;
    if (typeof window !== 'undefined' && window.__fdvSilenceIpfs) return true;
    if (typeof localStorage !== 'undefined' && localStorage.getItem('fdv_silence_ipfs') === '1') return true;
  } catch {}
  return false;
}

function setSilenceIpfs(on = true) {
  try {
    // Only enable silence on dev hosts; allow disabling anywhere
    if (on && !_isDevHost()) return;
    if (typeof window !== 'undefined') window.__fdvSilenceIpfs = !!on;
    if (typeof localStorage !== 'undefined') {
      if (on) localStorage.setItem('fdv_silence_ipfs', '1');
      else localStorage.removeItem('fdv_silence_ipfs');
    }
  } catch {}
}

function recordIpfsErrAndMaybeSilence() {
  const now = Date.now();
  __ipfsErrTimes.push(now);
  __ipfsErrTimes = __ipfsErrTimes.filter(t => now - t <= SILENCE_STORM_WINDOW_MS);
  // Only auto-silence on dev hosts
  if (_isDevHost() && __ipfsErrTimes.length >= SILENCE_STORM_THRESHOLD) setSilenceIpfs(true);
}

if (typeof window !== 'undefined') {
  if (_isDevHost()) {
    try {
      if (localStorage.getItem('fdv_silence_ipfs') !== '0') setSilenceIpfs(true);
    } catch {}
  }
  // if (developer) window.addEventListener('online', () => setSilenceIpfs(false));
}

function abbreviateSym(sym = '') {
  const s = String(sym || '').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4);
  return s || 'TKN';
}
function buildFallbackLogo(sym = '') {
  const tag = abbreviateSym(sym);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" role="img" aria-label="${tag}">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="#1e2533"/>
          <stop offset="1" stop-color="#0d1117"/>
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="12" fill="url(#g)"/>
      <circle cx="32" cy="32" r="18" fill="#121820" stroke="#2a3848" stroke-width="2"/>
      <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central"
            font-family="ui-monospace, SFMono-Regular, Menlo, monospace"
            font-size="12" fill="#9CA3AF">${tag}</text>
    </svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}
function fallbackLogo(sym = '') {
  try {
    if (typeof FALLBACK_LOGO === 'function') return FALLBACK_LOGO(sym);
    if (typeof FALLBACK_LOGO === 'string' && FALLBACK_LOGO.length) return FALLBACK_LOGO;
  } catch {}
  return buildFallbackLogo(sym);
}

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
  if (!cid) return raw;
  if (shouldSilenceIpfs()) return ''; 
  return buildGatewayUrl(cid, 0);
}
export function nextGatewayUrl(currentSrc) {
  if (shouldSilenceIpfs()) return null;
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
  return !!cid && _blocked.has(cid);
}
export function gatewayStats() {
  return { tracked: _failCounts.size, blocked: _blocked.size };
}

function isLogoBlocked(raw) {
  if (!raw) return true;
  const cid = extractCid(raw);
  if (!cid) return false; // non-ipfs regular URL: allow
  return _blocked.has(cid) || (_failCounts.get(cid) || 0) >= MAX_FAILS_PER_CID;
}

export function normalizeTokenLogo(raw, sym = '') {
  if (!raw || shouldSilenceIpfs()) return fallbackLogo(sym);
  try {
    if (isLogoBlocked(raw)) return fallbackLogo(sym);
    const u = firstIpfsUrl(raw);
    if (!u) return fallbackLogo(sym);
    const cid = extractCid(u);
    if (cid && _blocked.has(cid)) return fallbackLogo(sym);
    return u;
  } catch {
    return fallbackLogo(sym);
  }
}

(function installIpfsImageFallback() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__fdvIpfsFallbackInstalled) return;
  window.__fdvIpfsFallbackInstalled = true;
  try {
    // Only install src/setAttribute interception on dev hosts (full blackout behavior)
    if (_isDevHost() && !window.__fdvIpfsSrcIntercept) {
      window.__fdvIpfsSrcIntercept = true;
      const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      if (desc && desc.set) {
        const origSet = desc.set, origGet = desc.get;
        Object.defineProperty(HTMLImageElement.prototype, 'src', {
          get: function() { return origGet.call(this); },
          set: function(v) {
            try {
              const vs = String(v || '');
              if (shouldSilenceIpfs() && isLikelyCid(extractCid(vs) || '')) {
                const tag = this.getAttribute('data-sym') || '';
                return origSet.call(this, fallbackLogo(tag));
              }
            } catch {}
            return origSet.call(this, v);
          },
          configurable: true,
          enumerable: desc.enumerable,
        });
      }
      const origSetAttr = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function(name, value) {
        try {
          if (name === 'src' && this && this.tagName === 'IMG') {
            const vs = String(value || '');
            if (shouldSilenceIpfs() && isLikelyCid(extractCid(vs) || '')) {
              const tag = this.getAttribute('data-sym') || '';
              return origSetAttr.call(this, 'src', fallbackLogo(tag));
            }
          }
        } catch {}
        return origSetAttr.call(this, name, value);
      };
    }
  } catch {}

  const perSrcFailCounts = new Map();
  const MAX_RETRIES_PER_SRC = 2;
  const HEAD_TIMEOUT_MS = 2500;

  document.addEventListener('error', (ev) => {
    const img = ev?.target;
    if (!img || img.tagName !== 'IMG') return;

    const currentSrc = img.getAttribute('src') || '';
    if (!currentSrc) return;
    if (!isLikelyCid(extractCid(currentSrc) || '')) return;

    recordIpfsErrAndMaybeSilence();

    if (shouldSilenceIpfs()) {
      const tag = img.getAttribute('data-sym') || '';
      img.onerror = null;
      img.src = fallbackLogo(tag);
      return;
    }

    // Prevent multiple retries on the same image
    if (img.__fdvIpfsRetrying) return;
    img.__fdvIpfsRetrying = true;

    const prev = perSrcFailCounts.get(currentSrc) || 0;
    if (prev >= MAX_RETRIES_PER_SRC) {
      const cid = extractCid(currentSrc);
      if (cid) _blocked.add(cid);
      const tag = img.getAttribute('data-sym') || '';
      img.onerror = null;
      img.src = fallbackLogo(tag);
      return;
    }
    perSrcFailCounts.set(currentSrc, prev + 1);

    try { markGatewayFailure(currentSrc); } catch {}

    const nextSrc = nextGatewayUrl(currentSrc);
    if (!nextSrc) {
      const tag = img.getAttribute('data-sym') || '';
      img.onerror = null;
      img.src = fallbackLogo(tag);
      return;
    }

    // Directly try the next gateway without fetch check
    setTimeout(() => {
      img.onerror = null;
      img.src = nextSrc;
      img.__fdvIpfsRetrying = false; // Allow retry if this also fails
    }, 50);
  }, true);
})();