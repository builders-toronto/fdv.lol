const _moduleCache = new Map();
const _dataUrlCache = new Map();

function isNodeLike() {
  return typeof process !== "undefined" && !!process.versions?.node;
}

async function fetchText(url) {
  const u = String(url || "").trim();
  if (!u) throw new Error("fetchText: missing url");

  const tryOne = async (urlTry) => {
    if (typeof fetch === "function") {
      const resp = await fetch(urlTry);
      if (!resp.ok) {
        const err = new Error(`fetch failed ${resp.status} ${resp.statusText} for ${urlTry}`);
        err.status = resp.status;
        throw err;
      }
      return await resp.text();
    }

    const parsed = new URL(urlTry);
    const mod = await import(parsed.protocol === "http:" ? "node:http" : "node:https");

    return await new Promise((resolve, reject) => {
      const req = mod.request(
        {
          method: "GET",
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port,
          path: `${parsed.pathname}${parsed.search}`,
          headers: { "user-agent": "fdv.lol" },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(body);
              return;
            }
            const err = new Error(
              `fetch failed ${res.statusCode || 0} ${res.statusMessage || ""} for ${urlTry}`.trim()
            );
            err.status = res.statusCode || 0;
            reject(err);
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
  };

  const candidates = [];
  candidates.push(u);

  // esm.sh sometimes requires explicit .js for deep subpaths.
  if (/^https?:\/\/esm\.sh\//i.test(u)) {
    const qIdx = u.indexOf("?");
    const base = qIdx >= 0 ? u.slice(0, qIdx) : u;
    const query = qIdx >= 0 ? u.slice(qIdx) : "";

    if (query.includes("bundle")) {
      candidates.push(base); // try without ?bundle
    }

    if (!/\.m?js$/i.test(base)) {
      candidates.push(`${base}.js${query}`);
      if (query.includes("bundle")) candidates.push(`${base}.js`);
    }
  }

  const tried = new Set();
  let lastErr = null;
  for (const c of candidates) {
    const key = String(c);
    if (tried.has(key)) continue;
    tried.add(key);
    try {
      return await tryOne(key);
    } catch (err) {
      lastErr = err;
      // Only fall through on 404; for other errors just keep trying candidates.
    }
  }

  throw lastErr || new Error(`fetch failed for ${u}`);
}

function toDataUrl(jsSource, sourceUrl) {
  const withSourceUrl = `${String(jsSource || "")}\n//# sourceURL=${String(sourceUrl || "")}`;
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(withSourceUrl)}`;
}

function isProbablyNodeBuiltin(spec) {
  const s = String(spec || "").trim();
  if (!s) return false;
  if (s.startsWith("node:")) return true;

  if (s === "assert/strict") return true;
  if (s === "timers/promises") return true;
  if (s === "stream/web") return true;

  return (
    s === "fs" ||
    s === "path" ||
    s === "url" ||
    s === "http" ||
    s === "https" ||
    s === "crypto" ||
    s === "buffer" ||
    s === "stream" ||
    s === "util" ||
    s === "events" ||
    s === "net" ||
    s === "tls" ||
    s === "zlib" ||
    s === "os" ||
    s === "tty" ||
    s === "assert" ||
    s === "perf_hooks" ||
    s === "timers" ||
    s === "process"
  );
}

function resolveToUrl(spec, baseUrl) {
  const s = String(spec || "").trim();
  if (!s) return s;
  if (isProbablyNodeBuiltin(s) && !s.startsWith("node:")) return `node:${s}`;
  if (/^(node:|data:|file:)/i.test(s)) return s;
  if (/^https?:\/\//i.test(s)) return s;

  if (s.startsWith(".") || s.startsWith("/")) {
    try {
      return new URL(s, baseUrl).toString();
    } catch {
      return s;
    }
  }

  return `https://esm.sh/${s}?bundle`;
}

function collectSpecifiers(js) {
  const src = String(js || "");
  const specs = new Set();

  const RE_IMPORT_FROM = /\bimport\s+[\s\S]*?\sfrom\s*(['"])([^'\"]+)\1/g;
  const RE_EXPORT_FROM_1 = /\bexport\s+\*\s+from\s*(['"])([^'\"]+)\1/g;
  const RE_EXPORT_FROM_2 = /\bexport\s+\{[\s\S]*?\}\s+from\s*(['"])([^'\"]+)\1/g;
  const RE_DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"])([^'\"]+)\1\s*\)/g;

  for (const m of src.matchAll(RE_IMPORT_FROM)) specs.add(m[2]);
  for (const m of src.matchAll(RE_EXPORT_FROM_1)) specs.add(m[2]);
  for (const m of src.matchAll(RE_EXPORT_FROM_2)) specs.add(m[2]);
  for (const m of src.matchAll(RE_DYNAMIC_IMPORT)) specs.add(m[2]);

  return Array.from(specs);
}

async function materializeUrlToData(url, { depth = 0 } = {}) {
  const u = String(url || "").trim();
  if (!u) throw new Error("materializeUrlToData: missing url");
  if (/^(node:|data:|file:)/i.test(u)) return u;

  if (_dataUrlCache.has(u)) return await _dataUrlCache.get(u);

  const p = (async () => {
    if (depth > 25) return toDataUrl(await fetchText(u), u);

    const js = await fetchText(u);
    const specs = collectSpecifiers(js);
    if (!specs.length) return toDataUrl(js, u);

    const mapping = new Map();
    await Promise.all(
      specs.map(async (spec) => {
        const resolved = resolveToUrl(spec, u);

        if (/^(node:|data:|file:)/i.test(resolved)) {
          mapping.set(spec, resolved);
          return;
        }

        if (/^https?:\/\//i.test(resolved)) {
          mapping.set(spec, await materializeUrlToData(resolved, { depth: depth + 1 }));
          return;
        }

        mapping.set(spec, resolved);
      })
    );

    const RE_IMPORT_FROM = /(\bimport\s+[\s\S]*?\sfrom\s*)(['"])([^'\"]+)(\2)/g;
    const RE_EXPORT_FROM_1 = /(\bexport\s+\*\s+from\s*)(['"])([^'\"]+)(\2)/g;
    const RE_EXPORT_FROM_2 = /(\bexport\s+\{[\s\S]*?\}\s+from\s*)(['"])([^'\"]+)(\2)/g;
    const RE_DYNAMIC_IMPORT = /(\bimport\s*\(\s*)(['"])([^'\"]+)(\2)(\s*\))/g;

    const rewrite = (source, re) =>
      source.replace(re, (_full, prefix, quote, spec, quote2, suffix = "") => {
        const outSpec = mapping.get(spec) || spec;
        return `${prefix}${quote}${outSpec}${quote2}${suffix}`;
      });

    let out = js;
    out = rewrite(out, RE_IMPORT_FROM);
    out = rewrite(out, RE_EXPORT_FROM_1);
    out = rewrite(out, RE_EXPORT_FROM_2);
    out = rewrite(out, RE_DYNAMIC_IMPORT);

    return toDataUrl(out, u);
  })();

  _dataUrlCache.set(u, p);
  return await p;
}

export async function importFromUrl(url, { cacheKey } = {}) {
  const u = String(url || "").trim();
  if (!u) throw new Error("importFromUrl: missing url");
  if (!isNodeLike()) return await import(u);

  const key = String(cacheKey || u);
  if (_moduleCache.has(key)) return await _moduleCache.get(key);

  const p = (async () => {
    const dataUrl = await materializeUrlToData(u);
    return await import(dataUrl);
  })();

  _moduleCache.set(key, p);
  return await p;
}
