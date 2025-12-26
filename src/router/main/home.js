import { pipeline, stopPipelineStream } from '../../engine/pipeline.js';
import { renderProfileView } from "../../vista/profile/page.js";
import { renderHomeView } from '../../vista/meme/page.js';
import { renderShillContestView } from "../../vista/shill/page.js"; 
import { renderShillLeaderboardView } from "../../vista/shill/leaderboard.js"; 
import { hideLoading } from '../../core/tools.js';

let HOME_INTERVAL = null;

let _pendingUpdate = null;
let _updateQueued = false;

const _lastView = { key: null, ts: 0 };
function dedupeView(key, { force = false, windowMs = 300 } = {}) {
  if (force) {
    _lastView.key = key;
    _lastView.ts = Date.now();
    return false;
  }
  const now = Date.now();
  if (_lastView.key === key && (now - _lastView.ts) < windowMs) return true;
  _lastView.key = key;
  _lastView.ts = now;
  return false;
}
const STREAM_KEY = 'fdv.stream.on';
function loadStreamPref() {
  try {
    const v = localStorage.getItem(STREAM_KEY);
    return v === null ? true : (v === '1' || v === 'true'); // default ON
  } catch { return true; }
}
function saveStreamPref(on) {
  try { localStorage.setItem(STREAM_KEY, on ? '1' : '0'); } catch {}
}

let STREAM_ON = loadStreamPref();

function updateStreamButton() {
  const btn = document.getElementById('stream');
  if (!btn) return;
  btn.textContent = STREAM_ON ? 'Stream: On' : 'Stream: Off';
  btn.setAttribute('aria-pressed', STREAM_ON ? 'true' : 'false'); 
}
function wireStreamButton() {
  const btn = document.getElementById('stream');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => toggleStreaming());
  updateStreamButton();
}

const streamBus = new EventTarget();
function emitStreamState() {
  try { streamBus.dispatchEvent(new CustomEvent('stream-state', { detail: { on: STREAM_ON } })); } catch {}
}
export function isStreaming() { return STREAM_ON; }
export function onStreamStateChange(handler) {
  const fn = (e) => { try { handler(!!e.detail?.on); } catch {} };
  streamBus.addEventListener('stream-state', fn);
  return () => streamBus.removeEventListener('stream-state', fn);
}

export function stopHomeLoop() {
  if (HOME_INTERVAL) { clearInterval(HOME_INTERVAL); HOME_INTERVAL = null; }
}
export function startHomeLoop(intervalMs = 10_000) {
  stopHomeLoop();
  HOME_INTERVAL = setInterval(() => { runHome({ force: false }).catch(console.warn); }, intervalMs);
}

export function setStreaming(on, { restart = true, skipInitial = false, startLoop = true } = {}) {
  const next = !!on;
  if (STREAM_ON === next && !restart) return;
  STREAM_ON = next;
  saveStreamPref(STREAM_ON);
  updateStreamButton();

  stopPipelineStream();
  stopHomeLoop();

  if (STREAM_ON) {
    if (!skipInitial) {
      runHome({ force: true }).catch(console.warn);
    }
    if (startLoop) startHomeLoop();
  }
  emitStreamState();
}
export function toggleStreaming() { setStreaming(!STREAM_ON); }

function enqueueRender(payload) {
  _pendingUpdate = payload;
  if (_updateQueued) return;
  _updateQueued = true;
  queueMicrotask(() => {
    _updateQueued = false;
    const p = _pendingUpdate;
    _pendingUpdate = null;
    if (!p || !Array.isArray(p.items) || !p.items.length) return;
    renderHomeView(p.items, p.ad || null, p.marquee || { trending: [], new: [] });
  });
}

async function runHome({ force = false } = {}) {
  const pipe = await pipeline({
    force,
    stream: STREAM_ON,
    onUpdate: ({ items, ad, marquee }) => {
      if (Array.isArray(items) && items.length) {
        enqueueRender({ items, ad, marquee });
      }
    }
  });
  if (pipe && Array.isArray(pipe.items) && pipe.items.length) {
    enqueueRender({ items: pipe.items, ad: pipe.ad, marquee: pipe.marquee });
  }
}
export async function showHome({ force = false } = {}) {
  if (dedupeView('home', { force })) return;
  wireStreamButton();

  let initial;
  if (isStreaming()) {
    initial = runHome({ force }).catch(console.warn);
    await initial;
    startHomeLoop();
  } else {
    setStreaming(true, { skipInitial: true, startLoop: false });
    initial = runHome({ force: true }).catch(console.warn);
    await initial;
    startHomeLoop();
  }
  hideLoading();
}

export async function showProfile({ mint, force = false } = {}) {
  if (dedupeView(`profile:${mint || ''}`, { force })) return;
  try {
    await renderProfileView(mint);
  } finally {
    hideLoading();
  }
}

export async function showShill({ mint, leaderboard = false, force = false } = {}) {
  if (dedupeView(`shill:${leaderboard ? 'lb' : 'contest'}:${mint || ''}`, { force })) return;
  try {
    if (leaderboard) {
      await renderShillLeaderboardView({ mint });
    } else {
      await renderShillContestView(mint);
    }
  } finally {
    hideLoading();
  }
}