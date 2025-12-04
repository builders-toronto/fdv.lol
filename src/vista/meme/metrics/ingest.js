import { registerAddon, setAddonData, runAddonsTick, ensureAddonsUI } from './register.js';

const ADDONS = new Map();
let booted = false;
let latestSnapshot = [];

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
      _meta: { nextAt: 0, lastSig: '', sentFirst: false, active: updateMode === 'realtime' }
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

      const payload = a.computePayload?.();
      if (payload && typeof payload === 'object') {
        setAddonData(id, payload);
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
        // Allow first ingest for throttled KPIs even if not active (warm-up data)
        const firstSendDue = !a._meta.sentFirst;
        if (!isActive(a) && !firstSendDue) continue;
        try { a.ingestSnapshot?.(latestSnapshot); } catch {}
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