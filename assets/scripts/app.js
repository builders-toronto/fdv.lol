const CACHE_TTL_MS = 90_000; 
const MAX_CARDS = 21;
const MEME_REGEX = /(bonk|wif|dog|inu|pepe|cat|meme|ponk|ponke|samo|pipi|bodi|boden|beer|mog|pop|paws|purry|purr|kitty|kit|meow|woof|hamster|frog|toad|snek|sponge|bob|smurf|dino|monke|monkey|ape|corgi|floki|elon|keem|pump|dump|poo|poop|turd|goat|degen|baby|wife|husband|shib|shiba|giga|sigma|skib|rizz|reno)/i;
const RANK_WEIGHTS = { volume:0.35, liquidity:0.25, momentum:0.20, activity:0.20 };
const BUY_RULES = { score:0.65, liq:50_000, vol24:100_000, change1h:0 };
const FDV_LIQ_PENALTY = { ratio:150, penalty:0.10 };
const JUP_SWAP = (mint)=>`https://jup.ag/tokens/${encodeURIComponent(mint)}`;
const EXPLORER = (address)=>`https://explorer.solana.com/address/${address}`;
const FALLBACK_LOGO = (sym)=>"data:image/svg+xml;utf8,"+encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='38' height='38'><rect width='100%' height='100%' fill='#0b111d'/><text x='50%' y='54%' dominant-baseline='middle' text-anchor='middle' fill='#7bd7ff' font-family='Arial' font-size='12'>${(sym||'?').slice(0,5)}</text></svg>`);

const clamp=(x,min,max)=>Math.max(min,Math.min(max,x));
const nz=(v,d=0)=>Number.isFinite(+v)?+v:d;
const normLog=(v,div=6)=>clamp(Math.log10(Math.max(v,1)+1)/div,0,1);
const pct=(x)=> (x==null||isNaN(x))? '—' : `${x>0?'+':''}${x.toFixed(2)}%`;
const shortAddr=(m)=>m.slice(0,4)+'…'+m.slice(-4);
const ts=()=>new Date().toISOString();

async function getJSON(url, {timeout=8000}={}) {
  const ctrl = new AbortController();
  const id = setTimeout(()=>ctrl.abort(), timeout);
  try{
    const r = await fetch(url, {signal: ctrl.signal});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(id); }
}

async function fetchTrending(){ return []; }

async function fetchSearches() {
  const terms = [
    'solana pepe','solana dog','solana wif','solana bonk','solana cat',
    'solana frog','solana shib','solana meme','solana snek','solana bob',
    'solana new','solana trending','solana pump', 'solana dump', 'solana inu',
    'solana elon', 'solana floki', 'solana corgi', 'solana monke', 'solana ape',
    'solana dino', 'solana purr', 'solana purry', 'solana kitty', 'solana paws',
    'solana toad', 'solana hamster', 'solana doge', 'solana shiba', 'solana giga',
    'solana sigma', 'solana baby', 'solana wife', 'solana husband', 'solana reno'
  ];
  const urls = terms.map(t=>`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(t)}`);
  const results = await Promise.allSettled(urls.map(u => getJSON(u).then(x => x?.pairs || [])));
  const out=[]; const seen=new Set();
  for (const r of results) if (r.status==='fulfilled') for (const p of r.value) {
    if (p.chainId!=='solana') continue;
    const id = p.pairAddress || p.url || `${p.baseToken?.address}:${p.dexId}`;
    if (!seen.has(id)) { seen.add(id); out.push(p); }
  }
  return out;
}

async function fetchJupiterTokens() {
  try {
    const arr = await getJSON('https://tokens.jup.ag/tokens', {timeout: 10000});
    const map = {};
    for (const t of (arr||[])) {
      if (!t?.address) continue;
      map[t.address] = {
        name: t.name, symbol: t.symbol, logoURI: t.logoURI,
        website: t.extensions?.website || null
      };
    }
    return map;
  } catch { return {}; }
}

function isMemecoin(name,symbol, relax=false){
  return relax ? true : MEME_REGEX.test((name||'')+' '+(symbol||''));
}

function xSearchUrl(symbol, name, mint){
  const sym = (symbol || '').toUpperCase().replace(/[^A-Z0-9]/g,'');
  const parts = [];

  if (sym) {
    parts.push(`$${sym}`, `#${sym}`, `${sym} solana`);
  }
  if (name && name.toLowerCase() !== sym.toLowerCase()) {
    parts.push(`"${name}" solana`);
  }

  if (mint) parts.push(`"${mint}"`);

  const q = parts.join(' OR ');
  return `https://x.com/search?q=${encodeURIComponent(q)}&f=live&src=typed_query`;
}

