function isNodeLike() {
  return typeof process !== "undefined" && !!process.versions?.node;
}

async function fetchText(url) {
  const u = String(url || "").trim();
  if (!u) throw new Error("fetchText: missing url");

  if (typeof fetch === "function") {
    const resp = await fetch(u);
    if (!resp.ok) throw new Error(`fetch failed ${resp.status} ${resp.statusText} for ${u}`);
    return await resp.text();
  }

  const parsed = new URL(u);
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
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) return resolve(body);
          reject(new Error(`fetch failed ${res.statusCode || 0} ${res.statusMessage || ""} for ${u}`.trim()));
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

export async function loadSolanaWeb3FromWeb() {
  if (!isNodeLike()) throw new Error("loadSolanaWeb3FromWeb can only run in Node");

  // Ensure common globals expected by browser bundles.
  try { if (typeof globalThis.window === "undefined") globalThis.window = globalThis; } catch {}
  try { if (typeof globalThis.self === "undefined") globalThis.self = globalThis; } catch {}
  try { if (typeof globalThis.global === "undefined") globalThis.global = globalThis; } catch {}

  if (globalThis.solanaWeb3) return globalThis.solanaWeb3;
  if (globalThis.window?.solanaWeb3) return globalThis.window.solanaWeb3;

  const vm = await import("node:vm");

  // IIFE build: self-contained, no bare-specifier resolution.
  const srcUrl = "https://cdn.jsdelivr.net/npm/@solana/web3.js@1.95.1/lib/index.iife.min.js";
  const code = await fetchText(srcUrl);

  // Evaluate as a script so `var solanaWeb3 = ...` lands on globalThis.
  vm.runInThisContext(code, { filename: srcUrl });

  const web3 = globalThis.solanaWeb3 || globalThis.window?.solanaWeb3;
  if (!web3) throw new Error("Loaded Solana web3 IIFE, but global solanaWeb3 was not found");

  try { globalThis.window.solanaWeb3 = web3; } catch {}
  return web3;
}
