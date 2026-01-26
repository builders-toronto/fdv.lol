import { FALLBACK_LOGO } from "../config/env.js";

const IPFS_GATEWAYS = [
  'https://w3s.link/ipfs/',
  'https://dweb.link/ipfs/',
  'https://ipfs.io/ipfs/',
];

const _failCounts = new Map();
const _blocked = new Set();
const MAX_FAILS_PER_CID = 6;

const SILENCE_STORM_WINDOW_MS = 2000;
const SILENCE_STORM_THRESHOLD = 6; 
let __ipfsErrTimes = [];

function _isDevHost() {
  try {
    const h = (typeof location !== 'undefined' && location && location.hostname) ? location.hostname : '';
    return /^(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(h);
  } catch {
    return false;
  }
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

const _cidObjectUrlCache = new Map(); // cid -> { url, createdAt, lastUsedAt, refCount }
const _objectUrlToCid = new Map(); // blobUrl -> cid
const MAX_CID_OBJECTURL_CACHE = 600;
const OBJECTURL_REVOKE_IDLE_MS = 30_000;
const OBJECTURL_REVOKE_POLL_MS = 5_000;

function _now() {
  try { return Date.now(); } catch { return 0; }
}

function _getCidEntry(cid) {
  try {
    return cid ? (_cidObjectUrlCache.get(cid) || null) : null;
  } catch {
    return null;
  }
}

let __revokeTimer = 0;
function _scheduleMaybeRevoke() {
  try {
    if (__revokeTimer) return;
    __revokeTimer = setTimeout(() => {
      __revokeTimer = 0;
      try { _revokeIdleObjectUrls(); } catch {}
    }, OBJECTURL_REVOKE_POLL_MS);
  } catch {}
}

function _revokeIdleObjectUrls() {
  const now = _now();
  const toDelete = [];
  for (const [cid, ent] of _cidObjectUrlCache.entries()) {
    if (!ent || !ent.url) { toDelete.push(cid); continue; }
    const rc = ent.refCount || 0;
    if (rc > 0) continue;
    const age = now - (ent.lastUsedAt || ent.createdAt || 0);
    if (age < OBJECTURL_REVOKE_IDLE_MS) continue;
    try {
      if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(ent.url);
      }
    } catch {}
    try { _objectUrlToCid.delete(ent.url); } catch {}
    toDelete.push(cid);
  }
  for (const cid of toDelete) {
    try { _cidObjectUrlCache.delete(cid); } catch {}
  }
}

function _setImgLogoBinding(imgEl, cid, url) {
  try {
    if (!imgEl) return;
    imgEl.__fdvLogoCid = cid || '';
    imgEl.__fdvLogoObjUrl = url || '';
  } catch {}
}

function _releaseImgLogoBinding(imgEl) {
  try {
    if (!imgEl) return;
    const cid = imgEl.__fdvLogoCid || '';
    imgEl.__fdvLogoCid = '';
    imgEl.__fdvLogoObjUrl = '';
    if (!cid) return;
    const ent = _getCidEntry(cid);
    if (!ent) return;
    ent.refCount = Math.max(0, (ent.refCount || 0) - 1);
    ent.lastUsedAt = _now();
    _scheduleMaybeRevoke();
  } catch {}
}

function _bindImgToCidIfNeeded(imgEl, cid) {
  try {
    if (!imgEl || !cid) return false;
    const ent = _getCidEntry(cid);
    if (!ent || !ent.url) return false;

    if (imgEl.__fdvLogoCid === cid && imgEl.__fdvLogoObjUrl === ent.url) return true;
    if (imgEl.__fdvLogoCid && imgEl.__fdvLogoCid !== cid) _releaseImgLogoBinding(imgEl);

    ent.refCount = (ent.refCount || 0) + 1;
    ent.lastUsedAt = _now();
    _setImgLogoBinding(imgEl, cid, ent.url);
    return true;
  } catch {
    return false;
  }
}

function _getCachedObjectUrlForCid(cid) {
  try {
    const ent = _getCidEntry(cid);
    if (!ent || !ent.url) return '';
    ent.lastUsedAt = _now();
    return ent.url;
  } catch {
    return '';
  }
}

function _putCachedObjectUrlForCid(cid, url) {
  try {
    if (!cid || !url) return '';
    const existing = _getCidEntry(cid);
    if (existing && existing.url) return existing.url;

    const now = _now();
    _cidObjectUrlCache.set(cid, { url, createdAt: now, lastUsedAt: now, refCount: 0 });
    try { _objectUrlToCid.set(url, cid); } catch {}

    // Keep bounded: only consider non-referenced entries as "evictable".
    if (_cidObjectUrlCache.size > MAX_CID_OBJECTURL_CACHE) {
      const overflow = _cidObjectUrlCache.size - MAX_CID_OBJECTURL_CACHE;
      let i = 0;
      for (const [k, ent] of _cidObjectUrlCache.entries()) {
        if (i >= overflow) break;
        if ((ent?.refCount || 0) > 0) continue;
        try { ent.lastUsedAt = 0; } catch {}
        i++;
      }
      _scheduleMaybeRevoke();
    }
    return url;
  } catch {
    return '';
  }
}

function _cacheObjectUrlFromBlob(cid, blob) {
  try {
    if (!cid || !blob || !blob.size) return '';
    const existing = _getCachedObjectUrlForCid(cid);
    if (existing) return existing;
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return '';
    const objUrl = URL.createObjectURL(blob);
    return _putCachedObjectUrlForCid(cid, objUrl);
  } catch {
    return '';
  }
}

function _isObjectUrl(url) {
  try {
    return typeof url === 'string' && url.startsWith('blob:');
  } catch {
    return false;
  }
}

function _setImgSrcIfDifferent(imgEl, src) {
  try {
    if (!imgEl || !src) return false;
    const cur = imgEl.getAttribute('src') || '';
    if (cur === src) return false;
    imgEl.setAttribute('src', src);
    return true;
  } catch {
    return false;
  }
}

function _setImgSrcFromCachedCid(imgEl, cid) {
  try {
    const u = _getCachedObjectUrlForCid(cid);
    if (!u) return false;
    _setImgSrcIfDifferent(imgEl, u);
    _bindImgToCidIfNeeded(imgEl, cid);
    return true;
  } catch {
    return false;
  }
}

function _installLogoDomReleaseObserver() {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (window.__fdvLogoReleaseObserverInstalled) return;
    window.__fdvLogoReleaseObserverInstalled = true;

    const collectImgs = (node, out) => {
      try {
        if (!node) return;
        if (node.tagName === 'IMG') out.push(node);
        if (node.querySelectorAll) node.querySelectorAll('img').forEach((img) => out.push(img));
      } catch {}
    };

    const mo = new MutationObserver((mutations) => {
      try {
        const imgs = [];
        for (const m of mutations) {
          if (!m || !m.removedNodes) continue;
          m.removedNodes.forEach((n) => collectImgs(n, imgs));
        }
        if (!imgs.length) return;

        setTimeout(() => {
          for (const img of imgs) {
            try {
              if (!img || !img.__fdvLogoCid) continue;
              if (document.contains(img)) continue;
              _releaseImgLogoBinding(img);
            } catch {}
          }
        }, 0);
      } catch {}
    });

    const root = document.documentElement || document.body;
            try { _releaseImgLogoBinding(imgEl); } catch {}
    if (root) mo.observe(root, { childList: true, subtree: true });
  } catch {}
}

