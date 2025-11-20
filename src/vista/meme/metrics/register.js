
import { normalizeTokenLogo } from '../../../core/ipfs.js';
import { sparklineSVG } from '../render/sparkline.js';

const REGISTRY = [];
const STATE = new Map(); 
const ITEM_HISTORY = new Map();

const SPARK_LENGTH = 24;
const SPARK_MIN_INTERVAL_MS = 1500;
const SPARK_MOUNTS = new Map();

function updateItemHistory(mint, price) {
  if (!mint || !Number.isFinite(price) || price <= 0) return [];
  const now = Date.now();

  let rec = ITEM_HISTORY.get(mint);
  if (!rec) {
    rec = { base: price, chg: [0], lastPrice: price, lastTs: now };
    ITEM_HISTORY.set(mint, rec);
    return rec.chg;
  }

  if (!Number.isFinite(rec.base) || rec.base <= 0) rec.base = price;
  const tooSoon = now - (rec.lastTs || 0) < SPARK_MIN_INTERVAL_MS;
  const tinyDelta = Math.abs(price - rec.lastPrice) / Math.max(rec.lastPrice, 1e-9) < 0.0005; // <0.05%
  if (tooSoon && tinyDelta) {
    rec.lastPrice = price;
    return rec.chg;
  }

  const pct = ((price / rec.base) - 1) * 100;
  const lastVal = rec.chg[rec.chg.length - 1];
  if (rec.chg.length === 0 || Math.abs(pct - lastVal) >= 0.01) {
    rec.chg = [...rec.chg, pct].slice(-SPARK_LENGTH);
  }

  rec.lastPrice = price;
  rec.lastTs = now;
  ITEM_HISTORY.set(mint, rec);
  return rec.chg;
}

function getHeaderToolsStrip() {
  return document.getElementById('hdrTools') || null;
}

