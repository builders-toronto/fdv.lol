const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);

const ENV =
  (typeof import.meta !== 'undefined' && import.meta.env) ||
  (typeof process !== 'undefined' && process.env) ||
  (typeof window !== 'undefined' && (window.ENV || window.__ENV__)) ||
  {}; // last resort

let URLQ = {};
try {
  if (typeof window !== 'undefined' && window.location && window.location.search) {
    URLQ = Object.fromEntries(new URLSearchParams(window.location.search).entries());
  }
} catch { /* noop */ }

function getEnv(keys, fallback) {
  const list = Array.isArray(keys) ? keys : [keys];
  for (const k of list) {
    if (has(URLQ, k) || has(URLQ, String(k).toLowerCase())) {
      return URLQ[k] ?? URLQ[String(k).toLowerCase()];
    }
    if (has(ENV, k)) return ENV[k];
  }
  return fallback;
}

export const toNum = (v, fallback = 0) => {
  if (v == null) return fallback;
  if (typeof v === 'string') v = v.replace(/[%_,\s]/g, ''); 
  const num = Number(v);
  return Number.isFinite(num) ? num : fallback;
};

export const CACHE_TTL_MS = 90_000;
export const CACHE_KEY = 'sol-meme-ultralite-cache-v1';
export const MAX_CARDS = 21;
export const MEME_REGEX = /(bonk|wif|dog|inu|pepe|cat|meme|ponk|ponke|samo|pipi|bodi|boden|beer|mog|pop|paws|purry|purr|kitty|kit|meow|woof|hamster|frog|toad|snek|sponge|bob|smurf|dino|monke|monkey|ape|corgi|floki|elon|keem|pump|dump|poo|poop|turd|goat|degen|baby|wife|husband|shib|shiba|giga|sigma|skib|rizz|reno)/i;
export const RANK_WEIGHTS = { volume:0.35, liquidity:0.25, momentum:0.20, activity:0.20 };

const BUY_LIQ        = getEnv(['VITE_BUY_LIQ','BUY_LIQ','FDV_BUY_LIQ','liq'],        2500);
const BUY_VOL24      = getEnv(['VITE_BUY_VOL24','BUY_VOL24','FDV_BUY_VOL24','vol24'], 50000);
const BUY_CHANGE_1H  = getEnv(['VITE_BUY_CHANGE1H','BUY_CHANGE1H','change1h'],       0);
const FDV_LIQ_RATIO  = getEnv(['VITE_FDV_LIQ_RATIO','FDV_LIQ_RATIO','fdv_liq_ratio'], 50);

export const BUY_RULES = {
  liq:      toNum(BUY_LIQ, 2500),        // USD
  vol24:    toNum(BUY_VOL24, 50000),     // USD
  change1h: toNum(BUY_CHANGE_1H, 0),     // percent points (e.g., 0.5 => +0.5%)
};

export const FDV_LIQ_PENALTY = {
  ratio: Math.max(1, toNum(FDV_LIQ_RATIO, 50)), // 50 => need ≥ 2% liq/fdv
};
export const BIRDEYE_API_KEY = "";

export const SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
export const FDV_METRICS_BASE = "https://fdv-lol-metrics.fdvlol.workers.dev";
export const FDV_TURNSTILE_BASE = "https://solana-rpc-proxy.fdvlol.workers.dev";

export const FDV_FEE_RECEIVER = "ENEKo7GEWM6jDTaHfN558bNHPodA9MB5azNiFvTK7ofm";

export const JUP_SWAP   = (mint)=>`https://jup.ag/tokens/${encodeURIComponent(mint)}`;
export const JUP_LIST_TTL_MS = 60 * 60 * 1000;
export const EXPLORER   = (addr)=>`https://explorer.solana.com/address/${addr}`;


