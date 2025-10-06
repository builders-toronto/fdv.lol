const memory = new Map();          // key -> { value, ts, ttl, err?, errTs? }
const inflight = new Map();        // key -> Promise
const tags = new Map();            // tag -> Set(keys) (optional grouping)
const DEFAULT_TTL_MS = 15_000;
const ERROR_TTL_MS = 3_000;        // negative cache window
const MAX_ENTRIES = 800;           // LRU-ish soft cap
const JITTER_PCT = 0.15;

const metrics = {
  hits: 0,
  staleServed: 0,
  misses: 0,
  errors: 0,
  negativeHits: 0,
  evicted: 0,
};

function jitter(ttl){
  if (!ttl) return ttl;
  const delta = ttl * JITTER_PCT;
  return Math.round(ttl - Math.random() * delta);
}

function lruEvictIfNeeded() {
  if (memory.size <= MAX_ENTRIES) return;
  const arr = [...memory.entries()]
    .sort((a,b) => a[1].ts - b[1].ts);
  const drop = Math.ceil(arr.length * 0.1); // evict 10%
  for (let i=0;i<drop;i++){
    memory.delete(arr[i][0]);
    metrics.evicted++;
  }
}

export async function swrFetch(
  key,
  fetcher,
  {
    ttl = DEFAULT_TTL_MS,
    mustFresh = false,
    timeoutMs = 15_000,
    signal,
    tag,           // optional grouping tag
    allowNegative = true,
  } = {}
) {
  const now = Date.now();
  const rec = memory.get(key);

  // Negative cache hit
  if (rec?.err && allowNegative) {
    if (now - rec.errTs < ERROR_TTL_MS) {
      metrics.negativeHits++;
      throw rec.err;
    }
  }

  // ffreshness check
  if (rec?.value && !mustFresh) {
    if (now - rec.ts <= ttl) {
      metrics.hits++;
      return rec.value;
    }
    // stale while revalidate
    metrics.staleServed++;
    revalidate(key, fetcher, { ttl, timeoutMs, signal, tag });
    return rec.value;
  }

  // Deduplicate
  if (inflight.has(key)) {
    metrics.hits++;
    return inflight.get(key);
  }

  metrics.misses++;
  const p = (async () => {
    try {
      const val = await runWithTimeout(fetcher, timeoutMs, signal);
      memory.set(key, { value: val, ts: Date.now(), ttl: jitter(ttl) });
      if (tag) indexTag(tag, key);
      lruEvictIfNeeded();
      return val;
    } catch (e) {
      metrics.errors++;
      // Record negative cache
      memory.set(key, { ...(rec || {}), err: e, errTs: Date.now(), ts: rec?.ts || 0, ttl });
      throw e;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}

async function revalidate(key, fetcher, opts) {
  if (inflight.has(key)) return;
  const { ttl = DEFAULT_TTL_MS, timeoutMs = 15_000, signal, tag } = opts || {};
  const p = (async () => {
    try {
      const val = await runWithTimeout(fetcher, timeoutMs, signal);
      memory.set(key, { value: val, ts: Date.now(), ttl: jitter(ttl) });
      if (tag) indexTag(tag, key);
      lruEvictIfNeeded();
    } catch (e) {
      metrics.errors++;
      const rec = memory.get(key) || {};
      memory.set(key, { ...rec, err: e, errTs: Date.now() });
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
}

function runWithTimeout(fetcher, ms, signal) {
  if (!ms) return fetcher();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("fetch_timeout")), ms);
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
    Promise.resolve()
      .then(fetcher)
      .then(v => {
        if (aborted) return;
        clearTimeout(t);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(v);
      })
      .catch(e => {
        if (aborted) return;
        clearTimeout(t);
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(e);
      });
  });
}

function indexTag(tag, key) {
  let set = tags.get(tag);
  if (!set) {
    set = new Set();
    tags.set(tag, set);
  }
  set.add(key);
}

// Public helpers
export function clearCache(prefix = "") {
  for (const k of memory.keys()) {
    if (!prefix || k.startsWith(prefix)) {
      memory.delete(k);
    }
  }
}

export function clearTag(tag) {
  const set = tags.get(tag);
  if (!set) return;
  for (const k of set) memory.delete(k);
  tags.delete(tag);
}

export function forceRevalidate(key, fetcher, opts) {
  return revalidate(key, fetcher, opts);
}

export function getCacheMetrics() {
  return { ...metrics, size: memory.size, inflight: inflight.size };
}

export function primeCache(key, value, { ttl = DEFAULT_TTL_MS, tag } = {}) {
  memory.set(key, { value, ts: Date.now(), ttl: jitter(ttl) });
  if (tag) indexTag(tag, key);
  lruEvictIfNeeded();
}

export function getCachedValue(key) {
  return memory.get(key)?.value;
}