const DEFAULT_LIMIT = 3;
function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v >= 1000) return '$' + Intl.NumberFormat(undefined, { notation: 'compact' }).format(v);
  if (v > 0) return '$' + v.toFixed(2);
  return '$0';
}
function fmtPrice(p) {
  const v = Number(p);
  if (!Number.isFinite(v)) return '—';
  return v >= 1 ? `$${v.toLocaleString(undefined,{maximumFractionDigits:2})}` : `$${v.toFixed(6)}`;
}
function pct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return { txt: '—', cls: '' };
  const txt = `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
  return { txt, cls: n >= 0 ? 'ch-pos' : 'ch-neg' };
}

function ensureAddonUI(addon) {
  const strip = getHeaderToolsStrip();
  if (!strip) return null;

  const toolsRow = strip.querySelector('#hdrToolsRow');
  const panelsRow = strip.querySelector('#hdrToolsPanels');
  if (!toolsRow || !panelsRow) return null;

  const wrapId = `${addon.id}Wrap`;
  const panelId = `${addon.id}Panel`;
  const toggleId = `${addon.id}Toggle`;
  const closeId = `${addon.id}Close`;
  const listId = `${addon.id}List`;
  const labelId = `${addon.id}Label`;

  let wrap = document.getElementById(wrapId);
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = wrapId;
    wrap.className = 'addon-wrap';
    wrap.innerHTML = `<button class="addon-btn" id="${toggleId}" aria-expanded="false" aria-controls="${panelId}" title="${addon.tooltip || addon.label}">${addon.label}</button>`;
    toolsRow.appendChild(wrap);
  }

  let panel = document.getElementById(panelId);
  if (!panel) {
    panel = document.createElement('div');
    panel.id = panelId;
    panel.className = 'addon-panel';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-labelledby', labelId);
    panel.innerHTML = `
      <div class="addon-head">
        <div class="title" id="${labelId}">${addon.title || addon.label}</div>
        <button class="addon-btn" id="${closeId}" style="height:28px;padding:0 10px;border:none;">Close</button>
      </div>
      <ul class="addon-list" id="${listId}"></ul>
    `;
    panelsRow.appendChild(panel);
  }

  const toggle = document.getElementById(toggleId);
  const close = document.getElementById(closeId);
  const setOpen = (on) => {
    panel.classList.toggle('show', on);
    toggle.setAttribute('aria-expanded', on ? 'true' : 'false');
  };
  toggle.onclick = () => setOpen(!panel.classList.contains('show'));
  close.onclick = () => setOpen(false);
  document.addEventListener('click', (e) => { if (!strip.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });

  return { wrap, panel, listEl: document.getElementById(listId), labelEl: document.getElementById(labelId), toggleEl: document.getElementById(toggleId) };
}

function getItemChangeSeries(mint) {
  const rec = ITEM_HISTORY.get(mint);
  return Array.isArray(rec?.chg) ? rec.chg : [];
}

function renderAddon(addon) {
  const ui = ensureAddonUI(addon);
  if (!ui) return;


  const st = STATE.get(addon.id) || {};
  const items = Array.isArray(st.items) ? st.items.slice(0, addon.limit || DEFAULT_LIMIT) : [];
  const metricLabel = st.metricLabel || addon.metricLabel || 'Score';

  if (ui.toggleEl) {
    if (st.notify && st.notifyToken) {
      if (ui.toggleEl.dataset.notifyToken !== String(st.notifyToken)) {
        ui.toggleEl.classList.remove('addon-btn--notify');
        void ui.toggleEl.offsetHeight;
        ui.toggleEl.classList.add('addon-btn--notify');
        ui.toggleEl.dataset.notifyToken = String(st.notifyToken);
      }
    } else {
      ui.toggleEl.classList.remove('addon-btn--notify');
      delete ui.toggleEl.dataset.notifyToken;
    }
  }

  if (ui.labelEl && (addon.title || st.title || addon.label)) {
    ui.labelEl.textContent = st.title || addon.title || addon.label;
  }
  if (!ui.listEl) return;

  if (!items.length) {
    ui.listEl.innerHTML = `
      <li class="addon-item">
        <div class="quick-spinner-wrap">
          <div class="quick-spinner"></div>
          <div class="quick-loading-msg">Loading… keep the stream running.</div>
        </div>
      </li>`;
    return;
  }

  ui.listEl.innerHTML = items.map((row, i) => {
    const logo = normalizeTokenLogo(row.imageUrl || row.logoURI || '', row.symbol || '');
    const sym = row.symbol || '';
    const name = row.name || '';
    const price = fmtPrice(row.priceUsd);
    const { txt: chTxt, cls: chCls } = pct(row.chg24);
    const liq = fmtMoney(row.liqUsd);
    const vol = typeof row.vol24 === 'string' ? row.vol24 : fmtMoney(row.vol24);
    const metricVal = Number.isFinite(Number(row.metric)) ? Number(row.metric) : (Number(row.score) || Number(row.smq) || null);
    const metricHtml = metricVal !== null ? `<span class="pill"><span class="k">${metricLabel}</span><b class="highlight">${metricVal}</b></span>` : '';
    const mintKey = row.mint || row.symbol || String(i);
    const chgSeries = getItemChangeSeries(mintKey);
    const seriesForDraw = chgSeries.length > 1 ? chgSeries : [0, 0]; // stable baseline
    const sparkHtml = `<div class="micro" data-micro data-key="${mintKey}">${sparklineSVG(seriesForDraw, { w: 72, h: 20 })}</div>`;

    return `
      <li class="addon-item">
        <a href="https://fdv.lol/token/${row.mint}" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:12px;">
          <div class="addon-avatar">
            <div class="addon-rank r${i+1}">${i+1}</div>
            <img class="addon-logo" src="${logo}" data-sym="${sym}" alt="" loading="lazy" decoding="async">
          </div>

          <div class="addon-main" style="min-width:0;flex:1 1 auto;">
            <div class="addon-line1" style="display:flex;align-items:center;gap:8px;min-width:0;">
              <div class="addon-sym" style="font-weight:700;">${sym || '—'}</div>
              <div class="addon-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${name || ''}</div>
            </div>
            <div class="addon-line2" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;opacity:.95;">
              <span class="pill"><span class="k">Price</span><b>${price}</b></span>
              <span class="pill"><span class="k">24h</span><b class="${chCls}">${chTxt}</b></span>
              <span class="pill"><span class="k">Liq</span><b>${liq}</b></span>
              <span class="pill"><span class="k">Vol</span><b>${vol}</b></span>
              ${metricHtml}
            </div>
            <div class="mint-data">
              <code style="font-size:7px;">${row.mint}</code>
            </div>
          </div>

          <div class="addon-right" style="margin-left:auto;flex:0 0 110px;display:flex;align-items:center;justify-content:flex-end;">
            ${sparkHtml}
          </div>
        </a>
      </li>
    `;
  }).join('');
}

export function registerAddon(addon) {
  if (!addon || !addon.id) return;
  if (REGISTRY.find(a => a.id === addon.id)) return;
  REGISTRY.push({ ...addon });
  REGISTRY.sort((a,b)=> (a.order||0) - (b.order||0));
}

export function ensureAddonsUI() {
  for (const a of REGISTRY) {
    try { ensureAddonUI(a); } catch {}
  }
}

export function runAddonsTick() {
  for (const a of REGISTRY) {
    try { renderAddon(a); } catch {}
  }
}

export function setAddonData(id, data) {
  if (!id || !data) return;
  const prev = STATE.get(id) || {};
  const nextItems = Array.isArray(data.items) ? data.items : prev.items || [];
  for (const row of nextItems) {
    const mint = row?.mint || row?.symbol;
    const p = Number(row?.priceUsd);
    if (mint && Number.isFinite(p) && p > 0) {
      updateItemHistory(mint, p);
    }
  }

  const next = {
    ...prev,
    items: nextItems,
    title: data.title || prev.title,
    subtitle: data.subtitle || prev.subtitle,
    metricLabel: data.metricLabel || prev.metricLabel,
    notify: data.notify ?? null,
    notifyToken: data.notify ? (data.notifyToken ?? Date.now()) : null,
    ts: Date.now(),
  };
  STATE.set(id, next);

  const addon = REGISTRY.find(a => a.id === id);
  if (addon) {
    try { renderAddon(addon); } catch {}
  }
}

export function runTheAddonsTick() {
  runAddonsTick();
}

