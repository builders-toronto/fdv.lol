import { ts, MEME_KEYWORDS } from '../config/env.js';
import { fetchDexscreener, streamDexscreener } from '../data/dexscreener.js'; 
import { fetchTrending } from '../data/solana.js';
import { bestPerToken, scoreAndRecommend } from '../core/calculate.js';
import { renderSkeleton, elRelax, elMeta, elMetaBase, elCards  } from '../views/meme/page.js';
import { readCache, writeCache } from '../utils/tools.js';
import { enrichMissingInfo } from '../data/normalize.js';
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
    elMetaBase.textContent = `Generated: ${cached.generatedAt}`;
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

      if (typeof onUpdate === 'function') {
        onUpdate({ items: finalCached.items, ad: CURRENT_AD });
      }

      elMeta.textContent = `Scanning.. ${merged.length} pairs`;
      lastRenderedCount = merged.length;

      elMeta.textContent = `Scanning... ${merged.length} pairs`;
      lastRenderedCount = merged.length;
    } catch (e) {
      elMeta.textContent = `Stream error: ${merged.length}`;
    } finally {
      elMeta.textContent = `Scanning.`;
      elMetaBase.textContent = `Generated: ${Date.now()}`;
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
      if (typeof onUpdate === 'function') onUpdate({ items: scored, ad: CURRENT_AD });
      return { items: scored, ad: CURRENT_AD };
    }

    const startTs = Date.now();

    let windowOffset = (pipeline._offset || 0) % MEME_KEYWORDS.length;
    pipeline._offset = windowOffset + 40; 

    const streamer = (async () => {
      for await (const { term, newPairs } of streamDexscreener({
        signal: ac.signal,
        windowSize: 40,
        windowOffset,
        requestBudget: 60,
        maxConcurrent: 2,
        spacingMs: 150,
      })) {
        let pushed = 0;
        for (const p of newPairs) {
          const id = p.pairAddress || p.url || `${p.baseToken?.address}:${p.dexId}`;
          if (!id || seenPairs.has(id)) continue;
          seenPairs.add(id);
          allPairs.push(p);
          pushed++;
        }
        if (pushed > 0) flush();
        elMeta.textContent = `Searching… ${seenPairs.size} pairs • term: ${term}`;
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
if (typeof onUpdate === 'function') onUpdate({ items: finalCached?.items || [], ad: CURRENT_AD });
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
