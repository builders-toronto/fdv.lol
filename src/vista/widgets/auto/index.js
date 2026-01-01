import { initVolumeWidget } from './volume/index.js';
import { initFollowWidget } from './follow/index.js';
import { initSniperWidget } from './sniper/index.js';
import {
  initTraderWidget,
  getAutoTraderState,
  saveAutoTraderState,
} from './trader/index.js';

import { importFromUrl } from '../../../utils/netImport.js';
import { ensureAutoLed } from './lib/autoLed.js';

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
      <span class="fdv-title">FDV Auto Tools</span>
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
    <div class="fdv-tabs" style="display:flex; gap:8px; margin:8px 0;">
      <button class="fdv-tab-btn active" data-main-tab="auto">Auto</button>
      <button class="fdv-tab-btn" data-main-tab="follow">Follow</button>
      <button class="fdv-tab-btn" data-main-tab="sniper">Sniper</button>
      <button class="fdv-tab-btn" data-main-tab="volume">Volume</button>
    </div>

    <div data-main-tab-panel="auto" class="tab-panel active">
      <div id="trader-container"></div>
    </div>

    <div data-main-tab-panel="volume" class="tab-panel" style="display:none;">
      <div id="volume-container"></div>
    </div>

    <div data-main-tab-panel="follow" class="tab-panel" style="display:none;">
      <div id="follow-container"></div>
    </div>

    <div data-main-tab-panel="sniper" class="tab-panel" style="display:none;">
      <div id="sniper-container"></div>
    </div>

    <div class="fdv-bot-footer" style="display:flex;justify-content:space-between;margin-top:12px; font-size:12px; text-align:right; opacity:0.6;">
      <a href="https://t.me/fdvlolgroup" target="_blank" data-auto-help-tg>t.me/fdvlolgroup</a>
      <span>Version: 0.0.5.3</span>
    </div>
  `;

  wrap.appendChild(summary);
  wrap.appendChild(body);
  container.appendChild(wrap);

  try { ensureAutoLed(); } catch {}

  initTraderWidget(body.querySelector('#trader-container'));
  initVolumeWidget(body.querySelector('#volume-container'));
  initFollowWidget(body.querySelector('#follow-container'));
  initSniperWidget(body.querySelector('#sniper-container'));

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
    openPumpKpi();
  });
}
