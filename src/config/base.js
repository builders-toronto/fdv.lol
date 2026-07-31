// Where the app is mounted.
//
// On a custom domain the app sits at the site root; on a GitHub Pages project
// site it sits under /<repo>/. Every internal path is built off this value so
// one deploy works from either mount point:
//
//   https://fdv.lol/                    -> "/"
//   https://build23w.github.io/fdv.lol/ -> "/fdv.lol/"
//   http://localhost:8080/              -> "/"
//
// Each page pins an absolute <base> in <head>, so this is just a read of it.
// Resolved once at module-eval time, which runs before the router's first
// pushState — a later history update can't perturb it.

function resolveBase() {
  try {
    return new URL('./', document.baseURI).pathname.replace(/\/*$/, '/');
  } catch {
    return '/';
  }
}

export const BASE_PATH = resolveBase();

// "/token/abc" or "token/abc" -> "/fdv.lol/token/abc"
export function appPath(p = '') {
  return BASE_PATH + String(p).replace(/^\/+/, '');
}

// Same, but absolute — for share links, canonicals and clipboard copies.
export function appUrl(p = '') {
  try {
    return new URL(appPath(p), location.origin).href;
  } catch {
    return appPath(p);
  }
}

// Route path with the mount point removed: "/fdv.lol/token/abc" -> "/token/abc"
export function stripBase(pathname) {
  const p = String(pathname || '/');
  const out = p.startsWith(BASE_PATH) ? '/' + p.slice(BASE_PATH.length) : p;
  return out.replace(/\/index\.html$/, '/');
}