export const FALLBACK_LOGO = (sym)=>"data:image/svg+xml;utf8,"+encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='38' height='38'>
     <rect width='100%' height='100%' fill='#0b111d'/>
     <text x='50%' y='54%' dominant-baseline='middle' text-anchor='middle'
           fill='#7bd7ff' font-family='Arial' font-size='12'>${(sym||'?').slice(0,5)}</text>
   </svg>`
);


export const ADS_CACHE_KEY = 'fdv-ads-cache-v1';
export const ADS_CACHE_MS  = 5 * 60 * 1000;

export const clamp=(x,min,max)=>Math.max(min,Math.min(max,x));
export const nz=(v,d=0)=>Number.isFinite(+v)?+v:d;
export const normLog=(v,div=6)=>clamp(Math.log10(Math.max(v,1)+1)/div,0,1);
export const pct=(x)=> (x==null||isNaN(x))? '—' : `${x>0?'+':''}${x.toFixed(2)}%`;
export const shortAddr=(m)=>m.slice(0,4)+'…'+m.slice(-4);
export const ts=()=>new Date().toISOString();

export const GISCUS = {
  repo:        (typeof window !== 'undefined' && (window.GISCUS_REPO        || "builders-toronto/fdv.lol")),
  repoId:      (typeof window !== 'undefined' && (window.GISCUS_REPO_ID     || "R_kgDOPnY0_Q")),
  category:    (typeof window !== 'undefined' && (window.GISCUS_CATEGORY    || "Show and tell")),
  categoryId:  (typeof window !== 'undefined' && (window.GISCUS_CATEGORY_ID || "DIC_kwDOPnY0_c4Cu2mD")),
  theme:       (typeof window !== 'undefined' && (window.GISCUS_THEME       || "dark")),
};

export const MEME_KEYWORDS = [
  'pepe','dog','wif','bonk','reno',
  'frog','shib','meme','snek','bob',
  'new','trending','pump','dump','inu',
  'elon','floki','corgi','monke','ape',
  'dino','purr','purry','kitty','paws',
  'toad','hamster','doge','shiba','giga',
  'sigma','baby','wife','husband',
];

export const PRIVACY = `
  <h2>Privacy Policy</h2>
  <p>We do not run servers that store your browsing data. The app fetches public on-chain/market data directly in your browser. Basic, anonymized telemetry may be measured via static hosting (e.g., GitHub Pages/CDN logs). Do not share secrets.</p>

  <h3>Data Sources</h3>
  <ul>
    <li>Public market APIs (e.g., price/liquidity/volume)</li>
    <li>Static site hosting logs (aggregate)</li>
    <li><em>Development-only (opt-in):</em> Microsoft Clarity (heatmaps/session replays) and an in-page click heatmap, used strictly to debug UX during development. These are disabled by default and never run in production unless explicitly enabled.</li>
  </ul>

  <h3>Cookies/Storage</h3>
  <p>We may use localStorage/sessionStorage for caching UI preferences and response data to improve speed.</p>

  <h3>Development-only telemetry</h3>
  <p>Clarity and the in-page heatmap are used only during development to improve UX.</p>
`;


export const TOS = `
  <h2>Terms of Service</h2>
  <p>FDV.lol is an informational tool. It is <strong>not financial advice</strong>. Use at your own risk.</p>
  <h3>Use</h3>
  <ul>
    <li>No scraping/abuse of rate-limited services.</li>
    <li>No attempts to compromise the app or users.</li>
    <li>Respect third-party API terms.</li>
  </ul>
  <h3>Warranty</h3>
  <p>Provided “as is” without warranty. We do not guarantee accuracy or uptime.</p>
`;

export const AGREEMENT = `
  <h2>Service Agreement</h2>
  <p>By using FDV.lol you agree that the service may change or discontinue at any time without notice.</p>
  <h3>Availability</h3>
  <p>Service is best-effort. Maintenance, API rate limits, or upstream outages may impact functionality.</p>
  <h3>Limitations</h3>
  <p>We are not responsible for trading outcomes, lost funds, or third-party actions.</p>
`;