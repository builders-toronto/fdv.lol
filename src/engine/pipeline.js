import { ts } from '../config/env.js';
import { fetchDexscreener, streamDexscreener } from '../data/dexscreener.js'; 
import { fetchTrending } from '../data/solana.js';
import { bestPerToken, scoreAndRecommend } from '../core/calculate.js';
import { renderSkeleton, elRelax, elMeta, elCards  } from '../ui/render.js';
import { readCache, writeCache } from '../utils/tools.js';
import { enrichMissingInfo } from '../utils/normalize.js';
import { loadAds, pickAd } from '../ads/load.js';

let CURRENT_AD = null;
let CURRENT_RUN = null; 

function debounce(fn, ms=200){
  let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), ms); };
}

export async function pipeline({force=false, stream=true, timeboxMs=10_000} = {}) {
  if (CURRENT_RUN?.abort) { try { CURRENT_RUN.abort(); } catch {} }
  const ac = new AbortController();
  CURRENT_RUN = ac;

  const relax = elRelax.checked;
  const cached = !force && readCache();
  if (!stream && cached) {
    elMeta.textContent = `Generated: ${cached.generatedAt}`;
    return cached.items;
  }

  renderSkeleton(8);
  elMeta.textContent = `Fetching…`;

  const adsPromise = loadAds().catch(()=>null);
  const trendingPromise = fetchTrending().catch(()=>[]); 

  const seenPairs = new Set();
  let allPairs = [];           
  let lastRenderedCount = 0;   
  let finalCached = null;

  const flush = debounce(async () => {
    try {
      const solSearches = await Promise.resolve(trendingPromise);
      const merged = [...allPairs, ...solSearches];

      let tokens = bestPerToken(merged, { relax });
      tokens = await enrichMissingInfo(tokens);
      const scored = scoreAndRecommend(tokens);
      if (CURRENT_AD === null) {
        try {
          const ads = await adsPromise;
          CURRENT_AD = ads ? pickAd(ads) : null;
        } catch { CURRENT_AD = null; }
      }

      finalCached = {
        generatedAt: ts(),
        items: scored,
        _ts: Date.now(),
      };

      elMeta.textContent = `Updating… ${merged.length} pairs`;
      lastRenderedCount = merged.length;
    } catch (e) {
      console.warn('stream flush error', e);
    }
  }, 300);

  try {
    if (!stream) {
      const [trend, searches] = await Promise.all([
        fetchDexscreener(), trendingPromise
      ]);
      const merged = [...trend, ...searches];
      let tokens = bestPerToken(merged, { relax });
      tokens = await enrichMissingInfo(tokens);
      const scored = scoreAndRecommend(tokens);
      try {
        const ads = await adsPromise;
        CURRENT_AD = ads ? pickAd(ads) : null;
      } catch { CURRENT_AD = null; }
      const payload = { generatedAt: ts(), items: scored, _ts: Date.now() };
      writeCache(payload);
      elMeta.textContent = `Generated: ${payload.generatedAt}`;
      return { items: scored, ad: CURRENT_AD };
    }

    const startTs = Date.now();

    const streamer = (async () => {
      for await (const { newPairs } of streamDexscreener({ signal: ac.signal })) {

        let pushed = 0;
        for (const p of newPairs) {
          const id = p.pairAddress || p.url || `${p.baseToken?.address}:${p.dexId}`;
          if (!id || seenPairs.has(id)) continue;
          seenPairs.add(id);
          allPairs.push(p);
          pushed++;
        }
        if (pushed > 0) flush(); 
      }
    })();

    let timebox;
    if (timeboxMs > 0) {
      timebox = new Promise(resolve => setTimeout(resolve, timeboxMs)).then(() => ac.abort('timebox'));
    }






    await Promise.race([streamer, timebox].filter(Boolean));

  
    await new Promise(r => setTimeout(r, 10));
    await flush();

    if (lastRenderedCount === 0) {
      const solSearches = await Promise.resolve(trendingPromise);
      allPairs = solSearches.slice();
      await flush();
    }
    if (finalCached) writeCache(finalCached);
    elMeta.textContent = `Generated: ${finalCached?.generatedAt || ts()}`;

    return { items: finalCached?.items || [], ad: CURRENT_AD };
  } catch (err) {
    if (ac.signal.aborted) {
      elMeta.textContent = `Stopped.`;
      return { items: finalCached?.items || [], ad: CURRENT_AD };
    }
    console.error('pipeline failed', err);
    elCards.innerHTML = `<div class="small">Couldn't load data. Check your connection or try Refresh.</div>`;
    elMeta.textContent = '';
    throw err;
  }
}