function platformFromUrl(u){
  try{
    const h = new URL(u).hostname.replace(/^www\./,'').toLowerCase();
    if (/(^|\.)(x\.com|twitter\.com)$/.test(h)) return 'x';
    if (/(^|\.)t\.me$/.test(h)) return 'telegram';
    if (/(^|\.)(discord\.gg|discord\.com)$/.test(h)) return 'discord';
    if (/(^|\.)(github\.com)$/.test(h)) return 'github';
    if (/(^|\.)(medium\.com)$/.test(h)) return 'medium';
    if (/(^|\.)(youtube\.com|youtu\.be)$/.test(h)) return 'youtube';
    if (/(^|\.)(instagram\.com)$/.test(h)) return 'instagram';
    if (/(^|\.)(reddit\.com)$/.test(h)) return 'reddit';
    if (/(^|\.)(coingecko\.com)$/.test(h)) return 'coingecko';
    if (/(^|\.)(linktr\.ee)$/.test(h)) return 'linktree';
    if (/(^|\.)(docs\.|gitbook\.io)$/.test(h)) return 'docs';
    return 'website';
  }catch{return 'website'}
}

function normalizeSocial(s){
  const p = (s.platform || s.type || '').toLowerCase().trim();
  const url = (s.url || '').trim();
  const handle = (s.handle || s.username || '').replace(/^@/,'').trim();

  let platform = p;
  let href = url || null;

  if (!href && handle){
    switch(p){
      case 'twitter': case 'x': href = `https://twitter.com/${handle}`; platform='x'; break;
      case 'telegram': href = `https://t.me/${handle}`; break;
      case 'discord':  href = `https://discord.gg/${handle}`; break;
      case 'github':   href = `https://github.com/${handle}`; break;
      default: href = /^https?:\/\//i.test(handle) ? handle : `https://${handle}`;
    }
  }

  if (!platform && href) platform = platformFromUrl(href);
  if (!href) return null;
  return { platform, href };
}