const _cidGatewayHint = new Map();
let _preferredGatewayIndex = 0;
const DEFAULT_FETCH_TIMEOUT_MS = 3500;

const LOGO_CACHE_NAME = 'fdv-logo-v1';
const LOGO_CACHE_PATH = '/_fdv_logo_cache/v1/';
const COMPRESS_MAX_DIM = 128;
const COMPRESS_MIN_BYTES = 12 * 1024; // only bother when it meaningfully helps
const COMPRESS_MIN_SAVINGS_BYTES = 2048;
const COMPRESS_WEBP_QUALITY = 0.72;

function _canUseCacheStorage() {
  try {
    return typeof window !== 'undefined' && typeof caches !== 'undefined' && !!caches?.open;
  } catch {
    return false;
  }
}

function _cacheKeyUrlForCid(cid) {
  try {
    const origin = (typeof location !== 'undefined' && location.origin) ? location.origin : 'https://fdv.local';
    return origin + LOGO_CACHE_PATH + encodeURIComponent(cid) + '.img';
  } catch {
    return 'https://fdv.local' + LOGO_CACHE_PATH + encodeURIComponent(cid) + '.img';
  }
}

async function _openLogoCache() {
  if (!_canUseCacheStorage()) return null;
  try {
    return await caches.open(LOGO_CACHE_NAME);
  } catch {
    return null;
  }
}

