const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn)=>setTimeout(fn,16);
const ric = typeof requestIdleCallback === 'function' ? requestIdleCallback : (fn)=>setTimeout(()=>fn({ didTimeout:false, timeRemaining:()=>8 }), 48);

function __getWidgetGlob__() {
  try {

    if (typeof import.meta !== 'undefined' && typeof import.meta.glob === 'function') {
      return import.meta.glob('./**/index.{js,ts,mjs,cjs,jsx,tsx}');
    }

    if (typeof import.meta !== 'undefined' && typeof import.meta.globEager === 'function') {
      const eager = import.meta.globEager('./**/index.{js,ts,mjs,cjs,jsx,tsx}');
      const map = {};
      for (const [k, v] of Object.entries(eager)) map[k] = async () => v;
      return map;
    }

    if (typeof require !== 'undefined' && typeof require.context === 'function') {
      const ctx = require.context('./', true, /index\.(js|ts|mjs|cjs|jsx|tsx)$/);
      const map = {};
      ctx.keys().forEach((k) => { map[k] = async () => ctx(k); });
      return map;
    }
  } catch {}
  return null;
}

const __WIDGET_GLOB__ = __getWidgetGlob__();

function __deriveWidgetName__(path) {
  const clean = String(path).replace(/^[.][/\\]/, '').replace(/\\/g, '/');
  const parts = clean.split('/');
  const lastDir = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  return (lastDir || 'widget').replace(/[^\w-]+/g, '_');
}

function __resolveFirstFn__(mod, names) {
  for (const n of names) {
    if (typeof mod?.[n] === 'function') return mod[n];
    if (typeof mod?.default?.[n] === 'function') return mod.default[n];
  }
  return null;
}

function __extractMetaFromMod__(mod) {
  const m = (mod && typeof mod === 'object') ? mod : {};
  const d = (m.default && typeof m.default === 'object') ? m.default : {};
  return {
    eager: m.eager ?? d.eager,
    whenVisible: m.whenVisible ?? d.whenVisible,
    once: m.once ?? d.once,
    hostSelector: m.hostSelector ?? d.hostSelector,
  };
}

