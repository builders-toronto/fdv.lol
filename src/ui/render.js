import { MAX_CARDS } from '../config/env.js';
import { coinCard } from './cards.js';
import { adCard } from '../ads/load.js';

export const elCards = document.getElementById('cards');
export const elMeta  = document.getElementById('meta');
export const elQ     = document.getElementById('q');
export const elSort  = document.getElementById('sort');
export const elRefresh = document.getElementById('refresh');
export const elRelax = document.getElementById('relax');

export function render(items, adPick) {
  const sort = elSort.value;
  items = [...items];
  items.sort((a,b)=>{
    if (sort==='volume') return b.volume.h24 - a.volume.h24;
    if (sort==='liquidity') return b.liquidityUsd - a.liquidityUsd;
    if (sort==='change24') return b.change.h24 - a.change.h24;
    return b.score - a.score;
  });

  items = items.slice(0, MAX_CARDS);

  if (!items.length){
    elCards.innerHTML = `<div class="small">No matches. Try “relax filter”, different sort, or refresh.</div>`;
    return;
  }
  elCards.innerHTML = items.map(coinCard).join('');

  const adHtml = adPick ? adCard(adPick) : '';
  elCards.innerHTML = adHtml + items.map(coinCard).join('');
}

export function renderSkeleton(n=8){
  elCards.innerHTML = '';
  for (let i=0;i<n;i++){
    const d=document.createElement('div');
    d.className='card';
    d.innerHTML=`
      <div class="top">
        <div class="logo skel"></div>
        <div style="flex:1">
          <div class="sym skel" style="height:14px;width:120px;border-radius:6px"></div>
          <div class="addr skel" style="height:10px;width:160px;margin-top:6px;border-radius:6px"></div>
        </div>
        <div class="rec skel" style="width:60px;height:22px"></div>
      </div>
      <div class="metrics" style="margin-top:10px">
        ${Array.from({length:6}).map(()=>`<div class="kv"><div class="k skel" style="height:10px;border-radius:5px"></div><div class="v skel" style="height:14px;margin-top:6px;border-radius:6px"></div></div>`).join('')}
      </div>`;
    elCards.appendChild(d);
  }
}