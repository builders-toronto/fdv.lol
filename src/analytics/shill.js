const METRICS_BASE = (typeof window !== "undefined" && window.__metricsBase)
  ? String(window.__metricsBase).replace(/\/+$/,"")
  : "https://fdv-lol-metrics.fdvlol.workers.dev";

const LINKS_KEY = "fdv.shill.links";   
const STATS_KEY = "fdv.shill.stats";   
const SESS_KEY  = "fdv.shill.session"; 

const MAX_LINKS_PER_USER = 3;

// detect current ref from URL
function _currentRef() {
  try { return new URLSearchParams(location.search).get("ref") || ""; } catch { return ""; }
}
function _analyticsEnabled(slug) {
  const ref = _currentRef();
  if (!ref) return false;
  if (slug && ref !== slug) return false; // require match if slug provided
  return true;
}

function _load(k){ try{ return JSON.parse(localStorage.getItem(k)) || {}; }catch{return{}} }
function _save(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} }
function _now(){ return Date.now(); }
function _slug(){ return Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6); }
function _did() {
  const k = "fdv.did";
  let v = localStorage.getItem(k);
  if (!v) { v = (crypto.randomUUID?.() || Math.random().toString(36).slice(2)); localStorage.setItem(k, v); }
  return v;
}
function _ownerId(owner) {
  const h = (owner || "").trim().toLowerCase();
  return h ? `handle:${h}` : `did:${_did()}`;
}
function _normHandle(h){ return (h || "").trim().toLowerCase(); }

function _countLinksForUser(ownerId) {
  const links = _load(LINKS_KEY);
  let n = 0;
  for (const [, v] of Object.entries(links)) {
    if (v?.ownerId === ownerId || (v?.did && `did:${v.did}` === ownerId)) n++;
  }
  return n;
}

function _migrateLinksStore() {
  const links = _load(LINKS_KEY);
  let changed = false;
  for (const [slug, v] of Object.entries(links)) {
    if (!v || typeof v !== "object") continue;
    if (!v.ownerId) {
      const h = _normHandle(v.owner);
      if (h) { v.ownerId = `handle:${h}`; changed = true; }
      else if (v.did) { v.ownerId = `did:${v.did}`; changed = true; }
    }
  }
  if (changed) _save(LINKS_KEY, links);
}
function _sanitizeMint(m){ const s = String(m||"").trim(); return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) ? s : ""; }
function _sanitizeSlug(s){ s = String(s||"").trim().toLowerCase(); return /^[a-z0-9_-]{4,64}$/.test(s) ? s : ""; }

const _nonce = (() => {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  // hex
  return [...a].map(b => b.toString(16).padStart(2, "0")).join("");
})();
async function _postJSON(url, payload, { keepalive = false } = {}) {
  const body = JSON.stringify(payload);
  const res = await fetch(url, {
    method: "POST",
    keepalive,
    headers: { "Content-Type": "application/json" },
    body
  });
  return res;
}

// Prefer wallet_id in local storage
function _ownerForSlug(slug) {
  try {
    const links = _load(LINKS_KEY);
    const v = links?.[slug];
    if (v?.wallet_id && _sanitizeMint(v.wallet_id)) return v.wallet_id;
    if (v?.owner && _sanitizeMint(v.owner)) return v.owner;
  } catch {}
  try {
    const usp = new URLSearchParams(location.search);
    const w = _sanitizeMint(usp.get("wallet_id") || usp.get("owner") || "");
    if (w) return w;
  } catch {}
  return "";
}

function parseRefParam() {
  const ref = _currentRef();
  if (!ref) return { slug: "", token: "" };
  const dot = ref.indexOf(".");
  if (dot === -1) return { slug: ref, token: "" };
  return { slug: ref.slice(0, dot), token: ref.slice(dot + 1) };
}