function createWidgetVM(defaultHost = (typeof document !== 'undefined' ? document.body : null)) {
  /** @type {Map<string, any>} */
  const reg = new Map();
  /** @type {IntersectionObserver|null} */
  let io = null;
  const observed = new Set();

  function debug(msg) { try { if (window?.__FDV_WIDGETS_DEBUG__) console.debug('[widgets]', msg); } catch {} }
  function warn(msg) { try { if (window?.__FDV_WIDGETS_DEBUG__) console.warn('[widgets]', msg); } catch {} }

  function ensureHost(spec, provided) {
    if (provided && provided instanceof HTMLElement) return provided;
    if (spec?.hostSelector && typeof document !== 'undefined') {
      const el = document.querySelector(spec.hostSelector);
      if (el) return el;
    }
    return defaultHost;
  }
  function maybeApplyModMeta(name, rec, mod) {
    const meta = __extractMetaFromMod__(mod);
    if (rec && rec.spec) {
      if (rec.spec.hostSelector == null && meta.hostSelector) rec.spec.hostSelector = meta.hostSelector;
      if (rec.spec.once == null && typeof meta.once === 'boolean') rec.spec.once = meta.once;
      if (rec.spec.whenVisible == null && typeof meta.whenVisible === 'boolean') rec.spec.whenVisible = meta.whenVisible;
      if (rec.spec.eager == null && typeof meta.eager === 'boolean') rec.spec.eager = meta.eager;
      if (rec.spec.whenVisible && rec.host && !observed.has(rec.host)) {
        observeVisibility(name);
      }
    }
  }

  function ctxFor(name, spec, mod, host, props) {
    return { name, host, mod, props: props || {} };
  }

  function setStatus(name, patch) {
    const rec = reg.get(name);
    if (rec) Object.assign(rec, patch);
  }

  async function importIfNeeded(name) {
    const rec = reg.get(name);
    if (!rec) throw new Error(`Widget "${name}" not registered`);
    if (rec.mod) return rec.mod;
    if (!rec.spec?.importer) throw new Error(`Widget "${name}" missing importer`);
    rec.status = 'importing';
    const mod = await rec.spec.importer();
    rec.mod = mod;
    try { maybeApplyModMeta(name, rec, mod); } catch {}
    rec.status = 'imported';
    return mod;
  }

  async function initIfNeeded(name, host, props) {
    const rec = reg.get(name);
    if (!rec) throw new Error(`Widget "${name}" not registered`);
    if (rec.inited) return rec.mod;
    const mod = await importIfNeeded(name);
    if (typeof rec.spec.init === 'function') {
      try {
        await rec.spec.init(ctxFor(name, rec.spec, mod, host, props));
      } catch (e) {
        rec.status = 'error';
        throw e;
      }
    }
    rec.inited = true;
    rec.status = 'prewarmed';
    return mod;
  }

  async function prewarm(name) {
    const rec = reg.get(name);
    if (!rec) throw new Error(`Widget "${name}" not registered`);
    const host = ensureHost(rec.spec, rec.host);
    // idle prewarm
    await new Promise((resolve) => ric(resolve));
    await initIfNeeded(name, host, rec.lastProps);
    return reg.get(name)?.mod;
  }

  async function mount(name, props = {}) {
    const rec = reg.get(name);
    if (!rec) throw new Error(`Widget "${name}" not registered`);
    const host = ensureHost(rec.spec, props.host || rec.host);
    rec.host = host;
    rec.lastProps = props;

    const mod = await initIfNeeded(name, host, props);
    if (rec.mounted && rec.spec.once) return true;
    if (typeof rec.spec.mount === 'function') {
      rec.status = 'mounting';
      await rec.spec.mount(ctxFor(name, rec.spec, mod, host, props));
      rec.mounted = true;
      rec.status = 'mounted';
      return true;
    }
    rec.mounted = true;
    rec.status = 'mounted';
    return true;
  }

  async function unmount(name) {
    const rec = reg.get(name);
    if (!rec || !rec.mounted) return;
    const host = ensureHost(rec.spec, rec.host);
    if (typeof rec.spec.unmount === 'function') {
      await rec.spec.unmount(ctxFor(name, rec.spec, rec.mod, host, rec.lastProps));
    }
    rec.mounted = false;
    rec.status = 'prewarmed';
  }

  function observeVisibility(name) {
    const rec = reg.get(name);
    if (!rec?.spec?.whenVisible) return;
    if (!('IntersectionObserver' in window) || !rec.host) return;
    if (!io) {
      io = new IntersectionObserver((entries) => {
        entries.forEach((ent) => {
          const el = ent.target;
          const hit = ent.isIntersecting || ent.intersectionRatio > 0;
          const n = el?.dataset?.widgetName;
          if (!n) return;
          const r = reg.get(n);
          if (!r || !hit) return;
          // mount once visible
          mount(n, r.lastProps || {}).catch(()=>{});
          if (r.spec.once) io?.unobserve(el);
        });
      }, { rootMargin: '0px 0px 200px 0px', threshold: [0, 0.01, 0.1] });
    }
    try {
      if (rec.host) {
        rec.host.dataset.widgetName = name;
        io.observe(rec.host);
        observed.add(rec.host);
      }
    } catch {}
  }

  function register(name, spec /** @type {WidgetSpec} */) {
    if (!name || reg.has(name)) throw new Error(`Widget "${name}" already registered or invalid name`);
    reg.set(name, {
      name,
      spec,
      mod: null,
      host: null,
      inited: false,
      mounted: false,
      status: 'registered',
      lastProps: null,
    });

    if (spec.eager) {
      ric(() => prewarm(name).catch(()=>{}));
    }

    raf(() => {
      const rec = reg.get(name);
      if (!rec) return;
      rec.host = ensureHost(spec, rec.host);
      if (spec.whenVisible && rec.host) observeVisibility(name);
    });

    return apiFor(name);
  }

  function apiFor(name) {
    return {
      name,
      prewarm: () => prewarm(name),
      mount: (props) => mount(name, props),
      unmount: () => unmount(name),
      status: () => reg.get(name)?.status,
      module: () => reg.get(name)?.mod || null,
    };
  }

  async function button(name, opts) {
    const rec = reg.get(name);
    if (!rec) throw new Error(`Widget "${name}" not registered`);
    await prewarm(name);
    if (typeof rec.spec.button === 'function') {
      return rec.spec.button(rec.mod, opts);
    }
    throw new Error(`Widget "${name}" does not provide a button factory`);
  }

  async function mountAllEagerVisible() {
    for (const [name, rec] of reg) {
      if (rec.spec.whenVisible && rec.host) {
        const r = rec.host.getBoundingClientRect?.();
        const visible = !!r && r.bottom >= 0 && r.right >= 0 && r.top <= (window.innerHeight || 0) && r.left <= (window.innerWidth || 0);
        if (visible) { mount(name, rec.lastProps || {}).catch(()=>{}); }
      }
    }
  }

  return {
    register,
    prewarm,
    mount,
    unmount,
    button,
    apiFor,
    mountAllEagerVisible,
    debug: (on = true) => { try { window.__FDV_WIDGETS_DEBUG__ = !!on; } catch {} },
  };
}

export const widgets = createWidgetVM();

