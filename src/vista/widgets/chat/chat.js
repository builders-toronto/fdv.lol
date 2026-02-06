import { GISCUS } from "../../../config/env.js";

const GISCUS_ORIGIN = "https://giscus.app";

function isGiscusDisabledByHost(containerId) {
  try {
    const id = String(containerId || "chatMount");
    const el = typeof document !== "undefined" ? document.getElementById(id) : null;
    if (!el || !el.closest) return false;
    const inAuto = !!el.closest(".fdv-auto-wrap");
    if (!inAuto) return false;

    try {
      if (el.hasAttribute?.("data-fdv-giscus-allow-auto")) return false;
      if (el.closest?.("[data-fdv-giscus-allow-auto='1'],[data-fdv-giscus-allow-auto='true']")) return false;
      if (el.classList?.contains?.("fdv-giscus-allow-auto")) return false;
    } catch {}

    return true;
  } catch {
    return false;
  }
}

function isGiscusDebugEnabled() {
  try {
    return !!(typeof window !== "undefined" && window.GISCUS_DEBUG);
  } catch {
    return false;
  }
}

function ensureContainer(id = "chatMount") {
  const el = document.getElementById(id);
  if (!el) console.warn(`#${id} not found for Giscus mount.`);
  return el;
}

function _removeFdVHints(mount) {
  try {
    mount?.querySelectorAll?.(".fdv-giscus-hint")?.forEach?.((n) => {
      try { n.remove(); } catch {}
    });
  } catch {}
}

function _setMissingDiscussionHint({ mount, repo, term, number, mapping }) {
  try {
    if (!mount) return;
    _removeFdVHints(mount);
    const box = document.createElement("div");
    box.className = "fdv-giscus-hint";
    box.style.margin = "8px 0";
    box.style.padding = "10px 12px";
    box.style.borderRadius = "12px";
    box.style.border = "1px solid var(--fdv-border,#333)";
    box.style.background = "rgba(255,255,255,0.04)";
    box.style.fontSize = "12px";
    box.style.lineHeight = "1.35";

    const repoStr = String(repo || "").trim();
    const q = String(term || "").trim();
    const n = Math.floor(Number(number || 0));
    const url = (repoStr && q)
      ? `https://github.com/${repoStr}/discussions?discussions_q=${encodeURIComponent(q)}`
      : (repoStr && n > 0)
        ? `https://github.com/${repoStr}/discussions/${n}`
        : "";

    const keyTxt = mapping === "number" ? `#${n}` : (q ? q.slice(0, 10) + (q.length > 10 ? "…" : "") : "thread");
    box.innerHTML = `
      <div style="opacity:.95;">
        <strong>Thread not created yet</strong> (${keyTxt}).
      </div>
      <div style="margin-top:4px; opacity:.85;">
        GitHub Discussions are created on first comment. Reactions may not stick until a discussion exists.
        ${url ? `<a href="${url}" target="_blank" rel="noreferrer" style="margin-left:6px; color:#9ecbff; text-decoration:none;">Open on GitHub</a>` : ""}
      </div>
    `;
    mount.insertBefore(box, mount.firstChild);
  } catch {}
}

async function _probeDiscussionExists({ repo, category, term, number, strict }) {
  try {
    const repoStr = String(repo || "").trim();
    const cat = String(category || "").trim();
    const t = String(term || "").trim();
    const n = Math.floor(Number(number || 0));
    if (!repoStr || !cat) return { ok: false, unknown: true };

    const u = new URL("https://giscus.app/api/discussions");
    u.searchParams.set("repo", repoStr);
    u.searchParams.set("category", cat);
    u.searchParams.set("number", String(n > 0 ? n : 0));
    u.searchParams.set("strict", strict ? "true" : "false");
    u.searchParams.set("last", "15");
    if (t) u.searchParams.set("term", t);

    const res = await fetch(String(u), { method: "GET", mode: "cors", cache: "no-store" });
    if (res.ok) return { ok: true, missing: false };
    if (res.status === 404) return { ok: true, missing: true };
    return { ok: false, unknown: true, status: res.status };
  } catch {
    return { ok: false, unknown: true };
  }
}


