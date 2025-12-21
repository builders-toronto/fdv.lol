import { now } from "./util.js";

export function markRpcStress(e, ms = 2000) {
  try {
    const s = String(e?.message || e || "");
    if (/429|Too Many Requests|403|Forbidden/i.test(s)) {
      const jitter = 500 + Math.floor(Math.random() * 2500);
      // Keep original behavior: min 2.5s + jitter under stress.
      window._fdvRpcStressUntil = now() + Math.max(500, ms | 0, 2500 + jitter);
    }
  } catch {}
}

export function rpcBackoffLeft() {
  const t = Number(window._fdvRpcStressUntil || 0);
  return Math.max(0, t - now());
}

export async function rpcWait(kind = "misc", minMs = 250) {
  if (!window._fdvRpcLast) window._fdvRpcLast = new Map();
  const nowTs = now();
  const last = Number(window._fdvRpcLast.get(kind) || 0);
  const stress = rpcBackoffLeft();
  const jitter = Math.floor(Math.random() * 80);
  const wait = Math.max(0, last + minMs - nowTs) + Math.min(3000, stress) + jitter;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  window._fdvRpcLast.set(kind, now());
}
