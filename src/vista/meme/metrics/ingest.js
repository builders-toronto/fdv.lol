import { registerAddon, setAddonData, runAddonsTick, ensureAddonsUI } from './register.js';

const ADDONS = new Map(); 
let booted = false;
let latestSnapshot = [];

const FLUSH_MIN_GAP_MS = 250;        
const HIDDEN_FLUSH_MS  = 1000;       
const SNAP_SIG_HEAD_N  = 48;         
const PAYLOAD_HEAD_N   = 24;        
const DEFAULT_REALTIME_HZ = 30;     
const MAX_REALTIME_HZ = 60;       

let _flushTimer = 0;
let _lastFlushTs = 0;
let _rafId = 0;

function _now() { return performance?.now?.() || Date.now(); }
function _idle(fn, timeout = FLUSH_MIN_GAP_MS) {
  try {
    if (window.requestIdleCallback) {
      return requestIdleCallback(fn, { timeout });
    }
  } catch {}
  return setTimeout(fn, 0);
}

function _snapshotSig(items) {
  try {
    const n = Math.min(SNAP_SIG_HEAD_N, items.length);
    let s = String(items.length) + '|';
    for (let i = 0; i < n; i++) {
      const it = items[i];
      const m = (it && (it.mint || it.id)) || '';
      s += m + '|';
    }
    return s;
  } catch {
    return String(items?.length || 0);
  }
}

function _payloadSig(p) {
  try {
    const items = Array.isArray(p?.items) ? p.items : [];
    const n = Math.min(PAYLOAD_HEAD_N, items.length);
    let s = `${p?.title || ''}|${p?.metricLabel || ''}|${items.length}|`;
    for (let i = 0; i < n; i++) {
      const it = items[i];
      s += ((it && (it.mint || it.id)) || '') + '|';
    }
    return s;
  } catch {
    return '';
  }
}

function scheduleFlush() {
  if (_flushTimer) return;
  const gap = document.hidden ? HIDDEN_FLUSH_MS : FLUSH_MIN_GAP_MS;
  const delay = Math.max(0, gap - (Date.now() - _lastFlushTs));
  _flushTimer = setTimeout(() => {
    _flushTimer = 0;
    _idle(flushNow, gap);
  }, delay);
}

function flushNow() {
  _lastFlushTs = Date.now();
  const snapshot = latestSnapshot;
  const snapSig = _snapshotSig(snapshot);
  for (const [id, a] of ADDONS) {
    if (a.def?.updateMode === 'realtime') continue; // handled by rAF loop
    const meta = (a._meta ||= { lastSnapSig: '', lastPayloadSig: '', nextAt: 0 });
    if (Date.now() < meta.nextAt) continue;
    if (meta.lastSnapSig === snapSig) continue; // no meaningful change since last flush
    const ingestLimit = Number.isFinite(a.def?.ingestLimit) ? Math.max(1, a.def.ingestLimit) : null;
    const view = ingestLimit ? snapshot.slice(0, ingestLimit) : snapshot;
    try { a.ingestSnapshot?.(view); } catch {}
    try {
      const payload = a.computePayload?.();
      if (payload && typeof payload === 'object') {
        const pSig = _payloadSig(payload);
        if (pSig !== meta.lastPayloadSig) {
          meta.lastPayloadSig = pSig;
          setAddonData(id, payload);
        }
      }
    } catch {}

    meta.lastSnapSig = snapSig;
    meta.nextAt = Date.now() + (document.hidden ? HIDDEN_FLUSH_MS : FLUSH_MIN_GAP_MS);
  }

  try { runAddonsTick(); } catch {}
}

function hasRealtimeAddons() {
  for (const [, a] of ADDONS) if (a.def?.updateMode === 'realtime') return true;
  return false;
}

function scheduleRAF() {
  if (_rafId || !hasRealtimeAddons()) return;
  _rafId = requestAnimationFrame(onRAF);
}




function onRAF(ts) {
  _rafId = 0;

  const snapshot = latestSnapshot;
  const snapSig = _snapshotSig(snapshot);

  const frameStart = _now();
  const maxBudgetMs = 6; // keep under ~6ms of work per frame

  for (const [id, a] of ADDONS) {
    if (a.def?.updateMode !== 'realtime') continue;

    const meta = (a._meta ||= { lastSnapSig: '', lastPayloadSig: '', nextAt: 0, lastIngestAt: 0 });
    const desiredHz = Math.min(
      MAX_REALTIME_HZ,
      Math.max(1, Number(a.def?.updateHz) || DEFAULT_REALTIME_HZ)
    );
    const intervalMs = document.hidden ? Math.max(1000 / desiredHz, HIDDEN_FLUSH_MS) : (1000 / desiredHz);

    if ((performance.now ? performance.now() : Date.now()) < meta.nextAt) continue;

    const ingestLimit = Number.isFinite(a.def?.ingestLimit) ? Math.max(1, a.def.ingestLimit) : 64;
    const view = ingestLimit ? snapshot.slice(0, ingestLimit) : snapshot;

    try {
      if (a.ingestFrame) {
        a.ingestFrame(view);
      } else if (snapSig !== meta.lastSnapSig) {
        // Fallback to normal ingest, but only when the head changed
        a.ingestSnapshot?.(view);
      }
    } catch {}

    try {
      const payload = (a.computePayloadFast ? a.computePayloadFast() : a.computePayload?.());
      if (payload && typeof payload === 'object') {
        const pSig = _payloadSig(payload);
        if (pSig !== meta.lastPayloadSig) {
          meta.lastPayloadSig = pSig;
          setAddonData(id, payload);
        }
      }
    } catch {}

    meta.lastSnapSig = snapSig;
    meta.nextAt = (performance.now ? performance.now() : Date.now()) + intervalMs;

    if ((_now() - frameStart) > maxBudgetMs) break;
  }

  if (hasRealtimeAddons()) {
    _rafId = requestAnimationFrame(onRAF);
  }
}







export function addKpiAddon(def, handlers) {
  if (!def || !def.id) return;
  if (!handlers || typeof handlers.computePayload !== 'function') return;

  const normDef = { updateMode: 'throttled', ...def };

  const next = { def: { ...normDef }, ...handlers, _meta: { lastSnapSig: '', lastPayloadSig: '', nextAt: 0 } };
  if (!ADDONS.has(def.id)) {
    ADDONS.set(def.id, next);
    try { registerAddon(def); } catch {}
  } else {
    const prev = ADDONS.get(def.id);
    ADDONS.set(def.id, { ...prev, def: { ...prev.def, ...normDef }, ...handlers });
  }
  if (booted) {
    try { ensureAddonsUI(); } catch {}
    scheduleFlush();
    scheduleRAF();
  }
}

export function getLatestSnapshot() {
  return latestSnapshot;
}

function pushAll() {
  scheduleFlush();
  scheduleRAF();
}

export function ingestSnapshot(items) {
  latestSnapshot = Array.isArray(items) ? items : [];
  scheduleFlush();
  scheduleRAF();
}

(function boot() {
  function init() {
    booted = true;
    try { ensureAddonsUI?.(); } catch {}
    scheduleFlush();
    scheduleRAF();
    document.addEventListener('visibilitychange', () => {
      // Re-schedule on visibility changes to adapt cadence
      scheduleFlush();
      scheduleRAF();
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
  window.pushMemeSnapshot = (items) => ingestSnapshot(items);
})();