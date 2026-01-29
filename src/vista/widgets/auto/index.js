import { initVolumeWidget } from './volume/index.js';
import { initFollowWidget } from './follow/index.js';
import { initSniperWidget } from './sniper/index.js';
import { initHoldWidget } from './hold/index.js';
import { maybeShowAutoTraderFirstRunHelp } from './help/index.js';
import {
  initTraderWidget,
  getAutoTraderState,
  saveAutoTraderState,
} from './trader/index.js';

import { importFromUrl } from '../../../utils/netImport.js';
import { ensureAutoLed } from './lib/led.js';
import { getLatestSnapshot } from '../../meme/metrics/ingest.js';
import { initFlamebar } from './lib/flamebar.js';

function ensureAutoDeps() {
  if (typeof window === 'undefined') return Promise.resolve({ web3: null, bs58: null });
  if (window._fdvAutoDepsPromise) return window._fdvAutoDepsPromise;

  window._fdvAutoDepsPromise = (async () => {
    // Web3
    let web3 = window.solanaWeb3;
    if (!web3) {
      try {
        web3 = await importFromUrl('https://cdn.jsdelivr.net/npm/@solana/web3.js@1.95.4/+esm', {
          cacheKey: 'fdv:auto:web3@1.95.4',
        });
      } catch {
        web3 = await importFromUrl('https://esm.sh/@solana/web3.js@1.95.4?bundle', {
          cacheKey: 'fdv:auto:web3@1.95.4',
        });
      }
      window.solanaWeb3 = web3;
    }

    // bs58
    let bs58Mod = window._fdvBs58Module;
    let bs58 = window.bs58;
    if (!bs58Mod) {
      try {
        bs58Mod = await importFromUrl('https://cdn.jsdelivr.net/npm/bs58@6.0.0/+esm', {
          cacheKey: 'fdv:auto:bs58@6.0.0',
        });
      } catch {
        bs58Mod = await importFromUrl('https://esm.sh/bs58@6.0.0?bundle', {
          cacheKey: 'fdv:auto:bs58@6.0.0',
        });
      }
      window._fdvBs58Module = bs58Mod;
    }
    if (!bs58) {
      bs58 = bs58Mod?.default || bs58Mod;
      window.bs58 = bs58;
    }

    window._fdvAutoDeps = { web3, bs58 };
    return window._fdvAutoDeps;
  })();

  return window._fdvAutoDepsPromise;
}


