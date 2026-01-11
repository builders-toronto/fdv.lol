import { GISCUS } from "../../../config/env.js";

const GISCUS_ORIGIN = "https://giscus.app";

function ensureContainer(id = "chatMount") {
  const el = document.getElementById(id);
  if (!el) console.warn(`#${id} not found for Giscus mount.`);
  return el;
}


function injectScript({ mint, containerId = "chatMount" }) {
  const mount = ensureContainer(containerId);
  if (!mount) return;

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

  s.setAttribute("data-mapping", "specific");
  s.setAttribute("data-term", mint);

  s.setAttribute("data-reactions-enabled", "1");
  s.setAttribute("data-emit-metadata", "0");
  s.setAttribute("data-input-position", "bottom");
  s.setAttribute("data-theme", GISCUS.theme || "dark");
  s.setAttribute("data-lang", "en");
  s.setAttribute("data-loading", "lazy");

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
    const mount = ensureContainer(key);
    if (mount) {
      mount.querySelectorAll("script[src*='giscus.app'], .giscus, iframe.giscus-frame")
        .forEach((n) => {
          try { n.remove(); } catch {}
        });
    }
    try { _instances.delete(key); } catch {}
  } catch {}
}

export function mountGiscus(opts) {
  const { mint, containerId = "chatMount", theme, force = false } = opts || {};

  if (!mint) { console.warn("Giscus: missing mint"); return; }
  if (!GISCUS.repo || !GISCUS.repoId || !GISCUS.category || !GISCUS.categoryId) {
    console.warn("Giscus: missing repo/category configuration");
    return;
  }

  const key = String(containerId || "chatMount");
  const inst = _instances.get(key) || { booted: false, lastMint: "", lastTheme: "" };
  _instances.set(key, inst);

  // Avoid churning if already set.
  if (!force && inst.booted && inst.lastMint === mint && (!theme || inst.lastTheme === theme)) return;

  if (!inst.booted || force) {
    // Force mode: fully re-inject to avoid "stuck" frames when the container was hidden.
    if (force) {
      try {
        const mount = ensureContainer(key);
        mount?.querySelectorAll?.("script[src*='giscus.app'], .giscus, iframe.giscus-frame")?.forEach?.((n) => n.remove());
      } catch {}
    }
    injectScript({ mint, containerId: key });
    inst.booted = true;
    inst.lastMint = mint;
    inst.lastTheme = theme || inst.lastTheme;
    return;
  }

  if (!setConfig({ term: mint, theme, containerId: key })) {
    injectScript({ mint, containerId: key });
  }
  inst.lastMint = mint;
  inst.lastTheme = theme || inst.lastTheme;
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