async function _sendEvent({ mint, slug, event, value = 1, keepalive = false }) {
  try {
    const mintOk = _sanitizeMint(mint);
    const slugOk = _sanitizeSlug(slug);
    if (!mintOk || !slugOk) return false;
    if (!_analyticsEnabled(slugOk)) return false;

    const walletId = _ownerForSlug(slugOk);

    const url = `${METRICS_BASE}/api/shill/event`;
    const payload = {
      mint: mintOk,
      slug: slugOk,
      event,
      value,
      // no refToken; backend checks slug binding
      wallet_id: walletId,
      path: location.pathname + location.search,
      href: location.href,
      referrer: document.referrer || "",
      ua: navigator.userAgent || "",
      nonce: _nonce
    };
    const res = await _postJSON(url, payload, { keepalive });
    return res.ok;
  } catch {
    return false;
  }
}
async function _fetchSummary({ mint, slug, timeoutMs = 2500 }) {
  const mintOk = _sanitizeMint(mint);
  const slugOk = _sanitizeSlug(slug);
  if (!mintOk || !slugOk) return null;

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${METRICS_BASE}/api/shill/summary?mint=${encodeURIComponent(mintOk)}&slug=${encodeURIComponent(slugOk)}`, {
      signal: ctl.signal,
      cache: "no-store"
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data && typeof data === "object" && data.stats) ? data.stats : data;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export function downloadShillCSV(mint) {
  const m = _sanitizeMint(mint);
  if (!m) return;
  const u = `${METRICS_BASE}/api/shill/csv?mint=${encodeURIComponent(m)}`;
  window.open(u, "_blank", "noopener");
}

export async function pingMetrics() {
  try {
    const res = await fetch(`${METRICS_BASE}/diag`, { cache: "no-store" });
    if (!res.ok) return false;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const j = await res.json();
      return !!(j && j.r2 && j.idx);
    }
    const t = await res.text();
    return /ok|r2:ok/i.test(t);
  } catch { return false; }
}
export function canCreateShillLink({ owner } = {}) {
  const ownerId = _ownerId(owner);
  const used = _countLinksForUser(ownerId);
  return { allowed: used < MAX_LINKS_PER_USER, used, remaining: Math.max(0, MAX_LINKS_PER_USER - used) };
}

// Create shortlink (slug-only; bind to wallet_id)
export async function makeShillShortlink({ mint, wallet_id, owner }) {
  const walletId = _sanitizeMint(wallet_id || owner || "");
  if (!walletId) throw new Error("A valid wallet address is required");
  const { allowed, remaining } = canCreateShillLink({ owner: walletId });
  if (!allowed) {
    const e = new Error("Limit reached: maximum 3 links per user");
    e.code = "LIMIT"; e.remaining = remaining; throw e;
  }
  let slug = _slug();

  const regRes = await fetch(`${METRICS_BASE}/api/shill/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mint, wallet_id: walletId, slug })
  });
  if (!regRes.ok) throw new Error("Failed to register shill link");
  const reg = await regRes.json();
  slug = reg.slug || slug;

  _migrateLinksStore();
  const links = _load(LINKS_KEY);
  const did = _did();
  const ownerId = _ownerId(walletId);
  links[slug] = { mint, wallet_id: walletId, owner: walletId, ownerId, did, createdAt: _now() };
  _save(LINKS_KEY, links);

  const url = new URL(location.origin);
  url.pathname = `/token/${mint}`;
  url.searchParams.set("ref", slug);
  return { slug, url: url.toString() };
}
async function _mergeStatsFromWorker(entry, localStats) {
  const { mint, slug } = entry;
  const s = await _fetchSummary({ mint, slug });
  if (!s) return localStats; 
  const merged = {
    views: s.views ?? 0,
    tradeClicks: s.tradeClicks ?? 0,
    swapStarts: s.swapStarts ?? 0,
    walletConnects: s.walletConnects ?? 0,
    timeMs: s.timeMs ?? 0
  };
  merged.views += localStats.views || 0;
  merged.tradeClicks += localStats.tradeClicks || 0;
  merged.swapStarts += localStats.swapStarts || 0;
  merged.walletConnects += localStats.walletConnects || 0;
  merged.timeMs += localStats.timeMs || 0;

  return merged;
}

export async function listShillLinks({ mint, owner, ownerId } = {}) {
  _migrateLinksStore();
  const links = _load(LINKS_KEY);
  const stats = _load(STATS_KEY);
  const targetId = ownerId || _ownerId(owner);

  const base = Object.entries(links)
    .filter(([, v]) => {
      const matchesMint = mint ? v.mint === mint : true;
      const matchesUser = v.ownerId === targetId || (v.did && `did:${v.did}` === targetId);
      return matchesMint && matchesUser;
    })
    .map(([slug, v]) => ({
      slug,
      ...v,
      url: `${location.origin}/token/${v.mint}?ref=${slug}`,
      stats: {
        views: stats[slug]?.views || 0,
        tradeClicks: stats[slug]?.tradeClicks || 0,
        swapStarts: stats[slug]?.swapStarts || 0,
        walletConnects: stats[slug]?.walletConnects || 0,
        timeMs: stats[slug]?.timeMs || 0
      }
    }));
  const enriched = await Promise.all(base.map(async (row) => {
    const merged = await _mergeStatsFromWorker(row, row.stats);
    return { ...row, stats: merged };
  }));

  return enriched.sort((a,b)=> (b.stats.views - a.stats.views) || (b.stats.timeMs - a.stats.timeMs));
}