async function _cacheGetLogoBlob(cid) {
  try {
    const cache = await _openLogoCache();
    if (!cache) return null;
    const keyUrl = _cacheKeyUrlForCid(cid);
    const res = await cache.match(keyUrl);
    if (!res || !res.ok) return null;
    const blob = await res.blob();
    return blob && blob.size ? blob : null;
  } catch {
    return null;
  }
}

async function _cachePutLogoBlob(cid, blob) {
  try {
    const cache = await _openLogoCache();
    if (!cache) return false;
    if (!blob || !blob.size) return false;
    const keyUrl = _cacheKeyUrlForCid(cid);
    const headers = new Headers();
    try {
      const ct = blob.type || 'application/octet-stream';
      headers.set('content-type', ct);
    } catch {}
    try { headers.set('cache-control', 'public, max-age=31536000, immutable'); } catch {}
    const res = new Response(blob, { status: 200, headers });
    await cache.put(keyUrl, res);
    return true;
  } catch {
    return false;
  }
}

function _scheduleIdle(fn) {
  try {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => { try { fn(); } catch {} }, { timeout: 1500 });
      return;
    }
  } catch {}
  setTimeout(() => { try { fn(); } catch {} }, 0);
}

function _isCompressibleImage(blob) {
  try {
    const t = (blob?.type || '').toLowerCase();
    if (!t) return true; // many gateways lie; we'll try and bail if decode fails
    if (t.includes('svg')) return false;
    if (t.includes('gif')) return false;
    if (t.includes('webp')) return false;
    return true;
  } catch {
    return false;
  }
}

async function _canvasToWebpBlob(canvas, quality) {
  try {
    if (canvas && typeof canvas.convertToBlob === 'function') {
      return await canvas.convertToBlob({ type: 'image/webp', quality });
    }
  } catch {}

  return await new Promise((resolve) => {
    try {
      if (!canvas || typeof canvas.toBlob !== 'function') return resolve(null);
      canvas.toBlob((b) => resolve(b || null), 'image/webp', quality);
    } catch {
      resolve(null);
    }
  });
}

async function _compressLogoBlobIfUseful(blob) {
  try {
    if (!blob || !blob.size) return null;
    if (blob.size < COMPRESS_MIN_BYTES) return null;
    if (!_isCompressibleImage(blob)) return null;

    if (typeof createImageBitmap !== 'function') return null;

    const bmp = await createImageBitmap(blob).catch(() => null);
    if (!bmp) return null;

    const w = bmp.width || 0;
    const h = bmp.height || 0;
    if (!w || !h) {
      try { bmp.close?.(); } catch {}
      return null;
    }

    const scale = Math.min(1, COMPRESS_MAX_DIM / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));

    let canvas;
    if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(tw, th);
    else if (typeof document !== 'undefined') {
      canvas = document.createElement('canvas');
      canvas.width = tw;
      canvas.height = th;
    } else {
      try { bmp.close?.(); } catch {}
      return null;
    }

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      try { bmp.close?.(); } catch {}
      return null;
    }

    ctx.clearRect(0, 0, tw, th);
    ctx.drawImage(bmp, 0, 0, tw, th);
    try { bmp.close?.(); } catch {}

    const webp = await _canvasToWebpBlob(canvas, COMPRESS_WEBP_QUALITY);
    if (!webp || !webp.size) return null;
    if (webp.size >= blob.size - COMPRESS_MIN_SAVINGS_BYTES) return null;

    return webp;
  } catch {
    return null;
  }
}

