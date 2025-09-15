import { pipeline } from '../engine/pipeline.js';
import { renderProfileView } from "../views/profile/page.js";
import { render } from '../views/meme/page.js';
import { hideLoading } from '../utils/tools.js';

let HOME_INTERVAL = null;
let STREAM_ON = true;   
let WIRED = false;

let $streamBtn = null;

function syncHeaderButtons() {
  if ($streamBtn) {
    $streamBtn.setAttribute('aria-pressed', String(STREAM_ON));
    $streamBtn.textContent = STREAM_ON ? 'Stream: On' : 'Stream: Off';
  }
}

function wireHeaderControls() {
  if (WIRED && $streamBtn) return;
  $streamBtn = document.getElementById('stream');

  if (!$streamBtn) {
    if (!WIRED) {
      document.addEventListener('DOMContentLoaded', () => {
        WIRED = false;
        wireHeaderControls();
      }, { once: true });
    }
    return;
  }

  if (!WIRED) {
    WIRED = true;
    $streamBtn.addEventListener('click', () => {
      STREAM_ON = !STREAM_ON;
      syncHeaderButtons();
      runHome({ force: true }).catch(console.warn);
    });
  }

  syncHeaderButtons();
}

async function runHome({ force = false } = {}) {
  const pipe = await pipeline({
    force,
    stream: STREAM_ON,
    onUpdate: ({ items, ad, marquee }) => {
      render(items || [], ad || null, marquee || { trending: [], new: [] });
    }
  });

  const payload = pipe && typeof pipe === 'object'
    ? pipe
    : { items: [], ad: null, marquee: { trending: [], new: [] } };

  render(payload.items, payload.ad, payload.marquee);
}

export async function showHome({ force = false } = {}) {
  hideLoading();
  wireHeaderControls();
  if (HOME_INTERVAL) { clearInterval(HOME_INTERVAL); HOME_INTERVAL = null; }
  runHome({ force }).catch(console.warn);
  HOME_INTERVAL = setInterval(() => {
    runHome({ force: false }).catch(console.warn);
  }, 10_000);
}

export async function showProfile({ mint }) {
  try {
    renderProfileView(mint);
  } finally {
    hideLoading();
  }
}
