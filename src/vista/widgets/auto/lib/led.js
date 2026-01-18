const STORE_KEY = '__fdvAutoLed';

const RED_BG = '#b91c1c';
const RED_GLOW = '0 0 0 2px rgba(185,28,28,.35), 0 0 8px rgba(185,28,28,.6)';

const GREEN_BG = '#16a34a';
const GREEN_GLOW = '0 0 0 2px rgba(22,163,74,.35), 0 0 8px rgba(22,163,74,.6)';

function _getGlobal() {
  try {
    // eslint-disable-next-line no-undef
    if (typeof globalThis !== 'undefined') return globalThis;
  } catch {}
  try {
    // eslint-disable-next-line no-undef
    if (typeof window !== 'undefined') return window;
  } catch {}
  // eslint-disable-next-line no-undef
  return Function('return this')();
}

function _readEnabledFromLS(key) {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if ('enabled' in parsed) return !!parsed.enabled;
    return null;
  } catch {
    return null;
  }
}

function _getLedEls() {
  try {
    if (typeof document === 'undefined') return [];
    const els = document.querySelectorAll?.('[data-auto-led]');
    return els && typeof els.length === 'number' ? Array.from(els) : [];
  } catch {
    return [];
  }
}

function _applyLedStyle(els, on) {
  if (!els || !els.length) return;
  const bg = on ? GREEN_BG : RED_BG;
  const glow = on ? GREEN_GLOW : RED_GLOW;
  for (const el of els) {
    try {
      el.style.display = 'inline-block';
      el.style.background = bg;
      el.style.backgroundColor = bg;
      el.style.boxShadow = glow;
    } catch {}
  }
}

export function ensureAutoLed() {
  const g = _getGlobal();
  if (g[STORE_KEY]) return g[STORE_KEY];

  const store = {
    bots: Object.create(null),

    anyRunning() {
      try {
        return Object.values(store.bots).some(Boolean);
      } catch {
        return false;
      }
    },

    render() {
      try {
        _applyLedStyle(_getLedEls(), store.anyRunning());
      } catch {}
    },

    setBot(botName, running) {
      const k = String(botName || '').trim() || 'unknown';
      store.bots[k] = !!running;
      store.render();
    },

    syncFromLocalStorage() {
      try {
        const trader = _readEnabledFromLS('fdv_auto_bot_v1');
        if (trader !== null) store.bots.trader = !!trader;
      } catch {}
      try {
        const follow = _readEnabledFromLS('fdv_follow_bot_v1');
        if (follow !== null) store.bots.follow = !!follow;
      } catch {}
      try {
        const sniper = _readEnabledFromLS('fdv_sniper_bot_v1');
        if (sniper !== null) store.bots.sniper = !!sniper;
      } catch {}
      try {
        const hold = _readEnabledFromLS('fdv_hold_bot_v1');
        if (hold !== null) store.bots.hold = !!hold;
      } catch {}
      store.render();
    },
  };

  g[STORE_KEY] = store;
  try {
    if (typeof window !== 'undefined') window[STORE_KEY] = store;
  } catch {}

  // Prime LED from persisted enabled flags (best-effort).
  try { store.syncFromLocalStorage(); } catch {}

  return store;
}

export function setBotRunning(botName, running) {
  try {
    const store = ensureAutoLed();
    store.setBot(botName, running);
    return true;
  } catch {
    return false;
  }
}