function injectScript({ term, mint, mapping = "specific", strict = false, containerId = "chatMount", theme, loading }) {
  const mount = ensureContainer(containerId);
  if (!mount) return;

  const resolvedTerm = String((term ?? mint) || "").trim();
  if (!resolvedTerm) return;
  const resolvedMapping = String(mapping || "specific").trim() || "specific";

  _removeFdVHints(mount);
  mount.querySelectorAll("script[src*='giscus.app'], .giscus, iframe.giscus-frame")
       .forEach(n => n.remove());

  const s = document.createElement("script");
  s.src = "https://giscus.app/client.js";
  s.async = true;
  s.crossOrigin = "anonymous";

  s.setAttribute("data-repo", GISCUS.repo);
  s.setAttribute("data-repo-id", GISCUS.repoId);
  s.setAttribute("data-category", GISCUS.category);
  s.setAttribute("data-category-id", GISCUS.categoryId);

  s.setAttribute("data-mapping", resolvedMapping);
  s.setAttribute("data-term", resolvedTerm);
  s.setAttribute("data-strict", strict ? "1" : "0");

  s.setAttribute("data-reactions-enabled", "1");
  s.setAttribute("data-emit-metadata", "0");
  s.setAttribute("data-input-position", "bottom");
  s.setAttribute("data-theme", theme || GISCUS.theme || "dark");
  s.setAttribute("data-lang", "en");
  s.setAttribute("data-loading", String(loading || "lazy"));

  // Non-giscus attrs; useful for debugging DOM/state.
  try {
    s.setAttribute("data-fdv-giscus-container", String(containerId || ""));
    s.setAttribute("data-fdv-giscus-mapping", String(resolvedMapping || ""));
    s.setAttribute("data-fdv-giscus-term", String(resolvedTerm || ""));
  } catch {}

  mount.appendChild(s);
}
//gisqus todo
function setConfig({ term, theme, containerId = "chatMount" }) {
  const mount = ensureContainer(containerId);
  if (!mount) return false;

  const frame = mount.querySelector("iframe.giscus-frame");
  if (!frame || !frame.contentWindow) return false;

  const msg = { giscus: { setConfig: {} } };
  if (term)  msg.giscus.setConfig.term = term;
  if (theme) msg.giscus.setConfig.theme = theme;

  frame.contentWindow.postMessage(msg, GISCUS_ORIGIN);
  return true;
}

const _instances = new Map(); 

export function unmountGiscus(opts) {
  try {
    const containerId = typeof opts === "string" ? opts : (opts?.containerId || "chatMount");
    const key = String(containerId || "chatMount");
    try {
      const inst = _instances.get(key);
      if (inst && inst.ensureTimer) {
        clearTimeout(inst.ensureTimer);
        inst.ensureTimer = 0;
      }
    } catch {}
    const mount = ensureContainer(key);
    if (mount) {
      try { _removeFdVHints(mount); } catch {}
      mount.querySelectorAll("script[src*='giscus.app'], .giscus, iframe.giscus-frame")
        .forEach((n) => {
          try { n.remove(); } catch {}
        });
    }
    try { _instances.delete(key); } catch {}
  } catch {}
}

