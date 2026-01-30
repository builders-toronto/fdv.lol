import { getJSON } from '../core/tools.js'
import { JUP_API_BASE, JUP_API_KEY } from '../config/env.js'

const JUP_TRENDING_BASE = `${String(JUP_API_BASE || "https://api.jup.ag").replace(/\/+$/, "")}/tokens/v2/toptrending`;

const WIN_TO_FIELD = {
  '5m': 'stats5m',
  '1h': 'stats1h',
  '6h': 'stats6h',
  '24h': 'stats24h',
};

function asNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeDateMs(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : null;
}

function wKey(window) {
  // map to your internal shorthand used by the model (m5, h1, h6, h24)
  if (window === '5m') return 'm5';
  if (window === '1h') return 'h1';
  if (window === '6h') return 'h6';
  if (window === '24h') return 'h24';
  return 'm5';
}

function pickStats(t, window) {
  const field = WIN_TO_FIELD[window] || 'stats5m';
  return t?.[field] || {};
}

function buildVolumes(t) {
  // return totals for each window based on (buyVolume + sellVolume)
  const s5 = t?.stats5m || {};
  const s1 = t?.stats1h || {};
  const s6 = t?.stats6h || {};
  const s24 = t?.stats24h || {};
  return {
    m5:  asNum(s5.buyVolume)  + asNum(s5.sellVolume)  || null,
    h1:  asNum(s1.buyVolume)  + asNum(s1.sellVolume)  || null,
    h6:  asNum(s6.buyVolume)  + asNum(s6.sellVolume)  || null,
    h24: asNum(s24.buyVolume) + asNum(s24.sellVolume) || null,
  };
}

function buildTx(t) {
  const s5 = t?.stats5m || {};
  const s1 = t?.stats1h || {};
  const s6 = t?.stats6h || {};
  const s24 = t?.stats24h || {};
  return {
    m5:  { buys: s5.numBuys  || 0, sells: s5.numSells  || 0 },
    h1:  { buys: s1.numBuys  || 0, sells: s1.numSells  || 0 },
    h6:  { buys: s6.numBuys  || 0, sells: s6.numSells  || 0 },
    h24: { buys: s24.numBuys || 0, sells: s24.numSells || 0 },
  };
}

function mapTrendingTokenToModel(t, headlineWindow = '5m') {
  const base = {
    address: t?.id || t?.mint || t?.address,
    symbol: t?.symbol || '',
    name: t?.name || '',
  };

  const info = {
    imageUrl: t?.icon || t?.logoURI || t?.logo || '',
    header: null, // not provided by endpoint
    websites: (t?.website ? [t.website] : []),
    socials: (t?.twitter ? [t.twitter] : []),
  };

  // "best" rolls up the headline window’s view
  const s = pickStats(t, headlineWindow);
  const best = {
    dexId: 'jup',
    url: '',
    priceUsd: t?.usdPrice,
    priceNative: null, // not provided
    priceChange: {
      m5:  asNum(t?.stats5m?.priceChange),
      h1:  asNum(t?.stats1h?.priceChange),
      h6:  asNum(t?.stats6h?.priceChange),
      h24: asNum(t?.stats24h?.priceChange),
    },
    liquidity: {
      usd: asNum(t?.liquidity),
      base: null, // split not provided
      quote: null,
    },
    fdv: asNum(t?.fdv),
    marketCap: asNum(t?.mcap),
    boosts: { active: 0 }, // not provided
  };

  const vols = buildVolumes(t);
  const txs = buildTx(t);

  const earliest = safeDateMs(t?.firstPool?.createdAt);
  const list = [
    {
      dexId: 'jup',
      url: '',
      priceUsd: asNum(t?.usdPrice),
      priceNative: null,
      priceChange: {
        m5:  asNum(t?.stats5m?.priceChange),
        h1:  asNum(t?.stats1h?.priceChange),
        h6:  asNum(t?.stats6h?.priceChange),
        h24: asNum(t?.stats24h?.priceChange),
      },
      volume: {
        h24: vols.h24,
      },
      liquidity: {
        usd: asNum(t?.liquidity),
      },
      pairCreatedAt: t?.firstPool?.createdAt || null,
    },
  ];

  const v = (k) => vols[k] ?? null;
  const tx = (k) => txs[k] ?? { buys: 0, sells: 0 };

  const model = {
    mint: base.address,
    symbol: base.symbol || "",
    name: base.name || "",
    imageUrl: info.imageUrl,
    headerUrl: info.header,

    priceUsd: asNum(best?.priceUsd),
    priceNative: asNum(best?.priceNative),
    change5m: asNum(best?.priceChange?.m5),
    change1h: asNum(best?.priceChange?.h1),
    change6h: asNum(best?.priceChange?.h6),
    change24h: asNum(best?.priceChange?.h24),
    liquidityUsd: asNum(best?.liquidity?.usd),
    liquidityBase: asNum(best?.liquidity?.base),
    liquidityQuote: asNum(best?.liquidity?.quote),
    fdv: asNum(best?.fdv ?? best?.marketCap),
    marketCap: asNum(best?.marketCap ?? best?.fdv),
    boostsActive: best?.boosts?.active ?? 0,

    v5mTotal: v("m5"),
    v1hTotal: v("h1"),
    v6hTotal: v("h6"),
    v24hTotal: v("h24"),
    tx5m: tx("m5"),
    tx1h: tx("h1"),
    tx6h: tx("h6"),
    tx24h: tx("h24"),
    ageMs: Number.isFinite(earliest) ? (Date.now() - earliest) : null,

    headlineDex: best?.dexId,
    headlineUrl: best?.url,

    websites: info.websites || [],
    socials: info.socials || [],

    pairs: list.map(p => ({
      dexId: p.dexId,
      url: p.url,
      priceUsd: asNum(p.priceUsd),
      priceNative: asNum(p.priceNative),
      change5m: asNum(p?.priceChange?.m5),
      change1h: asNum(p?.priceChange?.h1),
      change6h: asNum(p?.priceChange?.h6),
      change24h: asNum(p?.priceChange?.h24),
      v24h: asNum(p?.volume?.h24),
      liquidityUsd: asNum(p?.liquidity?.usd),
      pairCreatedAt: p?.pairCreatedAt,
    })),
  };

  model.liqToFdvPct = (Number.isFinite(model.liquidityUsd) && Number.isFinite(model.fdv) && model.fdv > 0)
    ? (model.liquidityUsd / model.fdv) * 100 : null;

  model.volToLiq24h = (Number.isFinite(model.v24hTotal) && Number.isFinite(model.liquidityUsd) && model.liquidityUsd > 0)
    ? (model.v24hTotal / model.liquidityUsd) : null;

  model.buySell24h = (model.tx24h.buys + model.tx24h.sells) > 0
    ? model.tx24h.buys / (model.tx24h.buys + model.tx24h.sells) : null;

  return model;
}

export async function fetchJupiterTrendingModels({ window = '5m', limit = 50, signal } = {}) {
  // Avoid hard-failing the main feed if the user hasn't configured a key.
  // Auto bot widgets enforce the key separately.
  if (!String(JUP_API_KEY || "").trim()) return [];
  const url = `${JUP_TRENDING_BASE}/${encodeURIComponent(window)}?limit=${encodeURIComponent(limit)}`;
  const data = await getJSON(url, {
    signal,
    timeout: 15_000,
    headers: { accept: 'application/json', 'x-api-key': String(JUP_API_KEY || "").trim() },
  });
  const arr = Array.isArray(data) ? data : [];
  return arr
    .map(t => mapTrendingTokenToModel(t, window))
    .filter(m => !!m.mint);
}
