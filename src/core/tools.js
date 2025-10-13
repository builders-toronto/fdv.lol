import { MEME_REGEX, CACHE_KEY, nz } from '../config/env.js';
import { swrFetch } from './fetcher.js';

const elLoader = document.getElementById('loader');

const REQUEST_TIMEOUT  = 10_000;
const MAX_RETRIES      = 4;
const BASE_BACKOFF_MS  = 600;

const CACHE_VERSION = 'v1';

export function fmtUsd(x){
  const v = nz(x);
  if (v>=1e9) return '$'+(v/1e9).toFixed(2)+'B';
  if (v>=1e6) return '$'+(v/1e6).toFixed(2)+'M';
  if (v>=1e3) return '$'+(v/1e3).toFixed(2)+'k';
  return '$'+v.toFixed(2);
}

export async function getJSON(
  url,
  {
    timeout = 8000,
    ttl = 15000,
    cache = true,
    mustFresh = false,
    tag = 'json'
  } = {}
){
  async function raw() {
    const ctrl = new AbortController();
    const id = setTimeout(()=>ctrl.abort(), timeout);
    try{
      const r = await fetch(url, { signal: ctrl.signal });
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(id);
    }
  }
  if (!cache) return raw();
  return swrFetch(
    `v1|json:${ttl}:${url}`,
    raw,
    { ttl, mustFresh, timeoutMs: timeout, tag }
  );
}

let pipelineApiPromise;
async function getPipelineApi() {
  if (!pipelineApiPromise) {
    pipelineApiPromise = import('../engine/pipeline.js').catch(() => ({}));
  }
  return pipelineApiPromise;
}

export async function fetchDS(url, { signal, ttl, priority = false } = {}) {
  const key = `${CACHE_VERSION}|dex:${url}`;
  const fetcher = priority
    ? () => getJSON(url, { signal, headers: { accept: 'application/json' } })
    : () => fetchWithRetries(url, { signal });

  let releaseFn = null;

  try {
    if (priority) {
      const pipeline = await getPipelineApi();
      if (typeof pipeline?.throttleGlobalStream === "function") {
        pipeline.throttleGlobalStream("dex-priority", 2000);
        releaseFn = pipeline.releaseGlobalStreamThrottle?.bind(pipeline);
      }
    }
    return swrFetch(key, fetcher, { ttl });
  } finally {
    try {
      if (releaseFn) releaseFn();
    } catch {}
  }
}

async function fetchWithRetries(url, { signal } = {}) {
  let attempt = 0;

  while (true) {
    attempt++;

    await limiter.removeToken();

    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(new Error('timeout')), REQUEST_TIMEOUT);

    const linkAbort = () => ac.abort(signal.reason);
    if (signal) {
      if (signal.aborted) ac.abort(signal.reason);
      else signal.addEventListener('abort', linkAbort, { once: true });
    }

    try {
      const data = await getJSON(url, { signal: ac.signal, headers: { accept: 'application/json' } });
      clearTimeout(to);
      limiter.onSuccess();
      return data;
    } catch (err) {
      clearTimeout(to);

      const isAbort = err?.name === 'AbortError' || /timeout/i.test(String(err?.message || ''));
      const status = err?.status ?? (/\b(\d{3})\b/.exec(String(err?.message))?.[1] | 0);
      const retryable = isAbort || status === 429 || (status >= 500 && status < 600);

      if (!retryable || attempt > MAX_RETRIES) {
        throw err;
      }

      let raMs = 0;
      const retryAfter = err?.headers?.get?.('Retry-After');
      if (retryAfter) {
        const n = Number(retryAfter);
        raMs = Number.isFinite(n) ? n * 1000 : 0;
      }
      limiter.on429(raMs);

      const backoff = raMs || jitter(BASE_BACKOFF_MS * Math.pow(2, attempt - 1));
      await sleep(backoff);
    }
  }
}

export function isMemecoin(name,symbol, relax=false){
  return relax ? true : MEME_REGEX.test((name||'')+' '+(symbol||''));
}

export function showLoading() {
  if (elLoader) elLoader.hidden = false;
  document.documentElement.style.overflow = 'hidden';
}

export function hideLoading() {
  if (elLoader) elLoader.style.display = 'none';
  document.documentElement.style.overflow = '';
}

export function readCache(){ //broken
  try{
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (Date.now()-o.ts > CACHE_TTL_MS) return null;
    return o.payload;
  }catch{return null;}
}

export function writeCache(payload){
  try{ localStorage.setItem(CACHE_KEY, JSON.stringify({ts:Date.now(), payload})) }catch{}
}

export async function fetchJsonNoThrow(url, { signal, headers } = {}) {
  try {
    const res = await fetch(url, { signal, headers });
    if (!res.ok) return { ok: false, status: res.status, json: null };
    return { ok: true, status: res.status, json: await res.json() };
  } catch {
    return { ok: false, status: 0, json: null };
  }
}

export function normalizeWebsite(u){
  if(!u) return null;
  u = String(u).trim();
  if(!/^https?:\/\//i.test(u)) u = 'https://' + u; 
  try { return new URL(u).href; } catch { return null; }
}

function jitter(ms) { return Math.floor(ms * (0.5 + Math.random())); }
