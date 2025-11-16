import { registerAddon, setAddonData, runAddonsTick, ensureAddonsUI } from './register.js';

const ADDONS = new Map();
let booted = false;
let latestSnapshot = [];

const DEFAULT_THROTTLE_MS = 1500;

function now() { return performance.now ? performance.now() : Date.now(); }

export function addKpiAddon(def, handlers) {
  if (!def || !def.id) return;
  if (!handlers || typeof handlers.computePayload !== 'function') return;

  const updateMode = def.updateMode || 'throttled';
  const throttleMs = getThrottleMs(def);

  if (!ADDONS.has(def.id)) {
    ADDONS.set(def.id, {
      def: { ...def, updateMode, throttleMs },
      ...handlers,
      _meta: { nextAt: 0, lastSig: '', sentFirst: false }
    });
    try { registerAddon(def); } catch {}
  } else {
    const prev = ADDONS.get(def.id);
    ADDONS.set(def.id, {
      ...prev,
      def: { ...prev.def, ...def, updateMode, throttleMs },
      ...handlers
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
        try { a.ingestSnapshot?.(latestSnapshot); } catch {}
      }
    }
  } finally {
    pushAll();
  }
}

(function boot() {
  function init() {
    booted = true;
    try { ensureAddonsUI?.(); } catch {}
    pushAll();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
  window.pushMemeSnapshot = (items) => ingestSnapshot(items);
})();