import { initSwap, bindSwapButtons } from "../widgets/swap.js";

function initSwapSystem() {
  initSwap({
    feeReceiverWallet: "ENEKo7GEWM6jDTaHfN558bNHPodA9MB5azNiFvTK7ofm",
    feeAtas: {
      "So11111111111111111111111111111111111111112": "4FSwzXe544mW2BLYqAAjcyBmFFHYgMbnA1XUdtGUeST8", //WRAPPED SOL
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "BKWwTmwc7FDSRb82n5o76bycH3rKZ4Xqt87EjZ2rnUXB", //USDC
    },

    jupiterBase: "https://lite-api.jup.ag",
    rpcUrl: "https://solana-rpc-proxy.fdvlol.workers.dev/", 

    platformFeeBps: 5,         // 0.05% don't go over this, people dont like that!
    defaultSlippageBps: 50,     

    tokenDecimals: {
      "So11111111111111111111111111111111111111112": 9, // SOL
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": 6, // USDC
    },
  });

  bindSwapButtons(document);
}

export function initRouter({
  onHome = () => {},
  onProfile = () => {},
  onNotFound       
} = {}) {
  const notFound = onNotFound || onHome;

  const base = (document.querySelector('base')?.getAttribute('href') || '/').replace(/\/+$/, '/') ;
  const stripBase = (p) => (p.startsWith(base) ? '/' + p.slice(base.length) : p).replace(/\/index\.html$/, '/');

  const routes = [
    { pattern: /^\/$/, handler: onHome },
    { pattern: /^\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})\/?$/, handler: (mint) => onProfile({ mint }) },
  ];

  function match(path) {
    for (const r of routes) {
      const m = path.match(r.pattern);
      if (m) return () => r.handler(...m.slice(1));
    }
    return () => notFound();
  }

  function dispatch() {
    let path = stripBase(location.pathname);
    const handle = match(path);
    handle();
  }

  function nav(url, { push = true, replace = false } = {}) {
    const target = new URL(url, location.origin);
    const href = target.pathname + target.search + target.hash;
    if (replace) history.replaceState({}, '', href);
    else if (push) history.pushState({}, '', href);
    dispatch();
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
    nav(a.getAttribute('href'));
  });

  window.addEventListener('popstate', dispatch);

  const pending = sessionStorage.getItem('spa:path');
  if (pending) {
    sessionStorage.removeItem('spa:path');
    history.replaceState({}, '', pending);
  }
  dispatch();
  initSwapSystem();

  return { nav, dispatch, replace: (u) => nav(u, { replace: true }) };
}
