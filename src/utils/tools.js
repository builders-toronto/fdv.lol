import { MEME_REGEX, CACHE_KEY, nz } from '../config/env.js';

const elLoader = document.getElementById('loader');

export function fmtUsd(x){
  const v = nz(x);
  if (v>=1e9) return '$'+(v/1e9).toFixed(2)+'B';
  if (v>=1e6) return '$'+(v/1e6).toFixed(2)+'M';
  if (v>=1e3) return '$'+(v/1e3).toFixed(2)+'k';
  return '$'+v.toFixed(2);
}

export async function getJSON(url, {timeout=8000}={}) {
  const ctrl = new AbortController();
  const id = setTimeout(()=>ctrl.abort(), timeout);
  try{
    const r = await fetch(url, {signal: ctrl.signal});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(id); }
}

export function isMemecoin(name,symbol, relax=false){
  return relax ? true : MEME_REGEX.test((name||'')+' '+(symbol||''));
}

export function showLoading() {
  if (elLoader) elLoader.hidden = false;
  document.documentElement.style.overflow = 'hidden';
}

export function hideLoading() {
  if (elLoader) elLoader.hidden = true;
  document.documentElement.style.overflow = '';
}

export function readCache(){
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