export function mountGiscus(opts) {
  const {
    term,
    mint,
    discussionNumber,
    number,
    mapping,
    containerId = "chatMount",
    theme,
    loading,
    allowMintThread = false,
    showMissingHint = true,
    lockId,
    force = false,
  } = opts || {};

  if (isGiscusDisabledByHost(containerId)) return;

  const officialThreadNumber = Math.floor(Number(GISCUS?.traderThreadNumber || 0));

  // Heuristic: Solana mints / mint-like slugs are long base58-ish strings.
  const looksMintLike = (v) => {
    const s = String(v || "").trim();
    if (s.length < 24) return false;
    if (s.includes(" ")) return false;
    // Base58-ish with optional suffixes like 'pump'
    return /^[1-9A-HJ-NP-Za-km-z]+$/i.test(s);
  };

  let num = Number(discussionNumber ?? number ?? 0);
  let resolvedMapping = (num > 0) ? "number" : (String(mapping || "specific").trim() || "specific");
  let resolvedTerm = (num > 0) ? String(Math.floor(num)) : String((term ?? mint) || "").trim();

  if (!allowMintThread && officialThreadNumber > 0 && resolvedMapping !== "number" && looksMintLike(resolvedTerm)) {
    num = officialThreadNumber;
    resolvedMapping = "number";
    resolvedTerm = String(officialThreadNumber);
  }

  if (!resolvedTerm) { console.warn("Giscus: missing term"); return; }
  if (!GISCUS.repo || !GISCUS.repoId || !GISCUS.category || !GISCUS.categoryId) {
    console.warn("Giscus: missing repo/category configuration");
    return;
  }

  const key = String(containerId || "chatMount");
  const inst = _instances.get(key) || { booted: false, lastTerm: "", lastMapping: "", lastTheme: "", lastLoading: "", lockId: "", ensureTimer: 0, ensureAttempts: 0, missingCheckKey: "", missingRecheckTimer: 0, lastInjectAt: 0 };
  _instances.set(key, inst);

  const resolvedLoading = String(loading || inst.lastLoading || "lazy");
  const resolvedStrict = false;

  const scheduleMissingCheck = () => {
    if (isGiscusDisabledByHost(key)) return;
    if (!showMissingHint) return;
    // Only meaningful for term-based mapping; number threads are assumed to exist.
    if (resolvedMapping !== "specific" && resolvedMapping !== "title" && resolvedMapping !== "pathname" && resolvedMapping !== "url") return;
    const repo = String(GISCUS?.repo || "").trim();
    const cat = String(GISCUS?.category || "").trim();
    const checkKey = `${resolvedMapping}|${resolvedTerm}|${repo}|${cat}`;
    if (!force && inst.missingCheckKey === checkKey) return;
    inst.missingCheckKey = checkKey;

    try {
      if (inst.missingRecheckTimer) {
        clearTimeout(inst.missingRecheckTimer);
        inst.missingRecheckTimer = 0;
      }
    } catch {}

    const run = async () => {
      try {
        const mount = ensureContainer(key);
        if (!mount) return;
        const probed = await _probeDiscussionExists({ repo, category: cat, term: resolvedTerm, number: 0, strict: resolvedStrict });
        if (!probed?.ok) return;
        if (probed.missing) {
          _setMissingDiscussionHint({ mount, repo, term: resolvedTerm, number: 0, mapping: resolvedMapping });
          // One re-check later in case the user just posted the first comment.
          try {
            inst.missingRecheckTimer = setTimeout(() => {
              try { scheduleMissingCheck(); } catch {}
            }, 15_000);
          } catch {}
          return;
        }
        _removeFdVHints(mount);
      } catch {}
    };

    // Let the giscus script/iframe attempt first; then check.
    try { setTimeout(run, 1200); } catch { run(); }
  };

  // If a container is locked, refuse mounts from other callers unless forced.
  // This prevents stale/parallel code paths from briefly mounting the wrong thread.
  if (inst.lockId && lockId && inst.lockId !== lockId && !force) {
    if (isGiscusDebugEnabled()) {
      console.warn("[Giscus] mount refused due to lock", {
        containerId: key,
        existingLockId: inst.lockId,
        lockId,
        mapping: resolvedMapping,
        term: resolvedTerm,
      });
    }
    return;
  }
  if (!inst.lockId && lockId) inst.lockId = String(lockId);

  if (isGiscusDebugEnabled()) {
    try {
      const stack = new Error().stack;
      console.info("[Giscus] mountGiscus", {
        containerId: key,
        mapping: resolvedMapping,
        term: resolvedTerm,
        force,
        theme: theme || GISCUS.theme || "dark",
        stack,
      });
    } catch {}
  }

  const hasIframe = () => {
    try {
      const mount = ensureContainer(key);
      if (!mount) return false;
      return !!mount.querySelector("iframe.giscus-frame");
    } catch {
      return false;
    }
  };

  // Avoid churning if already set, but only if the iframe actually exists.
  if (!force && inst.booted && inst.lastTerm === resolvedTerm && inst.lastMapping === resolvedMapping && (!theme || inst.lastTheme === theme) && (!loading || inst.lastLoading === resolvedLoading)) {
    if (hasIframe()) return;
    // If we just injected, give it a moment before deciding it failed.
    try {
      if (inst.lastInjectAt && (Date.now() - Number(inst.lastInjectAt || 0) < 1200)) return;
    } catch {}
    // Fall through and reinject.
  }

  const scheduleEnsureIframe = () => {
    // Only do this for eager mounts; lazy mounts intentionally wait until visible.
    if (resolvedLoading !== "eager") return;
    try {
      if (inst.ensureTimer) clearTimeout(inst.ensureTimer);
      inst.ensureTimer = setTimeout(() => {
        try {
          const current = _instances.get(key);
          if (!current || current !== inst) return;
          const mount = ensureContainer(key);
          if (!mount) return;
          const frame = mount.querySelector("iframe.giscus-frame");
          if (frame) return;
          if ((inst.ensureAttempts || 0) >= 1) return;
          inst.ensureAttempts = (inst.ensureAttempts || 0) + 1;
          injectScript({ term: resolvedTerm, mapping: resolvedMapping, strict: false, containerId: key, theme, loading: resolvedLoading });
        } catch {}
      }, 2500);
    } catch {}
  };

  if (!inst.booted || force) {
    if (force) {
      try {
        const mount = ensureContainer(key);
        mount?.querySelectorAll?.("script[src*='giscus.app'], .giscus, iframe.giscus-frame")?.forEach?.((n) => n.remove());
      } catch {}
    }
    inst.ensureAttempts = 0;
    inst.lastInjectAt = Date.now();
    injectScript({ term: resolvedTerm, mapping: resolvedMapping, strict: false, containerId: key, theme, loading: resolvedLoading });
    inst.booted = true;
    inst.lastTerm = resolvedTerm;
    inst.lastMapping = resolvedMapping;
    inst.lastTheme = theme || inst.lastTheme;
    inst.lastLoading = resolvedLoading;
    scheduleEnsureIframe();
    scheduleMissingCheck();
    return;
  }

    // Mapping cannot be updated via postMessage; must reinject.
    if (inst.lastMapping && inst.lastMapping !== resolvedMapping) {
      inst.ensureAttempts = 0;
      inst.lastInjectAt = Date.now();
      injectScript({ term: resolvedTerm, mapping: resolvedMapping, strict: false, containerId: key, theme, loading: resolvedLoading });
      inst.lastTerm = resolvedTerm;
      inst.lastMapping = resolvedMapping;
      inst.lastTheme = theme || inst.lastTheme;
      inst.lastLoading = resolvedLoading;
      scheduleEnsureIframe();
      scheduleMissingCheck();
      return;
    }

  if (!setConfig({ term: resolvedTerm, theme, containerId: key })) {
    inst.ensureAttempts = 0;
    inst.lastInjectAt = Date.now();
    injectScript({ term: resolvedTerm, mapping: resolvedMapping, strict: false, containerId: key, theme, loading: resolvedLoading });
    scheduleEnsureIframe();
  }
  scheduleMissingCheck();
  inst.lastTerm = resolvedTerm;
  inst.lastMapping = resolvedMapping;
  inst.lastTheme = theme || inst.lastTheme;
  inst.lastLoading = resolvedLoading;
}

export function giscusDiscussionSearchUrl(term) {
  const t = String(term || "").trim();
  const repo = String(GISCUS?.repo || "").trim();
  if (!t || !repo) return "";
  return `https://github.com/${repo}/discussions?discussions_q=${encodeURIComponent(t)}`;
}

export function giscusDiscussionUrlByNumber(number) {
  const n = Math.floor(Number(number || 0));
  const repo = String(GISCUS?.repo || "").trim();
  if (!repo || !(n > 0)) return "";
  return `https://github.com/${repo}/discussions/${n}`;
}
export function setGiscusTheme(theme = "dark") {
	try {
		let any = false;
		for (const [containerId] of _instances.entries()) {
			any = true;
			try { setConfig({ theme, containerId }); } catch {}
		}
		if (!any) {
			// Back-compat: try the default container.
			if (!setConfig({ theme, containerId: "chatMount" })) {
				GISCUS.theme = theme;
			}
		}
	} catch {
		GISCUS.theme = theme;
	}
}