export function deleteShillLink({ slug, owner, ownerId } = {}) {
  if (!slug) return false;
  _migrateLinksStore();
  const links = _load(LINKS_KEY);
  const entry = links[slug];
  if (!entry) return false;

  const myId = ownerId || _ownerId(owner);
  const owns =
    entry.ownerId === myId ||
    (!!entry.did && `did:${entry.did}` === myId) ||
    (!!entry.owner && `handle:${_normHandle(entry.owner)}` === myId);

  if (!owns) return false;

  delete links[slug];
  _save(LINKS_KEY, links);

  const stats = _load(STATS_KEY);
  if (stats && stats[slug]) {
    delete stats[slug];
    _save(STATS_KEY, stats);
  }
  return true;
}
function _bumpLocal(slug, field, by=1){
  if (!slug) return;
  const stats = _load(STATS_KEY);
  stats[slug] = stats[slug] || { views:0, tradeClicks:0, swapStarts:0, walletConnects:0, timeMs:0 };
  stats[slug][field] = (stats[slug][field] || 0) + by;
  _save(STATS_KEY, stats);
}

async function _bumpBoth({ slug, mint, field, event, by = 1, keepalive = false }) {
  // Guard: only bump/send if current URL has ?ref= and matches slug! dont waste resources otherwise
  if (!_analyticsEnabled(slug)) return;
  _bumpLocal(slug, field, by);
  _sendEvent({ mint, slug, event, value: by, keepalive }).catch(()=>{});
}


function _attachOnce(type, handler) {
  document.addEventListener(type, handler, { passive: true });
}

export function startProfileShillAttribution({ mint }) {
  const usp = new URLSearchParams(location.search);
  const slug = usp.get("ref");
  const cleanMint = _sanitizeMint(mint);
  if (!slug || !cleanMint) return;


  _bumpBoth({ slug, mint: cleanMint, field: "views", event: "view", by: 1 });


  _save(SESS_KEY, { slug, mint: cleanMint, t0: _now() });


  const onFlush = () => {
    const sess = _load(SESS_KEY);
    if (!sess?.slug || !sess?.mint) return;
    const dt = Math.max(0, _now() - (sess.t0 || _now()));
    _bumpBoth({ slug: sess.slug, mint: sess.mint, field: "timeMs", event: "time_ms", by: dt, keepalive: true });
    _save(SESS_KEY, {}); // end
  };
  window.addEventListener("pagehide", onFlush, { once: true });
  window.addEventListener("beforeunload", onFlush, { once: true });


  _attachOnce("click", (e) => {
    const a = e.target.closest?.("a");
    if (!a) return;
    const id = a.id || "";
    const href = a.getAttribute("href") || "";
    if (id === "btnTradeTop" || /dex|trade|raydium|jup|orca/i.test(href)) {
      _bumpBoth({ slug, mint: cleanMint, field: "tradeClicks", event: "trade_click", by: 1 });
    }
  });

  document.addEventListener("click", (e) => {
    const swapBtn = e.target.closest?.("#btnSwapAction,[data-swap-go]");
    if (swapBtn) _bumpBoth({ slug, mint: cleanMint, field: "swapStarts", event: "swap_start", by: 1 });
  }, { passive: true });


  document.addEventListener("swap:wallet-connect", () => {
    const sess = _load(SESS_KEY);
    if (!sess?.slug || !sess?.mint) return;
    _bumpBoth({ slug: sess.slug, mint: sess.mint, field: "walletConnects", event: "wallet_connect", by: 1 });
  }, { passive: true });

  document.addEventListener("swap:confirmed", () => {
    const sess = _load(SESS_KEY);
    if (!sess?.slug || !sess?.mint) return;
    _bumpBoth({ slug: sess.slug, mint: sess.mint, field: "tradeClicks", event: "trade_click", by: 1 });
  }, { passive: true } );
}


export async function mintShillSession() {
  if (!_analyticsEnabled()) return null;
  try {
    const res = await _postJSON(`${METRICS_BASE}/api/shill/session`, {});
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export function shillAnalyticsEnabled() { return _analyticsEnabled(); }