export function discoverAndRegisterWidgets(params = {}) {
  const {
    only,
    include,
    exclude,
    perWidget = {},
    defaults = {},
  } = params;

  if (!__WIDGET_GLOB__ || !Object.keys(__WIDGET_GLOB__).length) {
    warn('Widget auto-discovery unavailable or empty (no index.* found).');
    return [];
  }

  const onlySet = only ? new Set(only) : null;
  const includeSet = include ? new Set(include) : null;
  const excludeSet = exclude ? new Set(exclude) : null;

  const registered = [];

  for (const [path, importerFn] of Object.entries(__WIDGET_GLOB__)) {
    const name = __deriveWidgetName__(path);
    const allowed =
      (onlySet ? onlySet.has(name) : true) &&
      (includeSet ? includeSet.has(name) : true) &&
      (excludeSet ? !excludeSet.has(name) : true);
    if (!allowed) continue;

    const overrides = perWidget[name] || {};
    const spec = {
      importer: async () => {
        const mod = await importerFn();
        return mod;
      },
      init: ({ mod, ...ctx }) => {
        const fn = __resolveFirstFn__(mod, [
          'init',
          'bootstrap',
          'setup',
          'initLibrary', 'initFavboard', 'initSearch', 'initAutoWidget',
        ]);
        return fn ? fn({ mod, ...ctx }) : undefined;
      },
      mount: ({ mod, ...ctx }) => {
        const fn = __resolveFirstFn__(mod, [
          'mount',
          'render',
          'init',
          'initAutoWidget',
        ]);
        return fn ? fn({ mod, ...ctx }) : undefined;
      },
      unmount: ({ mod, ...ctx }) => {
        const fn = __resolveFirstFn__(mod, ['unmount', 'teardown', 'destroy']);
        return fn ? fn({ mod, ...ctx }) : undefined;
      },
      button: (mod, opts) => {
        const fn = __resolveFirstFn__(mod, ['button', 'createButton', 'createOpenLibraryButton', 'createOpenFavboardButton']);
        return fn ? fn(opts) : (() => { throw new Error(`Widget "${name}" has no button()`) })();
      },
      hostSelector: overrides.hostSelector ?? defaults.hostSelector ?? undefined,
      eager: overrides.eager ?? defaults.eager ?? false,
      whenVisible: overrides.whenVisible ?? defaults.whenVisible ?? false,
      once: overrides.once ?? defaults.once ?? true,
    };

    widgets.register(name, spec);
    registered.push(name);
  }

  return registered;
}

export async function setupWidgets(params = {}) {
  const {
    prewarm = false,
    autoMount = false,
    props = {},
    ...discoverParams
  } = params;

  const names = discoverAndRegisterWidgets(discoverParams);

  if (prewarm) {
    await Promise.all(names.map((n) => widgets.prewarm(n).catch(()=>{})));
  }
  if (autoMount) {
    await Promise.all(names.map((n) => widgets.mount(n, props).catch(()=>{})));
  }
  return names;
}

export function registerCoreWidgets() {
  // Library
  widgets.register('library', {
    importer: () => import('./library/index.js'),
    init: ({ mod }) => mod.initLibrary(),
    button: (mod, opts) => mod.createOpenLibraryButton(opts),
    eager: true, 
    once: true,
  });

  widgets.register('favboard', {
    importer: () => import('./favboard/index.js'),
    init: ({ mod }) => mod.initFavboard(),
    button: (mod, opts) => mod.createOpenFavboardButton(opts),
    eager: true,
    once: true,
  });

  widgets.register('search', {
    importer: () => import('./search/index.js'),
    mount: ({ mod, props }) => {
      const { elQ, elQResults, elSearchWrap } = props || {};
      if (!elQ || !elQResults) return;
      mod.initSearch(elQ, elQResults, elSearchWrap);
    },
    once: true,
  });

  widgets.register('chat', {
    importer: () => import('./chat/chat.js'),
    mount: ({ mod, host, props }) => {
      const containerId = props?.containerId || 'chatMount';
      let mountHost = host || document.body;
      let container = document.getElementById(containerId);
      if (!container && mountHost) {
        container = document.createElement('div');
        container.id = containerId;
        mountHost.appendChild(container);
      }
      mod.mountGiscus({
        mint: props?.mint || 'lobby',
        containerId,
        theme: props?.theme,
      });
    },
    once: true,
    whenVisible: false,
    // hostSelector: '#chatMount',
  });

  widgets.register('auto', {
    importer: () => import('./auto/index.js'),
    mount: ({ mod, host }) => {
      const h = host || document.getElementById('hdrToolsPanels') || document.body;
      mod.initAutoWidget(h);
    },
    hostSelector: '#hdrToolsPanels',
    whenVisible: false,
    once: true,
  });


}

export async function prewarmDefaults() {
  try { registerCoreWidgets(); } catch {}
  await Promise.allSettled([
    widgets.prewarm('library'),
    widgets.prewarm('favboard'),
  ]);
}
