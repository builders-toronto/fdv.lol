const memory = new Map();          
const inflight = new Map();        
const DEFAULT_TTL_MS = 15_000;      

export async function swrFetch(key, fetcher, { ttl = DEFAULT_TTL_MS } = {}) {
  const now = Date.now();
  const cached = memory.get(key);

  if (cached?.value) {
    if (now - cached.ts > ttl) revalidate(key, fetcher, ttl);
    return cached.value;
  }

  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    const fresh = await fetcher();
    memory.set(key, { value: fresh, ts: Date.now(), ttl });
    inflight.delete(key);
    return fresh;
  })();

  inflight.set(key, p);
  return p;
}

async function revalidate(key, fetcher, ttl) {
  if (inflight.has(key)) return;
  const p = (async () => {
    try {
      const fresh = await fetcher();
      memory.set(key, { value: fresh, ts: Date.now(), ttl });
    } finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
}

export function clearCache(prefix = "") {
  for (const k of memory.keys()) if (k.startsWith(prefix)) memory.delete(k);
}
