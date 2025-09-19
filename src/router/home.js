import { pipeline, stopPipelineStream } from '../engine/pipeline.js';
import { renderProfileView } from "../views/profile/page.js";
import { render } from '../views/meme/page.js';
import { hideLoading } from '../utils/tools.js';

let HOME_INTERVAL = null;

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
  btn.setAttribute('aria-pressed', STREAM_ON ? 'true' : 'false'); // overwrite hardcoded value(BLOAT: fix this)
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

// Loop control
export function stopHomeLoop() {
  if (HOME_INTERVAL) { clearInterval(HOME_INTERVAL); HOME_INTERVAL = null; }
}
export function startHomeLoop(intervalMs = 10_000) {
  stopHomeLoop();
  HOME_INTERVAL = setInterval(() => { runHome({ force: false }).catch(console.warn); }, intervalMs);
}

// Stream state
export function setStreaming(on, { restart = true } = {}) {
  const next = !!on;
  if (STREAM_ON === next && !restart) return;
  STREAM_ON = next;
  saveStreamPref(STREAM_ON);
  updateStreamButton();

  stopPipelineStream();
  stopHomeLoop();

  if (STREAM_ON) {
    runHome({ force: true }).catch(console.warn);
    startHomeLoop();
  }
  emitStreamState();
}
export function toggleStreaming() { setStreaming(!STREAM_ON); }

async function runHome({ force = false } = {}) {
  const pipe = await pipeline({
    force,
    stream: STREAM_ON,
    onUpdate: ({ items, ad, marquee }) => {
      if (Array.isArray(items) && items.length) {
        render(items, ad || null, marquee || { trending: [], new: [] });
      }
    }
  });
  if (pipe && Array.isArray(pipe.items) && pipe.items.length) {
    render(pipe.items, pipe.ad || null, pipe.marquee || { trending: [], new: [] });
  }
}

export async function showHome({ force = false } = {}) {
  hideLoading();
  wireStreamButton();          // wire once
  setStreaming(true);          // default ON on arrival
  runHome({ force }).catch(console.warn);
}

export async function showProfile({ mint }) {
  try { renderProfileView(mint); } finally { hideLoading(); }
}
