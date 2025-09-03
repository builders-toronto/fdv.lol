import { GISCUS } from "../../config/env.js";

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
function setConfig({ term, theme }) {
  const frame = document.querySelector("iframe.giscus-frame");
  if (!frame || !frame.contentWindow) return false;

  const msg = { giscus: { setConfig: {} } };
  if (term)  msg.giscus.setConfig.term = term;
  if (theme) msg.giscus.setConfig.theme = theme;

  frame.contentWindow.postMessage(msg, GISCUS_ORIGIN);
  return true;
}

let booted = false;

export function mountGiscus(opts) {
  const { mint, containerId = "chatMount", theme } = opts || {};

  console.log("Giscus: mounting", { mint, containerId, theme });

  if (!mint) { console.warn("Giscus: missing mint"); return; }
  if (!GISCUS.repo || !GISCUS.repoId || !GISCUS.category || !GISCUS.categoryId) {
    console.warn("Giscus: missing repo/category configuration");
    return;
  }
  if (!booted) {
    injectScript({ mint, containerId });
    booted = true;
    return;
  }
  if (!setConfig({ term: mint, theme })) {
    injectScript({ mint, containerId });
  }
}
export function setGiscusTheme(theme = "dark") {
  if (!setConfig({ theme })) {
    GISCUS.theme = theme;
  }
}
