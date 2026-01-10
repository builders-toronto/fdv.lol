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
import { ensureAutoLed } from './lib/autoLed.js';
import { getLatestSnapshot } from '../../meme/metrics/ingest.js';
import { getTokenLogoPlaceholder, queueTokenLogoLoad } from '../../../core/ipfs.js';

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

  const FLAMEBAR_WINDOW_MS = 15 * 60 * 1000;
  const FLAMEBAR_MAX_POINTS = 90;
  const FLAMEBAR_TICK_MS = 1250;
  const FLAMEBAR_SWITCH_MARGIN_PCT = 0.25;
  const flamebarStore = new Map();
  let flamebarLeaderMint = null;
  let flamebarTimer = null;

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

    <div data-main-tab-panel="hold" class="tab-panel" style="display:none;">
      <div id="hold-container"></div>
    </div>

    <div class="fdv-bot-footer" style="display:flex;justify-content:space-between;margin-top:12px; font-size:12px; text-align:right; opacity:0.6;">
      <a href="https://t.me/fdvlolgroup" target="_blank" data-auto-help-tg>t.me/fdvlolgroup</a>
      <span>Version: 0.0.5.7</span>
    </div>
  `;

  wrap.appendChild(summary);
  wrap.appendChild(body);
  container.appendChild(wrap);

  // Flamebar (top PnL leader) — uses the meme KPI snapshot feed.
  const flamebarSlot = body.querySelector('[data-flamebar-slot]');
  const flamebarFrame = document.createElement('div');
  flamebarFrame.className = 'fdv-flamebar-frame';
  const flamebarCard = document.createElement('div');
  flamebarCard.className = 'card fdv-flamebar-card';
  flamebarCard.dataset.mint = '';
  flamebarCard.innerHTML = `
    <div class="fdv-flamebar-inner">
      <div class="fdv-flamebar-top">
        <div class="fdv-flamebar-title">
          <span class="fdv-flamebar-badge">FLAMEBAR</span>
          <span class="fdv-flamebar-sub">Top PnL (15m)</span>
        </div>
        <div class="fdv-flamebar-kpi">
          <span class="fdv-flamebar-pnl" data-flamebar-pnl>—</span>
          <span class="fdv-flamebar-meta" data-flamebar-meta>Waiting for snapshot…</span>
        </div>
      </div>

      <div class="fdv-flamebar-coin" data-flamebar-coin hidden>
        <div class="fdv-flamebar-logo" aria-hidden="true"><img data-flamebar-img alt="" /></div>
        <div class="fdv-flamebar-cointext">
          <div class="fdv-flamebar-sym" data-flamebar-sym></div>
          <div class="fdv-flamebar-name" data-flamebar-name></div>
          <div class="fdv-flamebar-mint" data-flamebar-mint></div>
        </div>
        <button class="btn holdCoin fdv-flamebar-hodl" data-hold-btn data-mint="" type="button">HODL</button>
      </div>

      <div class="fdv-flamebar-bar" aria-hidden="true">
        <div class="fdv-flamebar-fill" data-flamebar-fill></div>
      </div>
    </div>
  `;
  try {
    flamebarFrame.appendChild(flamebarCard);
    flamebarSlot?.appendChild(flamebarFrame);
  } catch {}

  const flamebarEls = {
    pnl: flamebarCard.querySelector('[data-flamebar-pnl]'),
    meta: flamebarCard.querySelector('[data-flamebar-meta]'),
    coin: flamebarCard.querySelector('[data-flamebar-coin]'),
    img: flamebarCard.querySelector('[data-flamebar-img]'),
    sym: flamebarCard.querySelector('[data-flamebar-sym]'),
    name: flamebarCard.querySelector('[data-flamebar-name]'),
    mint: flamebarCard.querySelector('[data-flamebar-mint]'),
    hodlBtn: flamebarCard.querySelector('[data-hold-btn]'),
    fill: flamebarCard.querySelector('[data-flamebar-fill]'),
  };

  const _num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const _clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const _fmtPct = (v) => {
    const n = _num(v);
    if (n === null) return '—';
    const sign = n > 0 ? '+' : '';
    const abs = Math.abs(n);
    const dp = abs >= 10 ? 1 : 2;
    return `${sign}${n.toFixed(dp)}%`;
  };
  const _fmtUsd = (v) => {
    const n = _num(v);
    if (n === null) return '—';
    if (n >= 1000) return `$${n.toFixed(0)}`;
    if (n >= 1) return `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
    return `$${n.toPrecision(3)}`;
  };
  const _shortMint = (m) => {
    const s = String(m || '');
    if (s.length <= 12) return s;
    return `${s.slice(0, 4)}…${s.slice(-4)}`;
  };

  function _extractMint(item) {
    return String(item?.mint || item?.tokenMint || item?.token?.mint || '').trim() || null;
  }
  function _extractPriceUsd(item) {
    return _num(item?.priceUsd ?? item?.price ?? item?.usdPrice);
  }
  function _extractImage(item) {
    return String(item?.image || item?.logo || item?.icon || '').trim() || '';
  }
  function _extractSymbol(item) {
    return String(item?.symbol || item?.sym || item?.ticker || '').trim() || '';
  }
  function _extractName(item) {
    return String(item?.name || item?.tokenName || '').trim() || '';
  }

  function _pushPoint(mint, t, price, meta) {
    const prev = flamebarStore.get(mint);
    const rec = prev || {
      mint,
      series: [],
      lastSeenAt: 0,
      lastPriceUsd: null,
      symbol: '',
      name: '',
      image: '',
    };

    rec.lastSeenAt = t;
    rec.lastPriceUsd = price;
    if (meta) {
      if (meta.symbol) rec.symbol = meta.symbol;
      if (meta.name) rec.name = meta.name;
      if (meta.image) rec.image = meta.image;
    }

    const s = rec.series;
    if (s.length > 0 && (t - s[s.length - 1].t) < 450) {
      // Avoid flooding points if multiple renders happen in same tick.
      s[s.length - 1] = { t, p: price };
    } else {
      s.push({ t, p: price });
    }

    const cutoff = t - FLAMEBAR_WINDOW_MS;
    while (s.length && s[0].t < cutoff) s.shift();
    while (s.length > FLAMEBAR_MAX_POINTS) s.shift();

    flamebarStore.set(mint, rec);
    return rec;
  }

  function _computeWindowPnlPct(rec) {
    const s = rec?.series;
    if (!s || s.length < 2) return null;
    const first = _num(s[0]?.p);
    const last = _num(s[s.length - 1]?.p);
    if (!first || !last) return null;
    if (first <= 0) return null;
    return ((last - first) / first) * 100;
  }

  function _pickLeader(nowTs) {
    let best = null;
    let bestPnl = -Infinity;
    for (const rec of flamebarStore.values()) {
      if (!rec) continue;
      if (nowTs - rec.lastSeenAt > (FLAMEBAR_WINDOW_MS * 2)) continue;
      const pnl = _computeWindowPnlPct(rec);
      if (pnl === null) continue;
      if (pnl > bestPnl) {
        bestPnl = pnl;
        best = rec;
      }
    }
    return { best, bestPnl: Number.isFinite(bestPnl) ? bestPnl : null };
  }

  function _renderFlamebar({ rec, pnlPct, nowTs, sampleCount }) {
    const has = !!(rec && rec.mint);
    const mint = has ? rec.mint : '';

    flamebarCard.dataset.mint = mint;
    if (flamebarEls.hodlBtn) flamebarEls.hodlBtn.dataset.mint = mint;

    try {
      const tokenHydrate = has
        ? {
            mint,
            symbol: rec.symbol || _extractSymbol(rec) || '',
            name: rec.name || _extractName(rec) || '',
            image: rec.image || _extractImage(rec) || '',
            priceUsd: rec.lastPriceUsd,
          }
        : null;
      flamebarCard.dataset.tokenHydrate = tokenHydrate ? JSON.stringify(tokenHydrate) : '';
    } catch {
      flamebarCard.dataset.tokenHydrate = '';
    }

    if (flamebarEls.coin) flamebarEls.coin.hidden = !has;

    if (!has) {
      if (flamebarEls.pnl) flamebarEls.pnl.textContent = '—';
      if (flamebarEls.meta) flamebarEls.meta.textContent = 'Waiting for snapshot…';
      if (flamebarEls.fill) flamebarEls.fill.style.width = '0%';
      flamebarFrame.style.setProperty('--fdv-flame-alpha', '0.35');
      return;
    }

    const pnlText = _fmtPct(pnlPct);
    if (flamebarEls.pnl) flamebarEls.pnl.textContent = pnlText;

    const priceText = _fmtUsd(rec.lastPriceUsd);
    const sampleText = sampleCount ? `${sampleCount} samples` : '—';
    if (flamebarEls.meta) flamebarEls.meta.textContent = `${priceText} • ${sampleText}`;

    const sym = rec.symbol || '—';
    const name = rec.name || '';
    if (flamebarEls.sym) flamebarEls.sym.textContent = sym;
    if (flamebarEls.name) flamebarEls.name.textContent = name;
    if (flamebarEls.mint) flamebarEls.mint.textContent = _shortMint(mint);

    try {
      const rawLogo = rec.image || '';
      const img = flamebarEls.img;
      if (img) {
        // Always show a placeholder immediately, and load IPFS logos via the shared cache/loader.
        img.src = getTokenLogoPlaceholder(rawLogo, sym) || '';
        queueTokenLogoLoad(img, rawLogo, sym);
      }
    } catch {}

    const fill = _clamp((_num(pnlPct) || 0) / 20, 0, 1) * 100;
    if (flamebarEls.fill) flamebarEls.fill.style.width = `${fill.toFixed(1)}%`;

    const alpha = _clamp(((_num(pnlPct) || 0) / 12) + 0.35, 0.25, 0.95);
    flamebarFrame.style.setProperty('--fdv-flame-alpha', String(alpha));
    flamebarFrame.style.setProperty('--fdv-flame-fill', `${fill.toFixed(1)}%`);
  }

  function _flamebarTick() {
    const nowTs = Date.now();
    try {
      // Prune long-dead mints.
      for (const [mint, rec] of flamebarStore) {
        if (!rec || (nowTs - rec.lastSeenAt) > (FLAMEBAR_WINDOW_MS * 3)) flamebarStore.delete(mint);
      }
    } catch {}

    const snap = getLatestSnapshot();
    const items = Array.isArray(snap) ? snap : (Array.isArray(snap?.items) ? snap.items : []);
    if (!items || items.length === 0) {
      _renderFlamebar({ rec: null, pnlPct: null, nowTs, sampleCount: 0 });
      return;
    }

    // Ingest current snapshot prices into the windowed history.
    for (const item of items) {
      const mint = _extractMint(item);
      if (!mint) continue;
      const price = _extractPriceUsd(item);
      if (price === null || price <= 0) continue;
      _pushPoint(mint, nowTs, price, {
        symbol: _extractSymbol(item),
        name: _extractName(item),
        image: _extractImage(item),
      });
    }

    const { best, bestPnl } = _pickLeader(nowTs);
    if (!best) {
      _renderFlamebar({ rec: null, pnlPct: null, nowTs, sampleCount: 0 });
      return;
    }

    // Leader hysteresis to reduce flicker.
    try {
      if (flamebarLeaderMint && flamebarLeaderMint !== best.mint) {
        const cur = flamebarStore.get(flamebarLeaderMint);
        const curPnl = cur ? _computeWindowPnlPct(cur) : null;
        if (curPnl !== null && bestPnl !== null && (bestPnl - curPnl) < FLAMEBAR_SWITCH_MARGIN_PCT) {
          _renderFlamebar({ rec: cur, pnlPct: curPnl, nowTs, sampleCount: cur?.series?.length || 0 });
          return;
        }
      }
    } catch {}

    flamebarLeaderMint = best.mint;
    _renderFlamebar({ rec: best, pnlPct: bestPnl, nowTs, sampleCount: best?.series?.length || 0 });
  }

  function _startFlamebarLoop() {
    if (flamebarTimer) return;
    flamebarTimer = window.setInterval(() => {
      try {
        if (!wrap.isConnected) return;
        if (!wrap.open) return;
        _flamebarTick();
      } catch {}
    }, FLAMEBAR_TICK_MS);
  }
  function _stopFlamebarLoop() {
    if (!flamebarTimer) return;
    try { window.clearInterval(flamebarTimer); } catch {}
    flamebarTimer = null;
  }

  try {
    // Start/stop updates based on whether the Auto panel is open.
    if (wrap.open) {
      _startFlamebarLoop();
      setTimeout(_flamebarTick, 0);
    }
    wrap.addEventListener('toggle', () => {
      if (wrap.open) {
        _startFlamebarLoop();
        setTimeout(_flamebarTick, 0);
      } else {
        _stopFlamebarLoop();
      }
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
