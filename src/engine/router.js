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

  return { nav, dispatch, replace: (u) => nav(u, { replace: true }) };
}
