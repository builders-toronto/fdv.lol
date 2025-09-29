import { registerAddon, setAddonData, runAddonsTick, ensureAddonsUI } from './register.js';


const ADDONS = new Map(); 
let booted = false;

export function addKpiAddon(def, handlers) {
  if (!def || !def.id) return;
  if (!handlers || typeof handlers.computePayload !== 'function') return;

  if (!ADDONS.has(def.id)) {
    ADDONS.set(def.id, { def: { ...def }, ...handlers });
    try { registerAddon(def); } catch {}
  } else {
    const prev = ADDONS.get(def.id);
    ADDONS.set(def.id, { def: { ...prev.def, ...def }, ...handlers });
  }
  if (booted) {
    try { ensureAddonsUI(); } catch {}
    try { pushAll(); } catch {}
  }
}

function pushAll() {
  for (const [id, a] of ADDONS) {
    try {
      const payload = a.computePayload();
      if (payload && typeof payload === 'object') {
        setAddonData(id, payload);
      }
    } catch {}
  }
  try { runAddonsTick(); } catch {}
}

export function ingestSnapshot(items) {
  try {
    if (Array.isArray(items) && items.length) {
      for (const [, a] of ADDONS) {
        try { a.ingestSnapshot?.(items); } catch {}
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