function iconFor(platform){
  const svg = (d)=>`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">${d}</svg>`;
  const stroke = `stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`;

  switch((platform||'').toLowerCase()){
    case 'x': case 'twitter':
      return svg(`<path fill="currentColor" d="M18.146 2H21L13.5 10.33 22 22h-6.146l-5.218-6.86L4.6 22H2l8.053-9.443L2 2h6.3l4.728 6.203L18.146 2Zm-2.154 18h1.658L7.983 4H6.249l9.743 16Z"/>`);
    case 'telegram':
      return svg(`<path ${stroke} d="M21 3 3 11l6 2 9-7-7 9-2 6 3-4 4 3L21 3z"/>`);
    case 'discord':
      return svg(`<path fill="currentColor" d="M20 5.6a16 16 0 0 0-4-1.4l-.3.7a12.5 12.5 0 0 0-7.4 0l-.3-.7A16 16 0 0 0 4 5.6C2.6 9 2.4 12.4 2.7 16a16 16 0 0 0 5 2.6l.7-1.1a10.7 10.7 0 0 1-1.7-.8l.4-.3c3.3 1.6 6.8 1.6 10 0l.5.3-1.7.8.7 1.1A16 16 0 0 0 21.3 16c.3-3.6.1-7-1.3-10.4ZM9.7 13.6c-.8 0-1.5-.8-1.5-1.7s.7-1.7 1.5-1.7c.9 0 1.5.8 1.5 1.7s-.6 1.7-1.5 1.7Zm4.6 0c-.9 0-1.5-.8-1.5-1.7s.6-1.7 1.5-1.7 1.5.8 1.5 1.7-.7 1.7-1.5 1.7Z"/>`);
    case 'github':
      return svg(`<path ${stroke} d="M9 19c-5 1.5-5-2.5-7-3m14 6v-4a4 4 0 0 0-1-2.6c3 0 6-1.5 6-6a4.7 4.7 0 0 0-1.3-3.3 5 5 0 0 0-.1-3.1S17.4.9 14.9 2.7a12 12 0 0 0-6 0C6.4.9 5.3 1.3 5.3 1.3a5 5 0 0 0-.1 3.1A4.7 4.7 0 0 0 3.9 7c0 4.5 3 6 6 6-.5.5-.8 1.3-.8 2.4V22"/>`);
    case 'medium':
      return svg(`<path fill="currentColor" d="M2 7l4 1 5 9 5-9 4-1-4 2v7l4 2H3l4-2V9L2 7z"/>`);
    case 'youtube':
      return svg(`<path fill="currentColor" d="M23 12s0-4-1-5c-1-2-3-2-7-2H9C5 5 3 5 2 7c-1 1-1 5-1 5s0 4 1 5c1 2 3 2 7 2h6c4 0 6 0 7-2 1-1 1-5 1-5Zm-13 4V8l6 4-6 4Z"/>`);
    case 'instagram':
      return svg(`<rect ${stroke} x="3" y="3" width="18" height="18" rx="5"/><path ${stroke} d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37Z"/><path fill="currentColor" d="M17.5 6.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z"/>`);
    case 'reddit':
      return svg(`<path ${stroke} d="M22 12a10 10 0 1 1-9.4-10M14 2l2 4M8.5 13.5h.01M15.5 13.5h.01M8 16c1.5 1 6.5 1 8 0"/>`);
    case 'coingecko':
      return svg(`<path ${stroke} d="M21 12a9 9 0 1 1-9-9"/><circle cx="15" cy="9" r="1.5" fill="currentColor"/>`);
    case 'linktree':
      return svg(`<path ${stroke} d="M12 2v20M7 7l5 4 5-4M7 12h10M8 17h8"/>`);
    case 'docs':
      return svg(`<path ${stroke} d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12V8l-4-6z"/><path ${stroke} d="M14 2v6h6"/>`);
    case 'website':
    default:
      return svg(`<path ${stroke} d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"/><path ${stroke} d="M3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>`);
  }
}

