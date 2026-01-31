import { getTokenLogoPlaceholder, queueTokenLogoLoad } from '../../../core/ipfs.js';
import { sparklineSVG } from '../render/sparkline.js';

const REGISTRY = [];
const STATE = new Map(); 
const ITEM_HISTORY = new Map();

const MINT_LABELS = new Map();

const KPI_PREFS_KEY = 'fdv_kpi_prefs_v1';
let KPI_PREFS_CACHE = null;

function loadKpiPrefs() {
  if (KPI_PREFS_CACHE) return KPI_PREFS_CACHE;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KPI_PREFS_KEY) : null;
    const obj = raw ? JSON.parse(raw) : {};
    KPI_PREFS_CACHE = (obj && typeof obj === 'object') ? obj : {};
  } catch {
    KPI_PREFS_CACHE = {};
  }
  return KPI_PREFS_CACHE;
}

function saveKpiPrefs(prefs) {
  KPI_PREFS_CACHE = prefs && typeof prefs === 'object' ? prefs : {};
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(KPI_PREFS_KEY, JSON.stringify(KPI_PREFS_CACHE));
    }
  } catch {}
}

function getAddonPref(addonId, key, fallback) {
  const prefs = loadKpiPrefs();
  const rec = prefs?.[addonId];
  if (!rec || typeof rec !== 'object') return fallback;
  return (key in rec) ? rec[key] : fallback;
}

function setAddonPref(addonId, key, val) {
  const prefs = { ...loadKpiPrefs() };
  const rec = (prefs[addonId] && typeof prefs[addonId] === 'object') ? { ...prefs[addonId] } : {};
  rec[key] = val;
  prefs[addonId] = rec;
  saveKpiPrefs(prefs);
}

function getHideRisky(addonId) {
  return Boolean(getAddonPref(addonId, 'hideRisky', false));
}

function setHideRisky(addonId, on) {
  setAddonPref(addonId, 'hideRisky', Boolean(on));
}

function normMint(m) {
  return String(m || '').trim();
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeLabelInput(v) {
  if (!v) return null;
  if (typeof v === 'string') return { text: v };
  if (typeof v === 'object') {
    const text = String(v.text ?? v.label ?? v.name ?? '').trim();
    if (!text) return null;
    return {
      text,
      cls: String(v.cls ?? v.className ?? v.level ?? '').trim(),
      ttlMs: Number(v.ttlMs ?? v.ttl ?? 0) || 0,
      kind: String(v.kind ?? '').trim(),
    };
  }
  return null;
}

function getMintLabels(mint) {
  const m = normMint(mint);
  if (!m) return [];
  const rec = MINT_LABELS.get(m);
  const arr = Array.isArray(rec?.labels) ? rec.labels : [];
  if (!arr.length) return [];

  const now = Date.now();
  const kept = arr.filter((x) => {
    const until = Number(x?.until || 0);
    return !(until > 0) || now <= until;
  });
  if (kept.length !== arr.length) {
    if (kept.length) MINT_LABELS.set(m, { labels: kept });
    else MINT_LABELS.delete(m);
  }
  return kept;
}

export function addMintLabel(mint, label, { ttlMs = 15 * 60 * 1000, cls = 'warn', kind = '' } = {}) {
  const m = normMint(mint);
  if (!m) return false;
  const li = normalizeLabelInput(label);
  if (!li?.text) return false;

  const text = String(li.text).trim();
  const labelCls = String(li.cls || cls || '').trim();
  const ms = Number(li.ttlMs || ttlMs || 0);
  const until = ms > 0 ? (Date.now() + Math.max(5_000, ms)) : 0;
  const k = String(li.kind || kind || '').trim();

  const prev = MINT_LABELS.get(m);
  const labels = Array.isArray(prev?.labels) ? prev.labels.slice() : [];
  const dup = labels.find((x) => String(x?.text || '').trim().toLowerCase() === text.toLowerCase());
  if (dup) {
    dup.until = Math.max(Number(dup.until || 0), until);
    if (labelCls) dup.cls = labelCls;
    if (k) dup.kind = k;
  } else {
    labels.push({ text, cls: labelCls, kind: k, until });
  }

  // Cap to keep UI tidy.
  const capped = labels.slice(0, 6);
  MINT_LABELS.set(m, { labels: capped });
  try { runAddonsTick(); } catch {}
  return true;
}

export function clearMintLabels(mint) {
  const m = normMint(mint);
  if (!m) return;
  MINT_LABELS.delete(m);
  try { runAddonsTick(); } catch {}
}

function buildLabelPillsHtml(row) {
  try {
    const rowMint = row?.mint;
    const mintLabels = getMintLabels(rowMint);

    const rowLabels = (() => {
      const src = row?.labels ?? row?.pills ?? row?.tags;
      if (!src) return [];
      const arr = Array.isArray(src) ? src : [src];
      return arr.map(normalizeLabelInput).filter(Boolean);
    })();

    const merged = [];
    for (const l of rowLabels) {
      merged.push({ text: String(l.text || '').trim(), cls: String(l.cls || '').trim() });
    }
    for (const l of mintLabels) {
      merged.push({ text: String(l.text || '').trim(), cls: String(l.cls || '').trim() });
    }

    const uniq = [];
    const seen = new Set();
    for (const l of merged) {
      const t = String(l.text || '').trim();
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(l);
      if (uniq.length >= 3) break; // keep KPI rows compact
    }
    if (!uniq.length) return '';

    const txt = uniq.map((l) => escapeHtml(l.text)).join(' · ');
    return `<span class="pill pill--labels"><span class="k"></span><b class="highlight">${txt}</b></span>`;
  } catch {
    return '';
  }
}

function isRiskyLabelText(text) {
  const s = String(text || '').trim().toLowerCase();
  if (!s) return false;
  return (
    s.includes('honeypot') ||
    s.includes('token-2022') ||
    s.includes('token2022') ||
    s.includes('freeze') ||
    s.includes('blacklist') ||
    s.includes('blacklisted') ||
    s.includes('scam') ||
    s.includes('rug') ||
    s.includes('risky')
  );
}

function rowLooksRisky(row) {
  try {
    if (!row || typeof row !== 'object') return false;
    if (row.risky === true || row.honeypot === true) return true;

    const rowLabelSrc = row?.labels ?? row?.pills ?? row?.tags;
    const rowLabelArr = Array.isArray(rowLabelSrc) ? rowLabelSrc : (rowLabelSrc ? [rowLabelSrc] : []);
    const rowLabels = rowLabelArr.map(normalizeLabelInput).filter(Boolean);

    const mintLabels = getMintLabels(row?.mint);
    const all = [...rowLabels, ...mintLabels];
    for (const l of all) {
      const t = String(l?.text || '').trim();
      if (isRiskyLabelText(t)) return true;
    }

    const riskTextCandidates = [row?.risk, row?.riskLevel, row?.riskLabel, row?.warning, row?.reason];
    for (const v of riskTextCandidates) {
      if (isRiskyLabelText(v)) return true;
    }
  } catch {}
  return false;
}

const SPARK_LENGTH = 24;
const SPARK_MIN_INTERVAL_MS = 1500;

// Default green zig-zag percent-change series for initial render
function makeDefaultZig(n = SPARK_LENGTH) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const trend = i * 0.35;           // gentle upward trend (~8% over 24pts)
    const zig = (i % 2 === 0) ? 0.6 : -0.2; // zig-zag oscillation
    out.push(trend + zig);
  }
  const base = out[0] || 0;
  return out.map(v => Number((v - base).toFixed(2))); // start at 0%
}

