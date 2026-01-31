import { registerAddon, setAddonData, runAddonsTick, ensureAddonsUI } from './register.js';

const ADDONS = new Map();
let booted = false;
let latestSnapshot = [];

function normMint(m) {
  return String(m || '').trim();
}

function truncStr(v, maxLen = 140) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  return s.length > maxLen ? (s.slice(0, Math.max(0, maxLen - 1)) + '…') : s;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function findSnapshotItemByMint(mint) {
  const m = normMint(mint);
  if (!m) return null;
  const snap = Array.isArray(latestSnapshot) ? latestSnapshot : [];
  for (const it of snap) {
    const im = normMint(it?.mint ?? it?.id ?? '');
    if (im && im === m) return it;
  }
  return null;
}

function compactSnapshotItemForAgent(it) {
  if (!it || typeof it !== 'object') return null;
  // Keep this intentionally tiny: scalars + short strings only.
  const mint = normMint(it?.mint ?? it?.id ?? '');
  if (!mint) return null;
  return {
    mint,
    symbol: truncStr(it?.symbol, 24),
    name: truncStr(it?.name, 48),
    pairUrl: truncStr(it?.pairUrl, 140),
    priceUsd: numOrNull(it?.priceUsd),
    chg5m: numOrNull(it?.chg5m ?? it?.change5m),
    chg1h: numOrNull(it?.chg1h ?? it?.change1h),
    chg24: numOrNull(it?.chg24 ?? it?.change24h ?? it?.change?.h24),
    vol24: numOrNull(it?.vol24 ?? it?.vol24hUsd ?? it?.volume?.h24),
    liqUsd: numOrNull(it?.liqUsd ?? it?.liquidityUsd),
    tx24: numOrNull(it?.tx24 ?? it?.txns?.h24),
    mcap: numOrNull(it?.fdv ?? it?.marketCap),
    // Some pipelines include these; safe to pass if present.
    buys24: numOrNull(it?.buys24 ?? it?.txns?.h24?.buys),
    sells24: numOrNull(it?.sells24 ?? it?.txns?.h24?.sells),
  };
}

function compactAddonItemForAgent(row) {
  if (!row || typeof row !== 'object') return null;
  const mint = normMint(row?.mint ?? row?.id ?? '');
  if (!mint) return null;
  return {
    mint,
    metric: numOrNull(row?.metric ?? row?.score ?? row?.smq),
    score01: numOrNull(row?.score01 ?? row?.alpha01 ?? row?.quality01),
    badge: truncStr(row?.badge ?? row?.tag ?? '', 32),
    note: truncStr(row?.note ?? row?.reason ?? row?.msg ?? '', 140),
  };
}

export function getKpiCompactRowForMint(mint) {
  try {
    const it = findSnapshotItemByMint(mint);
    return compactSnapshotItemForAgent(it);
  } catch {
    return null;
  }
}

