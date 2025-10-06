import { MEME_REGEX, CACHE_KEY, nz } from '../config/env.js';
import { swrFetch } from '../core/fetcher.js';

const elLoader = document.getElementById('loader');

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
