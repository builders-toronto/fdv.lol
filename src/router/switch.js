import { showHome, showProfile, showShill } from "./main/home.js";
import { showLoading } from "../core/tools.js";
import { BASE_PATH, appPath, stripBase } from "../config/base.js";

let __fdvSwapLoaderPromise = null;
function __parseJsonAttr__(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return null; }
}

function __collectSwapClickData__(el) {
  const card = el?.closest?.('.card');
  const dBtn = el?.dataset || {};
  const dCard = card?.dataset || {};

  const mint = dBtn.mint || dCard.mint || null;
  const pairUrl = dBtn.pairUrl || dCard.pairUrl || null;

  const optsBtn = __parseJsonAttr__(dBtn.swapOpts);
  const optsCard = __parseJsonAttr__(dCard.swapOpts);
  const opts = { ...(optsCard || {}), ...(optsBtn || {}) };

  const hydrateBtn = __parseJsonAttr__(dBtn.tokenHydrate);
  const hydrateCard = __parseJsonAttr__(dCard.tokenHydrate);
  const tokenHydrate = { ...(hydrateCard || {}), ...(hydrateBtn || {}) };

  const priority = opts.priority ?? (dBtn.priority === '1' || dCard.priority === '1');
  const relay = opts.relay ?? dBtn.relay ?? dCard.relay;
  const timeoutMs = opts.timeoutMs ?? Number(dBtn.timeoutMs || dCard.timeoutMs);

  return { mint, pairUrl, tokenHydrate, priority, relay, timeoutMs };
}

async function __ensureSwapSystem__() {
  if (__fdvSwapLoaderPromise) return __fdvSwapLoaderPromise;
  __fdvSwapLoaderPromise = (async () => {
    const mod = await import("../vista/addons/auto/swap/index.js");
    try { mod.initSwapSystem?.(); } catch {}
    try { window.__fdvSwapSystemReady = true; } catch {}
    return mod;
  })();
  return __fdvSwapLoaderPromise;
}

function initRouter({
  onHome = () => {},
  onProfile = () => {},
  onShill = () => {},
  onNotFound       
} = {}) {
  const notFound = onNotFound || onHome;

  const routes = [
    { pattern: /^\/$/, handler: onHome },
    { pattern: /^\/leaderboard\/([1-9A-HJ-NP-Za-km-z]{32,44})\/?$/, handler: (mint) => onShill({ mint, leaderboard: true }) },
    { pattern: /^\/shill\/?$/, handler: () => {
      const mint = new URLSearchParams(location.search).get("mint") || "";
      onShill({ mint });
    }},
    { pattern: /^\/shill\/([1-9A-HJ-NP-Za-km-z]{32,44})\/?$/, handler: (mint) => onShill({ mint }) },
    { pattern: /^\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})\/?$/, handler: (mint) => onProfile({ mint }) },
  ];

  function match(path) {
    for (const r of routes) {
      const m = path.match(r.pattern);
      if (m) return () => r.handler(...m.slice(1));
    }
    return () => notFound();
  }

  function dispatch({ withLoading = false, defer = false } = {}) {
    const run = () => {
      let path = stripBase(location.pathname);
      const handle = match(path);
      handle();
    };

    if (withLoading) {
      try { showLoading(); } catch {}
    }
    if (defer) nextPaint(run);
    else run();
  }

  function nextPaint(fn) {
    try {
      // Ensure the loader overlay has a chance to paint.
      requestAnimationFrame(() => { try { fn(); } catch {} });
    } catch {
      setTimeout(() => { try { fn(); } catch {} }, 0);
    }
  }

  function nav(url, { push = true, replace = false } = {}) {
    // A leading-slash href is an app route, not an origin path — re-anchor it on
    // the mount point so "/token/x" lands on "/fdv.lol/token/x".
    const raw = String(url ?? '');
    const target = new URL(
      raw.startsWith('/') && !raw.startsWith(BASE_PATH) ? appPath(raw) : raw,
      location.origin
    );
    const href = target.pathname + target.search + target.hash;
    if (replace) history.replaceState({}, '', href);
    else if (push) history.pushState({}, '', href);
    dispatch({ withLoading: true, defer: true });
  }

  function shouldIgnoreClick(e, a) {
    return (
      e.defaultPrevented ||
      e.button !== 0 ||                // only left-click
      e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || // let new-tab etc. work
      a.target === '_blank' ||
      a.hasAttribute('download') ||
      a.getAttribute('rel') === 'external' ||
      a.origin !== location.origin
    );
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (!a) return;
    if (shouldIgnoreClick(e, a)) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    nav(href);
  });

  document.addEventListener('pointerover', (e) => {
    const el = e.target?.closest?.('[data-swap-btn], .swapCoin');
    if (!el) return;
    if (window.__fdvSwapSystemReady) return;
    __ensureSwapSystem__().catch(() => {});
  }, { capture: true, passive: true });

  document.addEventListener('click', (e) => {
    const el = e.target?.closest?.('[data-swap-btn], .swapCoin');
    if (!el) return;
    if (window.__fdvSwapSystemReady) return;

    try { e.preventDefault(); } catch {}
    try { e.stopImmediatePropagation(); } catch {}

    const data = __collectSwapClickData__(el);
    if (!data?.mint) return;

    __ensureSwapSystem__()
      .then((mod) => {
        try {
          // openSwapModal is exported; this avoids relying on the internal click handler.
          mod.openSwapModal?.({
            outputMint: data.mint,
            tokenHydrate: data.tokenHydrate,
            pairUrl: data.pairUrl,
            priority: data.priority,
            relay: data.relay,
            timeoutMs: data.timeoutMs,
          });
        } catch {}
      })
      .catch(() => {});
  }, { capture: true });

  window.addEventListener('popstate', () => {
    dispatch({ withLoading: true, defer: true });
  });

  // Deep links arrive via 404.html, which hands the route over in sessionStorage
  // and, as a fallback for when that's unavailable, on the hash.
  let pending = null;
  try {
    pending = sessionStorage.getItem('spa:path');
    if (pending) sessionStorage.removeItem('spa:path');
  } catch {}
  if (pending) {
    history.replaceState({}, '', pending);
  } else if (location.hash.startsWith('#/')) {
    history.replaceState({}, '', appPath(location.hash.slice(1)));
  }
  // No auto-dispatch here; the entrypoint (main.js) calls router.dispatch().

  return {
    nav,
    dispatch: (opts) => dispatch(opts),
    replace: (u) => nav(u, { replace: true }),
  };
}

export const router = initRouter({
    onHome: () => {
        document.title = 'FDV.lol';
        showHome();
    },
    onProfile: ({ mint }) => {
        document.title = `${mint.slice(0, 6)}… • FDV.lol`;
        showProfile({ mint });
    },
    onShill: ({ mint, leaderboard } = {}) => {
        document.title = leaderboard
          ? `Leaderboard ${mint.slice(0, 6)}… • FDV.lol`
          : `Shill ${mint.slice(0, 6)}… • FDV.lol`;
        showShill({ mint, leaderboard });
    },
    onNotFound: () => {
        document.title = '404 Not Found • FDV.lol';
        showHome();
    }
});