export function getKpiAddonMintSignals(mint, { freshMs = 30_000, maxAddons = 8 } = {}) {
  try {
    const m = normMint(mint);
    if (!m) return null;
    const t = now();
    const out = {};
    let n = 0;
    for (const [id, a] of ADDONS) {
      if (n >= Math.max(0, Number(maxAddons) | 0)) break;
      const meta = a?._meta || {};
      const p = meta.lastPayload;
      const at = Number(meta.lastPayloadAt || 0);
      if (!p || !(at > 0)) continue;
      if (Number.isFinite(Number(freshMs)) && freshMs > 0 && (t - at) > freshMs) continue;
      const items = Array.isArray(p?.items) ? p.items : [];
      if (!items.length) continue;
      const row = items.find((r) => normMint(r?.mint ?? r?.id ?? '') === m) || null;
      if (!row) continue;
      const compact = compactAddonItemForAgent(row);
      if (!compact) continue;
      out[id] = {
        at,
        title: truncStr(p?.title || a?.def?.title || a?.def?.label || id, 36),
        metricLabel: truncStr(p?.metricLabel || a?.def?.metricLabel || '', 20),
        ...compact,
      };
      n++;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

export function getKpiMintBundle(mint, { includeSnapshot = true, includeAddons = true } = {}) {
  try {
    const m = normMint(mint);
    if (!m) return null;
    return {
      mint: m,
      at: Date.now(),
      snapshot: includeSnapshot ? getKpiCompactRowForMint(m) : null,
      addons: includeAddons ? getKpiAddonMintSignals(m) : null,
    };
  } catch {
    return null;
  }
}

const DEFAULT_THROTTLE_MS = 200;

function now() { return performance.now ? performance.now() : Date.now(); }

function isActive(addon) {
  return addon.def.updateMode === 'realtime' || addon._meta.active === true;
}

export function addKpiAddon(def, handlers) {
  if (!def || !def.id) return;
  if (!handlers || typeof handlers.computePayload !== 'function') return;

  const updateMode = def.updateMode || 'throttled';
  const throttleMs = getThrottleMs(def);

  if (!ADDONS.has(def.id)) {
    ADDONS.set(def.id, {
      def: { ...def, updateMode, throttleMs },
      ...handlers,
      _meta: {
        nextAt: 0,
        lastSig: '',
        sentFirst: false,
        active: updateMode === 'realtime',
        ingestNextAt: 0,
        ingestedFirst: false,
      }
    });
    try { registerAddon(def); } catch {}
  } else {
    const prev = ADDONS.get(def.id);
    const updatedMeta = {
      ...prev._meta,
      // If newly set to realtime, force active; otherwise keep prior active flag
      active: updateMode === 'realtime' ? true : prev._meta?.active === true
    };
    ADDONS.set(def.id, {
      ...prev,
      def: { ...prev.def, ...def, updateMode, throttleMs },
      ...handlers,
      _meta: updatedMeta
    });
  }
  if (booted) {
    try { ensureAddonsUI(); } catch {}
    try { pushAll(); } catch {}
  }
}

function getThrottleMs(def) {
  if (def.updateMode === 'realtime') return 0;
  if (Number(def.throttleMs) > 0) return Number(def.throttleMs);
  if (Number(def.updateHz) > 0) return Math.max(50, 1000 / Number(def.updateHz));
  return DEFAULT_THROTTLE_MS;
}

export function getLatestSnapshot() {
  return latestSnapshot;
}

function shouldSend(addon) {
  const { def, _meta } = addon;
  if (def.updateMode === 'realtime') return true;
  const t = now();
  if (!_meta.sentFirst) return true;
  if (t >= _meta.nextAt) return true;
  return false;
}

function markSent(addon) {
  const { def, _meta } = addon;
  if (def.updateMode === 'realtime') return;
  _meta.sentFirst = true;
  _meta.nextAt = now() + def.throttleMs;
}

function pushAll() {
  for (const [id, a] of ADDONS) {
    try {
      // Allow a first push even if not active (warm-up render)
      const firstSendDue = !a._meta.sentFirst;
      if (!isActive(a) && !firstSendDue) continue;
      if (!shouldSend(a)) continue;

      const payload = a.computePayload?.(latestSnapshot);
      if (payload && typeof payload === 'object') {
        setAddonData(id, payload);
        try {
          a._meta.lastPayload = payload;
          a._meta.lastPayloadAt = now();
        } catch {}
        markSent(a);
      }
    } catch {}
  }
  try { runAddonsTick(); } catch {}
}

export function ingestSnapshot(items) {
  try {
    latestSnapshot = Array.isArray(items) ? items : [];
    if (latestSnapshot.length) {
      for (const [, a] of ADDONS) {
        const t = now();
        const isRealtime = a.def.updateMode === 'realtime';
        const ingestThrottleMs = Number(a.def.ingestThrottleMs) > 0
          ? Number(a.def.ingestThrottleMs)
          : (a._meta.active || isRealtime ? 0 : Math.max(1000, a.def.throttleMs));

        const due = isRealtime || !a._meta.ingestedFirst || t >= (a._meta.ingestNextAt || 0);
        if (!due) continue;

        const ingestLimit = Number(a.def.ingestLimit) > 0 ? Number(a.def.ingestLimit) : 0;
        const ingestItems = ingestLimit ? latestSnapshot.slice(0, ingestLimit) : latestSnapshot;
        try { a.ingestSnapshot?.(ingestItems); } catch {}

        a._meta.ingestedFirst = true;
        a._meta.ingestNextAt = t + Math.max(0, ingestThrottleMs);
      }
    }
  } finally {
    pushAll();
  }
}

export function setKpiViewed(id, viewed = true) {
  const a = ADDONS.get(id);
  if (!a) return;
  const willBeActive = a.def.updateMode === 'realtime' ? true : !!viewed;
  a._meta.active = willBeActive;
  // On activation, immediately ingest the latest snapshot once
  if (willBeActive && latestSnapshot.length) {
    try { a.ingestSnapshot?.(latestSnapshot); } catch {}
  }
  pushAll();
}

(function boot() {
  // This module is used in the browser. In Node/CLI (e.g. trader simulation),
  // `document` does not exist; skip boot to avoid import-time crashes.
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  function init() {
    booted = true;
    try { ensureAddonsUI?.(); } catch {}
    try { setupViewActivation(); } catch {}
    pushAll();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
  window.pushMemeSnapshot = (items) => ingestSnapshot(items);
  window.viewMemeKpi = (id, viewed = true) => setKpiViewed(id, viewed);
})();

function setupViewActivation() {
  const SELECTOR = '[data-kpi-id]';

  // Click to activate
  document.addEventListener('click', (e) => {
    const el = e.target?.closest?.(SELECTOR);
    if (!el) return;
    const id = el.getAttribute('data-kpi-id');
    if (id) setKpiViewed(id, true);
  }, { passive: true });

  if (!('IntersectionObserver' in window)) return;

  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
        const id = entry.target.getAttribute('data-kpi-id');
        if (id) setKpiViewed(id, true);
        io.unobserve(entry.target);
      }
    }
  }, { threshold: [0.5] });

  // Observe current and future KPI elements
  const observeEl = (el) => { try { io.observe(el); } catch {} };

  document.querySelectorAll(SELECTOR).forEach(observeEl);

  const mo = new MutationObserver((muts) => {
    for (const mut of muts) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches?.(SELECTOR)) observeEl(node);
        node.querySelectorAll?.(SELECTOR)?.forEach(observeEl);
      }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}