// Deterministic synthetic spark when _chg/history are missing
function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0; // LCG
    return (s & 0xfffffff) / 0x10000000;
  };
}
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function makeSyntheticSpark(row, n = SPARK_LENGTH) {
  const mintKey = String(row?.mint || row?.symbol || 'x');
  const rnd = seededRng(hashStr(mintKey));

  const chg24 = Number.isFinite(Number(row?.chg24)) ? Number(row.chg24) : 0;
  const vol = Number(row?.vol24);
  const liq = Number(row?.liqUsd);

  // Target 24h change (cap extremes)
  const target = clamp(chg24, -80, 200);

  // Wiggle amplitude scaled by |target| and vol/liquidity “energy”
  const volFactor = Number.isFinite(vol) ? Math.log10(Math.max(1, vol)) : 0;
  const liqFactor = Number.isFinite(liq) ? Math.log10(Math.max(1, liq)) : 0;
  const energy = clamp((volFactor - 0.6) - (liqFactor - 0.6), -0.5, 1.5); // higher vol vs liq => more wiggle
  const wiggleAmp = 0.4 + Math.min(1.6, Math.sqrt(Math.abs(target)) / 7 + energy * 0.6);

  const arr = [];
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 1;
    const drift = target * easeInOutCubic(t);     // smooth path toward target
    const noise = (rnd() * 2 - 1) * wiggleAmp;    // small wiggle
    const midBias = (t - 0.5) * target * 0.06;    // slight mid pivot
    arr.push(drift + noise + midBias);
  }

  const base = arr[0] || 0;
  return arr.map(v => Number((v - base).toFixed(2))); // start at 0%
}

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
  const footId = `${addon.id}Foot`;
  const hideRiskyId = `${addon.id}HideRisky`;

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
      <div class="addon-foot" id="${footId}">
        <label class="addon-risk-toggle" title="Hide risky mints for this KPI panel">
          <input type="checkbox" id="${hideRiskyId}" />
          <span>Hide risky</span>
        </label>
      </div>
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

  const hideRiskyEl = document.getElementById(hideRiskyId);
  if (hideRiskyEl) {
    hideRiskyEl.checked = getHideRisky(addon.id);
    if (!hideRiskyEl.dataset.wired) {
      hideRiskyEl.dataset.wired = '1';
      hideRiskyEl.addEventListener('change', () => {
        setHideRisky(addon.id, hideRiskyEl.checked);
        try { renderAddon(addon); } catch {}
      });
    }
  }

  return { wrap, panel, listEl: document.getElementById(listId), labelEl: document.getElementById(labelId), toggleEl: document.getElementById(toggleId), hideRiskyEl };
}

