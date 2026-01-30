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

const HOME_COLLAPSE_KEY = 'fdv.home.collapsed';

function setRoute(route) {
  try { document.body.dataset.route = route; } catch {}
}

function loadHomeCollapsed() {
  try {
    const v = localStorage.getItem(HOME_COLLAPSE_KEY);
    return v === '1' || v === 'true';
  } catch { return false; }
}

function saveHomeCollapsed(collapsed) {
  try { localStorage.setItem(HOME_COLLAPSE_KEY, collapsed ? '1' : '0'); } catch {}
}

function setHomeCollapsedUI(collapsed) {
  try { document.body.dataset.homeCollapsed = collapsed ? '1' : '0'; } catch {}
  const btn = document.getElementById('homeExit');
  if (btn) {
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    btn.setAttribute('aria-label', collapsed ? 'Reopen feed' : 'Collapse feed');
    btn.dataset.state = collapsed ? 'collapsed' : 'open';
  }
  const notice = document.getElementById('homeCollapsedNotice');
  if (notice) notice.hidden = !collapsed;
}

function wireHomeExitButton({ visible }) {
  const btn = document.getElementById('homeExit');
  const cards = document.getElementById('cards');
  if (!btn || !cards) return;

  btn.hidden = !visible;
  if (!visible) return;

  if (!btn.dataset.wired) {
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      const reduceMotion = !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      const collapsed = (document.body?.dataset?.homeCollapsed === '1');
      const next = !collapsed;
      saveHomeCollapsed(next);

      btn.classList.remove('is-clicked');
      // restart click animation
      void btn.offsetWidth;
      btn.classList.add('is-clicked');
      btn.addEventListener('animationend', () => btn.classList.remove('is-clicked'), { once: true });

      if (reduceMotion) {
        setHomeCollapsedUI(next);
        return;
      }

      if (next) {
        // Closing: animate, then commit collapsed state.
        cards.classList.remove('fdv-opening');
        cards.classList.add('fdv-closing');
        cards.addEventListener('animationend', () => {
          cards.classList.remove('fdv-closing');
          setHomeCollapsedUI(true);
        }, { once: true });
      } else {
        // Opening: clear collapsed state first so layout exists, then animate in.
        setHomeCollapsedUI(false);
        cards.classList.remove('fdv-closing');
        cards.classList.add('fdv-opening');
        cards.addEventListener('animationend', () => cards.classList.remove('fdv-opening'), { once: true });
      }
    });
  }

  // Apply persisted state on entry to home.
  setHomeCollapsedUI(loadHomeCollapsed());
}

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
  setRoute('home');
  if (dedupeView('home', { force })) return;
  wireHomeExitButton({ visible: true });
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
  setRoute('profile');
  wireHomeExitButton({ visible: false });
  if (dedupeView(`profile:${mint || ''}`, { force })) return;
  try {
    await renderProfileView(mint);
  } finally {
    hideLoading();
  }
}

export async function showShill({ mint, leaderboard = false, force = false } = {}) {
  setRoute('shill');
  wireHomeExitButton({ visible: false });
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