const _compressJobsByCid = new Map();
function _maybeScheduleCompressionAndOverwriteCache(cid, originalBlob) {
  try {
    if (!cid || !originalBlob || !originalBlob.size) return;
    if (_compressJobsByCid.has(cid)) return;
    if (originalBlob.size < COMPRESS_MIN_BYTES) return;
    _compressJobsByCid.set(cid, true);

    _scheduleIdle(async () => {
      try {
        const compressed = await _compressLogoBlobIfUseful(originalBlob);
        if (compressed && compressed.size) {
          await _cachePutLogoBlob(cid, compressed);
        }
      } catch {
      } finally {
        _compressJobsByCid.delete(cid);
      }
    });
  } catch {}
}

function _gatewayOrderForCid(cid) {
  const n = IPFS_GATEWAYS.length || 1;
  const start = _cidGatewayHint.has(cid)
    ? (_cidGatewayHint.get(cid) % n)
    : (_preferredGatewayIndex % n);
  const order = [];
  for (let i = 0; i < n; i++) order.push((start + i) % n);
  return order;
}

async function _fetchBlobWithTimeout(url, timeoutMs) {
  const ms = Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_FETCH_TIMEOUT_MS;
  const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const timer = setTimeout(() => { try { ctl?.abort?.(); } catch {} }, ms);
  try {
    const res = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      redirect: 'follow',
      cache: 'force-cache',
      signal: ctl?.signal,
    });
    if (!res || !res.ok) throw new Error(`HTTP_${res?.status || 0}`);
    // A lot of gateways omit/lie about content-type; only hard-block obvious non-images.
    const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    if (ct && !/^image\//i.test(ct) && !/octet-stream/i.test(ct)) {
      // Still allow SVG served as text.
      if (!/svg/i.test(ct)) throw new Error('NOT_IMAGE');
    }
    return await res.blob();
  } finally {
    clearTimeout(timer);
  }
}

export function getTokenLogoPlaceholder(raw, sym = '') {
  try {
    if (!raw || shouldSilenceIpfs()) return fallbackLogo(sym);
    const cid = extractCid(raw);
    if (cid) {
      const cached = _getCachedObjectUrlForCid(cid);
      return cached || fallbackLogo(sym);
    }
    return raw;
  } catch {
    return fallbackLogo(sym);
  }
}