function getItemChangeSeries(mint) {
  const rec = ITEM_HISTORY.get(mint);
  return Array.isArray(rec?.chg) ? rec.chg : [];
}

function renderAddon(addon) {
  const ui = ensureAddonUI(addon);
  if (!ui) return;

  const st = STATE.get(addon.id) || {};
  const rawItems = Array.isArray(st.items) ? st.items : [];
  const hideRisky = getHideRisky(addon.id);
  const filtered = hideRisky ? rawItems.filter((row) => !rowLooksRisky(row)) : rawItems;
  const items = filtered.slice(0, addon.limit || DEFAULT_LIMIT);
  const metricLabel = st.metricLabel || addon.metricLabel || 'Score';

  if (ui.hideRiskyEl) ui.hideRiskyEl.checked = hideRisky;

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
    if (hideRisky && rawItems.length) {
      ui.listEl.innerHTML = `
        <li class="addon-item">
          <div class="quick-spinner-wrap" style="padding:12px;">
            <div class="quick-loading-msg">All items are filtered as risky.</div>
          </div>
        </li>`;
      return;
    }
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
    const rawLogo = String(row.imageUrl || row.logoURI || '');
    const sym = String(row.symbol || row.name || '');
    const logo = getTokenLogoPlaceholder(rawLogo, sym);
    const name = row.name || '';
    const price = fmtPrice(row.priceUsd);
    const { txt: chTxt, cls: chCls } = pct(row.chg24);
    const liq = fmtMoney(row.liqUsd);   
    const vol = typeof row.vol24 === 'string' ? row.vol24 : fmtMoney(row.vol24);
    const metricVal = Number.isFinite(Number(row.metric)) ? Number(row.metric) : (Number(row.score) || Number(row.smq) || null);
    const metricHtml = metricVal !== null ? `<span class="pill"><span class="k">${metricLabel}</span><b class="highlight">${metricVal}</b></span>` : '';
    const mintKey = row.mint || row.symbol || String(i);

    const labelsHtml = buildLabelPillsHtml(row);

    // Prefer inline _chg for initial render, fallback to history; else synthesize from data.
    const inlineChg = Array.isArray(row._chg) ? row._chg : [];
    const chgSeries = getItemChangeSeries(mintKey);
    const hasInline = inlineChg.length > 1;
    const hasHist = chgSeries.length > 1;

    let seriesForDraw;
    if (hasInline && !hasHist) {
      seriesForDraw = inlineChg;
    } else if (hasHist) {
      seriesForDraw = chgSeries;
    } else {
      seriesForDraw = makeSyntheticSpark(row, SPARK_LENGTH);
    }

    const sparkHtml = `<div class="micro" data-micro data-key="${mintKey}">${sparklineSVG(seriesForDraw, { w: 72, h: 20 })}</div>`;

    const holdBtnHtml = row?.mint
      ? `
        <div class="addon-hold-wrap">
          <button
            type="button"
            class="btn holdCoin addon-hold-btn"
            data-hold-btn
            data-mint="${row.mint}"
            title="Open Hold bot for this mint"
          >Hold</button>
        </div>
      `
      : '';

    return `
      <li class="addon-item">
        <a href="https://fdv.lol/token/${row.mint}" target="_blank" rel="noopener">
          ${holdBtnHtml}
          <div class="addon-avatar">
            <div class="addon-rank r${i+1}">${i+1}</div>
            <img class="addon-logo" src="${logo}" data-logo-raw="${rawLogo}" data-sym="${sym}" alt="" loading="lazy" decoding="async">
          </div>

          <div class="addon-main">
            <div class="addon-line1">
              <div class="addon-sym">${sym || '—'}</div>
              <div class="addon-name">${name || ''}</div>
            </div>
            <div class="addon-line2">
              <span class="pill"><span class="k">Price</span><b>${price}</b></span>
              <span class="pill"><span class="k">24h</span><b class="${chCls}">${chTxt}</b></span>
              <span class="pill"><span class="k">Liq</span><b>${liq}</b></span>
              <span class="pill"><span class="k">Vol</span><b>${vol}</b></span>
              ${labelsHtml}
              ${metricHtml}
            </div>
            <div class="mint-data">
              <code style="font-size:7px;">${row.mint}</code>
            </div>
          </div>

          <div class="addon-right">
            <div style="display:flex; align-items:center; justify-content:flex-end; gap:8px;">
              ${sparkHtml}
            </div>
          </div>
        </a>
      </li>
    `;
  }).join('');

  try {
    const imgs = ui.listEl.querySelectorAll('img[data-logo-raw]');
    imgs.forEach((img) => {
      const raw = img.getAttribute('data-logo-raw') || '';
      const sym = img.getAttribute('data-sym') || '';
      queueTokenLogoLoad(img, raw, sym);
    });
  } catch {}
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

try {
  if (typeof window !== 'undefined') {
    window.fdvKpiLabelMint = (mint, label, opts) => addMintLabel(mint, label, opts);
    window.fdvKpiClearMintLabels = (mint) => clearMintLabels(mint);
  }
} catch {}