export function initAutoWidget(container = document.body) {
  try { ensureAutoDeps(); } catch {}

  const wrap = document.createElement('details');
  wrap.className = 'fdv-auto-wrap';

  try {
    const st = getAutoTraderState();
    wrap.open = !(st && st.collapsed);
  } catch {
    wrap.open = true;
  }

  const summary = document.createElement('summary');
  summary.innerHTML = `
    <span class="fdv-acc-title" style="position:relative; display:block;">
      <svg class="fdv-acc-caret" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 10l4 4 4-4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>
      <span class="fdv-title">FDV Auto Tools Panel</span>
    </span>
    <span data-auto-led title="Status"
            style="display:inline-block; width:10px; height:10px; border-radius:50%;
                   background:#b91c1c; box-shadow:0 0 0 2px rgba(185,28,28,.3), 0 0 8px rgba(185,28,28,.6);">
    </span>
  `;

  const body = document.createElement('div');
  body.className = 'fdv-auto-body';
  body.innerHTML = `
    <div class="fdv-auto-head"></div>
    <div class="fdv-flamebar-slot" data-flamebar-slot></div>
    <div data-auto-firsthelp-slot></div>
    <div class="fdv-tabs" style="display:flex; margin-bottom: 25px; gap:8px; overflow: scroll;">
      <button class="fdv-tab-btn active" data-main-tab="auto">Auto</button>
      <button class="fdv-tab-btn" data-main-tab="follow">Follow</button>
      <button class="fdv-tab-btn" data-main-tab="sniper">Sentry</button>
      <button class="fdv-tab-btn" data-main-tab="hold">Hold</button>
      <button class="fdv-tab-btn hidden" data-main-tab="volume" disabled>Volume</button>
    </div>

    <div data-main-tab-panel="auto" class="tab-panel active">
      <div id="trader-container"></div>
    </div>

    <div data-main-tab-panel="volume" class="tab-panel" style="display:none;" disabled>
      <div id="volume-container"></div>
    </div>

    <div data-main-tab-panel="follow" class="tab-panel" style="display:none;">
      <div id="follow-container"></div>
    </div>

    <div data-main-tab-panel="sniper" class="tab-panel" style="display:none;">
      <div id="sniper-container"></div>
    </div>

    <div data-main-tab-panel="hold" class="tab-panel" style="display:none;">
      <div id="hold-container"></div>
    </div>

    <div class="fdv-bot-footer" style="display:flex;justify-content:space-between;margin-top:12px; font-size:12px; text-align:right; opacity:0.6;">
      <a href="https://t.me/fdvlolgroup" target="_blank" data-auto-help-tg>t.me/fdvlolgroup</a>
      <span>Version: 0.0.6.8</span>
    </div>
  `;

  wrap.appendChild(summary);
  wrap.appendChild(body);
  container.appendChild(wrap);

  const flamebarSlot = body.querySelector('[data-flamebar-slot]');
  const flamebar = initFlamebar(flamebarSlot, {
    getSnapshot: getLatestSnapshot,
    isActive: () => !!(wrap && wrap.isConnected && wrap.open),
  });

  try {
    flamebar?.setActive?.(!!wrap.open);
    wrap.addEventListener('toggle', () => {
      try { flamebar?.setActive?.(!!wrap.open); } catch {}
    });
  } catch {}

  try { ensureAutoLed(); } catch {}

  initTraderWidget(body.querySelector('#trader-container'));
  initVolumeWidget(body.querySelector('#volume-container'));
  initFollowWidget(body.querySelector('#follow-container'));
  initSniperWidget(body.querySelector('#sniper-container'));
  const holdApi = initHoldWidget(body.querySelector('#hold-container'));
  try { window._fdvHoldWidgetApi = holdApi || null; } catch {}

  const firstHelpSlot = body.querySelector('[data-auto-firsthelp-slot]');
  const maybeShowFirstRunHelpInline = () => {
    try {
      if (!wrap.open) return;
      if (!firstHelpSlot) return;
      maybeShowAutoTraderFirstRunHelp(firstHelpSlot);
    } catch {}
  };

  // Show first-run help when the user opens the Auto panel.
  try { if (wrap.open) setTimeout(maybeShowFirstRunHelpInline, 0); } catch {}

  const mainTabBtns = wrap.querySelectorAll('[data-main-tab]');
  const mainTabPanels = wrap.querySelectorAll('[data-main-tab-panel]');
  function activateMainTab(name) {
    mainTabBtns.forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-main-tab') === name);
    });
    mainTabPanels.forEach((p) => {
      const on = p.getAttribute('data-main-tab-panel') === name;
      p.style.display = on ? '' : 'none';
      p.classList.toggle('active', on);
    });
  }
  mainTabBtns.forEach((b) =>
    b.addEventListener('click', (e) => {
      e.preventDefault();
      activateMainTab(b.getAttribute('data-main-tab'));
    }),
  );
  activateMainTab('auto');

  function _parseJsonAttr(str) {
    if (!str) return null;
    try { return JSON.parse(str); } catch { return null; }
  }

  function _scrollToHoldPanel() {
    try {
      const holdEl = body.querySelector('#hold-container') || body.querySelector('[data-main-tab-panel="hold"]') || wrap;

      const findScrollParent = (el) => {
        try {
          let p = el?.parentElement;
          while (p && p !== document.body) {
            const cs = getComputedStyle(p);
            const oy = String(cs.overflowY || '');
            if ((oy.includes('auto') || oy.includes('scroll') || oy.includes('overlay')) && (p.scrollHeight > p.clientHeight + 2)) {
              return p;
            }
            p = p.parentElement;
          }
        } catch {}
        return document.getElementById('app') || document.scrollingElement || document.documentElement;
      };

      const scrollOnce = () => {
        try { holdEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}

        try {
          const scroller = findScrollParent(holdEl);
          const r = holdEl.getBoundingClientRect();

          const isDoc = scroller === document.documentElement || scroller === document.body || scroller === document.scrollingElement;
          const sr = isDoc ? { top: 0, height: window.innerHeight } : scroller.getBoundingClientRect();

          const currentTop = isDoc
            ? Number(window.pageYOffset || document.documentElement.scrollTop || 0)
            : Number(scroller.scrollTop || 0);

          const targetTop = currentTop + (r.top - sr.top) - (sr.height / 2 - r.height / 2);
          const nextTop = Math.max(0, targetTop);

          if (isDoc) {
            window.scrollTo({ top: nextTop, behavior: 'smooth' });
          } else {
            scroller.scrollTo({ top: nextTop, behavior: 'smooth' });
          }
        } catch {}
      };

      requestAnimationFrame(scrollOnce);
      setTimeout(scrollOnce, 120);
      setTimeout(scrollOnce, 260);
    } catch {}
  }

  function _openHoldForMint(mint, { config, tokenHydrate, start, logLoaded, createNew } = {}) {
    const m = String(mint || '').trim();
    if (!m) return false;

    try {
      wrap.open = true;
      const st = getAutoTraderState();
      st.collapsed = false;
      saveAutoTraderState();
    } catch {}

    try { activateMainTab('hold'); } catch {}

    try { _scrollToHoldPanel(); } catch {}

    try {
      const api = (holdApi && typeof holdApi.openForMint === 'function')
        ? holdApi
        : (window._fdvHoldWidgetApi && typeof window._fdvHoldWidgetApi.openForMint === 'function')
          ? window._fdvHoldWidgetApi
          : null;

      if (api) {
        api.openForMint({ mint: m, config, tokenHydrate, start: !!start, logLoaded: !!logLoaded, createNew: !!createNew });
        return true;
      }
    } catch {}

    try {
      const fn = window.__fdvHoldOpenForMint;
      if (typeof fn === 'function') {
        fn(m, { config, tokenHydrate, start: !!start, logLoaded: !!logLoaded, createNew: !!createNew });
        return true;
      }
    } catch {}

    return false;
  }

  try {
    const raw = localStorage.getItem('fdv_hold_open_request_v1');
    if (raw) {
      localStorage.removeItem('fdv_hold_open_request_v1');
      const req = _parseJsonAttr(raw) || {};
      const rmint = String(req.mint || '').trim();
      if (rmint) {
        _openHoldForMint(rmint, { config: req.config, tokenHydrate: req.tokenHydrate, start: !!req.start });
      }
    }
  } catch {}

  try {
    document.addEventListener('click', (e) => {
      const el = e?.target?.closest?.('[data-hold-btn]');
      if (!el) return;
      e.preventDefault();
      try {
        if (el.tagName === 'BUTTON') {
          const prev = el.textContent;
          if (!el.dataset._holdPrevText) el.dataset._holdPrevText = prev;
          el.setAttribute('aria-busy', 'true');
          el.disabled = true;
          el.textContent = 'Opening…';
          window.setTimeout(() => {
            try {
              el.removeAttribute('aria-busy');
              el.disabled = false;
              el.textContent = el.dataset._holdPrevText || prev;
            } catch {}
          }, 900);
        }
      } catch {}

      const card = el.closest('.card');
      const mint = el.dataset.mint || card?.dataset?.mint;
      const tokenHydrate = _parseJsonAttr(card?.dataset?.tokenHydrate) || null;

      _openHoldForMint(mint, { tokenHydrate, logLoaded: true, createNew: true });
    });
  } catch {}

  try {
    window.addEventListener('fdv:hold:open', (evt) => {
      const d = evt?.detail || {};
      _openHoldForMint(d.mint, { config: d.config, tokenHydrate: d.tokenHydrate, start: d.start });
    });
  } catch {}

  const openPumpKpi = () => {
    let opened = false;
    const pumpBtn = document.getElementById('pumpingToggle') || document.querySelector('button[title="PUMP"]');
    if (!pumpBtn) return opened;

    const isExpanded = String(pumpBtn.getAttribute('aria-expanded') || 'false') === 'true';
    if (isExpanded) return true;

    try {
      pumpBtn.click();
      opened = true;
    } catch {}

    const panelId = pumpBtn.getAttribute('aria-controls') || 'pumpingPanel';
    const panel = document.getElementById(panelId) || document.querySelector('#pumpingPanel');
    if (panel) {
      panel.removeAttribute('hidden');
      panel.style.display = '';
      panel.classList.add('open');
    }
    return opened;
  };

  try {
    const hasAutomate =
      typeof location !== 'undefined' &&
      (String(location.hash || '').toLowerCase().includes('automate') ||
        String(location.search || '').toLowerCase().includes('automate'));
    if (hasAutomate) {
      wrap.open = true;
      try {
        const st = getAutoTraderState();
        st.collapsed = false;
        saveAutoTraderState();
      } catch {}
      openPumpKpi();
      setTimeout(openPumpKpi, 0);
      setTimeout(openPumpKpi, 250);
    }
  } catch {}

  wrap.addEventListener('toggle', () => {
    try {
      const st = getAutoTraderState();
      st.collapsed = !wrap.open;
      saveAutoTraderState();
    } catch {}
    if (wrap.open) maybeShowFirstRunHelpInline();
    openPumpKpi();
  });
}