export function queueTokenLogoLoad(imgEl, raw, sym = '', opts = {}) {
  if (!imgEl) return;
  try {
    const desiredRaw = String(raw || '');
    const desiredSym = String(sym || '');

    // Track desired raw on element to prevent thrash.
    try {
      if (desiredRaw) imgEl.setAttribute('data-logo-raw', desiredRaw);
      else imgEl.removeAttribute('data-logo-raw');
    } catch {}

    if (desiredSym && !imgEl.getAttribute('data-sym')) {
      try { imgEl.setAttribute('data-sym', desiredSym); } catch {}
    }

    // Non-IPFS URL: just assign directly.
    const cid = extractCid(desiredRaw);
    if (!cid) {
      if (!desiredRaw) {
        const fb = fallbackLogo(desiredSym);
        if (imgEl.getAttribute('src') !== fb) imgEl.setAttribute('src', fb);
        return;
      }
      if (imgEl.getAttribute('src') !== desiredRaw) imgEl.setAttribute('src', desiredRaw);
      return;
    }

    if (_setImgSrcFromCachedCid(imgEl, cid)) return;

    if (shouldSilenceIpfs() || isLogoBlocked(desiredRaw)) {
      try { _releaseImgLogoBinding(imgEl); } catch {}
      const fb = fallbackLogo(desiredSym);
      if (imgEl.getAttribute('src') !== fb) imgEl.setAttribute('src', fb);
      return;
    }

    if (typeof window === 'undefined' || typeof fetch === 'undefined' || typeof URL === 'undefined') {
      // In non-browser contexts fall back to gateway URL.
      try { _releaseImgLogoBinding(imgEl); } catch {}
      const u = normalizeTokenLogo(desiredRaw, desiredSym);
      if (imgEl.getAttribute('src') !== u) imgEl.setAttribute('src', u);
      return;
    }

    // Put a safe placeholder in place so we don't trigger browser network errors.
    const currentSrc = imgEl.getAttribute('src') || '';
    // If the caller already put a cached blob URL in place (via getTokenLogoPlaceholder),
    // bind it so ref-counts stay correct.
    try {
      const cachedUrl = _getCachedObjectUrlForCid(cid);
      if (cachedUrl && currentSrc === cachedUrl) _bindImgToCidIfNeeded(imgEl, cid);
    } catch {}
    // If we already have a blob/object URL (likely from a previous load), keep it.
    // Otherwise, use the placeholder fallback.
    if ((!currentSrc || extractCid(currentSrc)) && !_isObjectUrl(currentSrc)) {
      const fb = fallbackLogo(desiredSym);
      if (currentSrc !== fb) imgEl.setAttribute('src', fb);
    }

    // Cancel/ignore prior loads for this element.
    const reqId = (imgEl.__fdvLogoReqId = (imgEl.__fdvLogoReqId || 0) + 1);
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_FETCH_TIMEOUT_MS;

    (async () => {
      // Cache hit: avoid any gateway fetch.
      try {
        const cached = await _cacheGetLogoBlob(cid);
        if (cached && cached.size) {
          if (imgEl.__fdvLogoReqId !== reqId) return;

          const objUrl = _cacheObjectUrlFromBlob(cid, cached);
          if (objUrl) {
            imgEl.setAttribute('src', objUrl);
            try { _bindImgToCidIfNeeded(imgEl, cid); } catch {}
          }
          return;
        }
      } catch {}

      const order = _gatewayOrderForCid(cid);
      for (const gwIndex of order) {
        const url = buildGatewayUrl(cid, gwIndex);
        try {
          const blob = await _fetchBlobWithTimeout(url, timeoutMs);
          if (imgEl.__fdvLogoReqId !== reqId) return;
          if (!blob || !blob.size) throw new Error('EMPTY');

          // Update gateway preference/hints on success.
          _preferredGatewayIndex = gwIndex;
          _cidGatewayHint.set(cid, gwIndex);

          // Replace prior object URL.
          const objUrl = _cacheObjectUrlFromBlob(cid, blob);
          if (objUrl) {
            imgEl.setAttribute('src', objUrl);
            try { _bindImgToCidIfNeeded(imgEl, cid); } catch {}
          }

          // Persist in CacheStorage for future loads, and optionally overwrite
          // with a compressed WebP later (scheduled at idle to avoid UI jank).
          try {
            await _cachePutLogoBlob(cid, blob);
            _maybeScheduleCompressionAndOverwriteCache(cid, blob);
          } catch {}
          return;
        } catch {
          try { markGatewayFailure(url); } catch {}
          continue;
        }
      }

      // Everything failed: block CID and show fallback.
      if (imgEl.__fdvLogoReqId !== reqId) return;
      try { _blocked.add(cid); } catch {}
      try { _releaseImgLogoBinding(imgEl); } catch {}
      const fb = fallbackLogo(desiredSym);
      if (imgEl.getAttribute('src') !== fb) imgEl.setAttribute('src', fb);
    })();
  } catch {
    try {
      try { _releaseImgLogoBinding(imgEl); } catch {}
      const fb = fallbackLogo(sym);
      if (imgEl.getAttribute('src') !== fb) imgEl.setAttribute('src', fb);
    } catch {}
  }
}

(function installIpfsImageFallback() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__fdvIpfsFallbackInstalled) return;
  window.__fdvIpfsFallbackInstalled = true;
  try { _installLogoDomReleaseObserver(); } catch {}
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
      try { _releaseImgLogoBinding(img); } catch {}
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
      try { _releaseImgLogoBinding(img); } catch {}
      img.onerror = null;
      img.src = fallbackLogo(tag);
      return;
    }
    perSrcFailCounts.set(currentSrc, prev + 1);

    try { markGatewayFailure(currentSrc); } catch {}

    const nextSrc = nextGatewayUrl(currentSrc);
    if (!nextSrc) {
      const tag = img.getAttribute('data-sym') || '';
      try { _releaseImgLogoBinding(img); } catch {}
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