function normalizeWebsite(u){
  if(!u) return null;
  u = String(u).trim();
  if(!/^https?:\/\//i.test(u)) u = 'https://' + u; 
  try { return new URL(u).href; } catch { return null; }
}


function bestPerToken(pairs, {relax=false}={}) {
  const bucket = new Map();
  for (const p of pairs) {
    const base = p.baseToken||{};
    const mint = base.address;
    if (!mint) continue;

    const name   = base.name||'';
    const symbol = base.symbol||'';
    if (!isMemecoin(name, symbol, relax)) continue;

    const info = p.info || {};
    const website = Array.isArray(info.websites) && info.websites.length ? info.websites[0].url : null;
    const socials = Array.isArray(info.socials) ? info.socials : [];
    const logoURI = info.imageUrl || null;

    const vol24 = nz(p.volume?.h24 ?? p.volume24h);
    const liq   = nz(p.liquidity?.usd ?? p.liquidityUsd);

    const cand = {
      mint,
      name: name || symbol || mint,
      symbol,
      logoURI,                
      website,                
      socials,                
      priceUsd: nz(p.priceUsd ?? p.price?.usd),
      change: {
        m5:  nz(p.priceChange?.m5  ?? p.priceChange5m),
        h1:  nz(p.priceChange?.h1  ?? p.priceChange1h),
        h6:  nz(p.priceChange?.h6  ?? p.priceChange6h),
        h24: nz(p.priceChange?.h24 ?? p.priceChange24h),
      },
      volume: { h24: vol24 },
      txns: { h24: nz((p.txns?.h24?.buys||0) + (p.txns?.h24?.sells||0)) },
      fdv: nz(p.fdv),
      liquidityUsd: liq,
      dex: p.dexId || '',
      pairUrl: p.url || '',
      pairAddress: p.pairAddress || ''
    };

    const prev = bucket.get(mint);
    if (!prev) { bucket.set(mint, cand); continue; }
    if (vol24 > prev.volume.h24 || (vol24 === prev.volume.h24 && liq > prev.liquidityUsd)) {
      bucket.set(mint, cand);
    }
  }
  return [...bucket.values()];
}

function scoreAndRecommend(rows){
  for (const r of rows){
    const vol24 = nz(r.volume.h24), liq = nz(r.liquidityUsd), fdv = nz(r.fdv);
    const ch1 = nz(r.change.h1), ch6 = nz(r.change.h6), ch24 = nz(r.change.h24), ch5 = nz(r.change.m5);
    const tx = nz(r.txns.h24);

    const nVol = normLog(vol24,6);
    const nLiq = normLog(liq,6);
    const momRaw  = clamp((ch1+ch6+ch24)/100, -1, 1);
    const nMom  = momRaw>0 ? momRaw : momRaw*0.5; 
    const nAct = normLog(tx,4);

    let score = RANK_WEIGHTS.volume*nVol + RANK_WEIGHTS.liquidity*nLiq
              + RANK_WEIGHTS.momentum*nMom + RANK_WEIGHTS.activity*nAct;

    let penaltyApplied = false;
    if (liq>0 && fdv/Math.max(liq,1) > FDV_LIQ_PENALTY.ratio) { score -= FDV_LIQ_PENALTY.penalty; penaltyApplied=true; }
    score = clamp(score,0,1);

    let rec='AVOID', why=['Weak composite score'];
    if (score>=BUY_RULES.score && liq>=BUY_RULES.liq && vol24>=BUY_RULES.vol24 && ch1>BUY_RULES.change1h) {
      rec='BUY'; why=['Strong composite score'];
      if (ch1>0) why.push('Positive 1h momentum');
      if (ch24>0) why.push('Up over 24h');
      if (liq>0) why.push('Healthy liquidity');
      if (vol24>0) why.push('Active trading volume');
    } else if (score>=0.40) {
      rec='WATCH'; why=['Decent composite score'];
      if (ch1<0) why.push('Short-term dip (entry risk)');
      if (penaltyApplied) why.push('FDV/liquidity imbalance');
    } else {
      if (ch24<0) why.push('Down over 24h');
      if (liq<25_000) why.push('Thin liquidity');
      if (vol24<50_000) why.push('Low trading activity');
    }

    r.score=score; r.recommendation=rec; r.why=why;
    r._norm = { nVol, nLiq, nMom: clamp((nMom+1)/2,0,1), nAct }; // normalize mom to 0..1 for bars
    r._chg  = [ch5, ch1, ch6, ch24]; // for sparkline
  }
  return rows.sort((a,b)=> b.score-a.score || b.volume.h24-a.volume.h24);
}


const elCards = document.getElementById('cards');
const elMeta  = document.getElementById('meta');
const elQ     = document.getElementById('q');
const elSort  = document.getElementById('sort');
const elRefresh = document.getElementById('refresh');
const elRelax = document.getElementById('relax');

function renderSkeleton(n=8){
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

function sparklineSVG(changes, {w=120, h=32}={}){
  const vals = (changes||[]).map(v => Number.isFinite(v)? v : 0);
  const n = vals.length || 1;
  const min = Math.min(0, ...vals), max = Math.max(0, ...vals);
  const span = (max - min) || 1;
  const xStep = w / (n - 1 || 1);
  const y = v => h - ((v - min) / span) * h;

  let d = '';
  for (let i=0;i<n;i++){
    const X = i * xStep;
    const Y = y(vals[i]);
    d += (i===0?`M${X},${Y}`:` L${X},${Y}`);
  }
  const midY = y(0);
  return `
<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
  <path d="M0 ${midY} H ${w}" stroke="rgba(123,215,255,.25)" stroke-width="1" fill="none"/>
  <path d="${d}" stroke="var(--neon,#7bd7ff)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

function barsHTML(norm){
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

function pctChipsHTML(changes){
  const labels = ['5m','1h','6h'];
  const arr = Array.isArray(changes) ? changes : [];
  const spans = labels.map((lab, i) => {
    const v = +arr[i];
    if (!Number.isFinite(v)) {
      return `<span class="pct flat" title="${lab} change unavailable">—</span>`;
    }
    const cls = v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
    return `<span class="pct ${cls}" title="${lab} change">${pct(v)}</span>`;
  });
  return `<div class="pctrow">${spans.join('')}</div>`;
}


function coinCard(it){
  const logo = it.logoURI || FALLBACK_LOGO(it.symbol);
  const website = normalizeWebsite(it.website) || EXPLORER(it.mint);
  const buyUrl = JUP_SWAP(it.mint);

  const links = (Array.isArray(it.socials) ? it.socials : [])
    .map(normalizeSocial)
    .filter(Boolean)
    .reduce((acc, s) => { if(!acc.some(x=>x.href===s.href)) acc.push(s); return acc; }, [])
    .slice(0, 6);

  let socialsHtml = links.map(s =>
    `<a class="iconbtn" href="${s.href}" target="_blank" rel="noopener nofollow"
        aria-label="${s.platform}" data-tooltip="${s.platform}">
        ${iconFor(s.platform)}
     </a>`
  ).join('');

  if (!links.length) {
    const xUrl = xSearchUrl(it.symbol, it.name, it.mint);
    socialsHtml =
      `<a class="iconbtn" href="${xUrl}" target="_blank" rel="noopener nofollow"
          aria-label="Search on X" data-tooltip="Search ${it.symbol ? '$'+it.symbol.toUpperCase() : 'on X'}">
          ${iconFor('x')}
       </a>`;
  }

  const micro = `
    <div class="micro">
      ${pctChipsHTML(it._chg)}
      ${sparklineSVG(it._chg)}
    </div>`;

  return `
<article class="card" data-hay="${(it.symbol||'')+' '+(it.name||'')+' '+it.mint}">
  <div class="top">
    <div class="logo"><img src="${logo}" alt=""></div>
    <div style="flex:1">
      <div class="sym">${it.symbol || ''} <span class="badge">${(it.dex||'').toUpperCase()}</span></div>
      <div class="addr"><a href="${EXPLORER(it.mint)}" target="_blank" rel="noopener">Mint: ${shortAddr(it.mint)}</a></div>
    </div>
    <div class="rec ${it.recommendation}">${it.recommendation}</div>
  </div>

  <div class="metrics">
    <div class="kv"><div class="k">Price</div><div class="v">${it.priceUsd? ('$'+Number(it.priceUsd).toLocaleString(undefined,{maximumFractionDigits:6})) : '—'}</div></div>
    <div class="kv"><div class="k">Trending Score</div><div class="v">${Math.round(it.score*100)} / 100</div></div>
    <div class="kv"><div class="k">24h Volume</div><div class="v">${fmtUsd(it.volume.h24)}</div></div>
    <div class="kv"><div class="k">Liquidity</div><div class="v">${fmtUsd(it.liquidityUsd)}</div></div>
    <div class="kv"><div class="k">FDV</div><div class="v">${it.fdv? fmtUsd(it.fdv) : '—'}</div></div>
    <div class="kv"><div class="k">Pair</div><div class="v">${it.pairUrl? `<a href="${it.pairUrl}" target="_blank" rel="noopener">DexScreener</a>`:'—'}</div></div>
  </div>

  ${socialsHtml ? `<div class="actions">${socialsHtml}</div>` : ''}

  <div class="actions">
    <a class="btn swapCoin" href="${buyUrl}" target="_blank" rel="noopener">Swap</a>
    <a class="btn" href="${website}" target="_blank" rel="noopener">Website</a>
  </div>

  ${micro}
</article>`;
}


function fmtUsd(x){
  const v = nz(x);
  if (v>=1e9) return '$'+(v/1e9).toFixed(2)+'B';
  if (v>=1e6) return '$'+(v/1e6).toFixed(2)+'M';
  if (v>=1e3) return '$'+(v/1e3).toFixed(2)+'k';
  return '$'+v.toFixed(2);
}

let CURRENT_AD = null;

function render(items){
  // sort
  const sort = elSort.value;
  items = [...items];
  items.sort((a,b)=>{
    if (sort==='volume') return b.volume.h24 - a.volume.h24;
    if (sort==='liquidity') return b.liquidityUsd - a.liquidityUsd;
    if (sort==='change24') return b.change.h24 - a.change.h24;
    return b.score - a.score;
  });

  // cap
  items = items.slice(0, MAX_CARDS);

  if (!items.length){
    elCards.innerHTML = `<div class="small">No matches. Try “relax filter”, different sort, or refresh.</div>`;
    return;
  }
  elCards.innerHTML = items.map(coinCard).join('');

  const adHtml = CURRENT_AD ? adCard(CURRENT_AD) : '';
  elCards.innerHTML = adHtml + items.map(coinCard).join('');
}

const CACHE_KEY = 'sol-meme-ultralite-cache-v1';
function readCache(){
  try{
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (Date.now()-o.ts > CACHE_TTL_MS) return null;
    return o.payload;
  }catch{return null;}
}
function writeCache(payload){
  try{ localStorage.setItem(CACHE_KEY, JSON.stringify({ts:Date.now(), payload})) }catch{}
}

async function enrichMissingInfo(items) {
  const lacking = items.filter(it => !it.logoURI && !it.website).map(it => it.mint);
  if (!lacking.length) return items;

  const batch = lacking.slice(0, 30).join(',');
  try {
    const url = `https://api.dexscreener.com/tokens/v1/solana/${batch}`;
    const resp = await getJSON(url, {timeout: 10000});
    const arr = Array.isArray(resp) ? resp : (Array.isArray(resp?.pairs) ? resp.pairs : []);

    const byMint = new Map();
    for (const entry of arr) {
      const base = entry.baseToken || {};
      const info = entry.info || {};
      if (!base.address) continue;
      const website = Array.isArray(info.websites) && info.websites.length ? info.websites[0].url : null;
      const socials = Array.isArray(info.socials) ? info.socials : [];
      const logoURI = info.imageUrl || null;
      if (logoURI || website || socials.length) {
        byMint.set(base.address, {logoURI, website, socials});
      }
    }

    for (const it of items) {
      const add = byMint.get(it.mint);
      if (add) {
        it.logoURI ||= add.logoURI;
        it.website ||= add.website;
        if ((!it.socials || !it.socials.length) && add.socials?.length) it.socials = add.socials;
      }
    }
  } catch {}
  return items;
}

const ADS_CACHE_KEY = 'fdv-ads-cache-v1';
const ADS_CACHE_MS  = 5 * 60 * 1000;

function readInlineAds(){
  try{
    const el = document.getElementById('ads-data');
    if (!el) return null;
    const arr = JSON.parse(el.textContent || '[]');
    return Array.isArray(arr) ? arr : null;
  }catch{ return null; }
}

async function loadAds(){
  const now = Date.now();
  try{
    const raw = JSON.parse(localStorage.getItem(ADS_CACHE_KEY) || 'null');
    if (raw && (now - raw.ts < ADS_CACHE_MS)) return raw.data;
  }catch{}

  let ads = null;
  try{
    ads = await getJSON('/ads.json', {timeout: 6000});
  }catch{
    ads = readInlineAds();
  }
  if (!Array.isArray(ads)) ads = [];

  try{ localStorage.setItem(ADS_CACHE_KEY, JSON.stringify({ts:now, data:ads})) }catch{}
  return ads;
}

function pickAd(ads){
  const last = (localStorage.getItem('fdv-ads-last')||'').trim();
  const pool = ads
    .filter(a => a && a.mint)
    .map(a => ({...a, weight: Math.max(1, +a.weight || 1)}));

  if (!pool.length) return null;

  const filtered = pool.length > 1 ? pool.filter(a => a.mint !== last) : pool;
  const total = filtered.reduce((s,a)=>s+a.weight, 0);
  let r = Math.random() * total;
  for (const a of filtered){
    if ((r -= a.weight) <= 0){
      try{ localStorage.setItem('fdv-ads-last', a.mint) }catch{}
      return a;
    }
  }
  return filtered[0];
}

function renderAdIcons(socials){
  if (!Array.isArray(socials)) return '';
  const links = socials.map(normalizeSocial).filter(Boolean);
  if (!links.length) return '';
  return `<div class="adicons">
    ${links.map(s => `
      <a class="iconbtn" href="${s.href}" target="_blank" rel="noopener nofollow"
         aria-label="${s.platform}" data-tooltip="${s.platform}">
         ${iconFor(s.platform)}
      </a>`).join('')}
  </div>`;
}

function AD_JUP_URL(mint){ return JUP_SWAP(mint); } 

function adCard(ad){
  const logo = ad.logo || FALLBACK_LOGO(ad.symbol);
  const title = (ad.symbol || ad.name || 'Sponsored').toString();
  const website = normalizeWebsite(ad.website) || EXPLORER(ad.mint);
  const cta = ad.cta || 'Trade';
  const icons = renderAdIcons(ad.socials || []);

  const buyUrl = AD_JUP_URL(ad.mint);

  return `
  <section class="adcard" role="complementary" aria-label="Sponsored">
    <div class="adrow">
      <div class="adlogo"><img src="${logo}" alt=""></div>

      <div class="admain">
        <div class="adtitle">
          <div class="sym">${title}</div>
          <div class="mint"><a href="${EXPLORER(ad.mint)}" target="_blank" rel="noopener">Mint: ${shortAddr(ad.mint)}</a></div>
          ${icons}
        </div>
        ${ad.tagline ? `<div class="adtagline">${ad.tagline}</div>` : ''}
      </div>

      <div class="adactions">
        <div class="adtag" title="Sponsored">SPONSORED</div>
        <a class="adbtn primary" href="${buyUrl}" target="_blank" rel="noopener"><span class="ademoji">🔄</span> ${cta}</a>
        <a class="adbtn" href="${website}" target="_blank" rel="noopener"><span class="ademoji">🌐</span> Website</a>
      </div>
    </div>
  </section>`;
}

const elLoader = document.getElementById('loader');

function showLoading() {
  if (elLoader) elLoader.hidden = false;
  document.documentElement.style.overflow = 'hidden';
}

function hideLoading() {
  if (elLoader) elLoader.hidden = true;
  document.documentElement.style.overflow = '';
}

async function pipeline({force=false}={}) {
  const relax = elRelax.checked;
  const cached = !force && readCache();
  if (cached) {
    elMeta.textContent = `Generated: ${cached.generatedAt}`;
    render(cached.items);
    return;
  }

  showLoading();
  renderSkeleton(8);
  elMeta.textContent = `Fetching…`;

  try {
    const adsPromise = loadAds();

    const [trend, searches] = await Promise.all([
      fetchTrending(),
      fetchSearches()
    ]);

    const merged = [...trend, ...searches];
    let tokens = bestPerToken(merged, {relax});
    tokens = await enrichMissingInfo(tokens);
    const scored = scoreAndRecommend(tokens);

    try {
      const ads = await adsPromise;
      CURRENT_AD = pickAd(ads);
    } catch {
      CURRENT_AD = null;
    }

    const payload = {
      generatedAt: ts(),
      items: scored,
      _ts: Date.now()
    };
    writeCache(payload);

    elMeta.textContent = `Generated: ${payload.generatedAt}`;
    render(scored);
  } catch (err) {
    console.error('pipeline failed', err);
    elCards.innerHTML = `<div class="small">Couldn't load data. Check your connection or try Refresh.</div>`;
    elMeta.textContent = '';
  } finally {
    hideLoading();
  }
}

elSort.addEventListener('change', ()=>render(readCache()?.items||[]));
elRefresh.addEventListener('click', ()=>pipeline({force:true}));
elRelax.addEventListener('change', ()=>pipeline({force:true}));

pipeline();