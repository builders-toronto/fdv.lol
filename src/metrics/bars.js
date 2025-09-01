import { clamp } from '../config/env.js';

export function barsHTML(norm){
  const toPct = v => Math.round(clamp(v,0,1)*100);
  const vol = toPct(norm?.nVol ?? 0), liq = toPct(norm?.nLiq ?? 0), mom = toPct(norm?.nMom ?? 0), act = toPct(norm?.nAct ?? 0);
  return `
  <div class="bars" title="V: ${vol}% · L: ${liq}% · M: ${mom}% · A: ${act}%">
    <div class="bar" data-k="volume"><i style="height:${vol}%"></i><label>V</label></div>
    <div class="bar" data-k="liquidity"><i style="height:${liq}%"></i><label>L</label></div>
    <div class="bar" data-k="momentum"><i style="height:${mom}%"></i><label>M</label></div>
    <div class="bar" data-k="activity"><i style="height:${act}%"></i><label>A</label></div>
  </div>`;
}
