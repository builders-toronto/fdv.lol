export const developer = true;









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

const toBool = (v, fallback = false) => {
  try {
    if (v == null) return fallback;
    const s = String(v).trim().toLowerCase();
    if (!s) return fallback;
    if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
    if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
    return fallback;
  } catch {
    return fallback;
  }
};

// Training/capture mode: stores redacted agent I/O for building fine-tune datasets.
// Enable via URL query (e.g. ?train_capture=1) or env (e.g. VITE_TRAIN_CAPTURE=1).
const _TRAIN_CAPTURE_ENABLED = getEnv([
  'VITE_TRAIN_CAPTURE',
  'TRAIN_CAPTURE',
  'FDV_TRAIN_CAPTURE',
  'train_capture',
], '');

const _TRAIN_CAPTURE_KEY = getEnv([
  'VITE_TRAIN_CAPTURE_KEY',
  'TRAIN_CAPTURE_KEY',
  'FDV_TRAIN_CAPTURE_KEY',
  'train_capture_key',
], 'fdv_gary_training_captures_v1');

const _TRAIN_CAPTURE_MAX = getEnv([
  'VITE_TRAIN_CAPTURE_MAX',
  'TRAIN_CAPTURE_MAX',
  'FDV_TRAIN_CAPTURE_MAX',
  'train_capture_max',
], 750);

const _TRAIN_CAPTURE_INCLUDE_BAD = getEnv([
  'VITE_TRAIN_CAPTURE_INCLUDE_BAD',
  'TRAIN_CAPTURE_INCLUDE_BAD',
  'FDV_TRAIN_CAPTURE_INCLUDE_BAD',
  'train_capture_include_bad',
], '0');

export const TRAINING_CAPTURE = {
  enabled: toBool(_TRAIN_CAPTURE_ENABLED, false),
  storageKey: String(_TRAIN_CAPTURE_KEY || 'fdv_gary_training_captures_v1'),
  // NOTE: We store primarily in IndexedDB (can be much larger). localStorage is a fallback and is small.
  // Keep both caps so datasets don't mysteriously shrink when the app is running normally.
  maxEntries: Math.max(25, Math.min(250_000, Math.floor(toNum(_TRAIN_CAPTURE_MAX, 750)))),
  maxEntriesLocalStorage: Math.max(25, Math.min(5000, Math.floor(toNum(_TRAIN_CAPTURE_MAX, 750)))),
  includeBad: toBool(_TRAIN_CAPTURE_INCLUDE_BAD, false),
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

export const FDV_FAV_ENDPOINT = "https://fdv-lol-metrics.fdvlol.workers.dev/api/shill/favleaderboard";

export const FDV_LEDGER_BASE = "https://fdv-lol-leaderboard.fdvlol.workers.dev";

export const FDV_LEDGER_URL = "https://fdv-lol-leaderboard.fdvlol.workers.dev/api/leaderboard/self?sort=sessionPnlSol&limit=25";

export const FDV_FEE_RECEIVER = "ENEKo7GEWM6jDTaHfN558bNHPodA9MB5azNiFvTK7ofm";

// fee bps (hundredths of a percent)
const _FDV_PLATFORM_FEE_BPS_RAW = getEnv(
  [
    "VITE_FDV_PLATFORM_FEE_BPS",
    "FDV_PLATFORM_FEE_BPS",
    "VITE_PLATFORM_FEE_BPS",
    "PLATFORM_FEE_BPS",
    "platform_fee_bps",
    "fee_bps",
  ],
  25,
);

export const FDV_PLATFORM_FEE_BPS = Math.max(0, Math.min(10_000, Math.floor(toNum(_FDV_PLATFORM_FEE_BPS_RAW, 25))));


// Jupiter API
// lite-api.jup.ag will be deprecated on 31 Jan 2026; api.jup.ag requires an API key.
export const JUP_API_BASE = String(getEnv([
  "VITE_JUP_API_BASE",
  "JUP_API_BASE",
  "FDV_JUP_API_BASE",
  "jup_api_base",
], "https://api.jup.ag")).replace(/\/+$/, "");

export const JUP_API_KEY = String(getEnv([
  "VITE_JUP_API_KEY",
  "JUP_API_KEY",
  "FDV_JUP_API_KEY",
  "jup_api_key",
], "")).trim();


export const JUP_SWAP   = (mint)=>`https://jup.ag/tokens/${encodeURIComponent(mint)}`;
export const JUP_LIST_TTL_MS = 60 * 60 * 1000;
export const EXPLORER   = (addr)=>`https://explorer.solana.com/address/${addr}`;


export const FALLBACK_LOGO = (sym)=>"data:image/svg+xml;utf8,"+encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='50' height='50'>
     <rect width='100%' height='100%' fill='#000'/>
     <text x='50%' y='54%' dominant-baseline='middle' text-anchor='middle'
           fill='#0aac4d' font-family='Arial' font-size='12'>${(sym||'?').slice(0,5)}</text>
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
  <h2>Privacy</h2>
  <p><b>Summary:</b> fdv.lol is primarily client-side. Most reads happen from your browser to third-party endpoints (Solana RPC, aggregators, market data). We minimize server-side storage, but some optional features require telemetry and abuse prevention.</p>

  <h3>What we process</h3>
  <ul>
    <li><b>Standard web logs:</b> IP address, user agent, path, referrer, timestamps (hosting/CDN/edge).</li>
    <li><b>Local device storage:</b> localStorage/sessionStorage for preferences, caching, and workflow state.</li>
    <li><b>Optional shill analytics:</b> event metadata (mint/slug/event) + URL/referrer/user agent; hashed IP/user-agent may be stored for abuse controls.</li>
    <li><b>Optional leaderboard/ledger:</b> your public wallet address + signed proof-of-control + the telemetry payload you choose to report (sanitized server-side).</li>
  </ul>

  <h3>High-risk note (private keys)</h3>
  <p>Some Auto workflows can import an Auto Wallet secret for local signing. If you use this, the secret may be stored in your browser storage on your device. Treat this as hot-wallet risk. Use a burner wallet and keep balances small.</p>

  <h3>Third parties</h3>
  <p>Depending on features used, you may interact with Solana RPC providers, Jupiter, market data providers (e.g., DEXScreener), Cloudflare Turnstile, and embedded content (e.g., YouTube/Giscus). These services may collect data under their own policies.</p>

  <p>Full policy: <a href="https://fdv.lol/onboard/policy.html" target="_blank" rel="noreferrer">fdv.lol/onboard/policy.html</a></p>
`;


export const TOS = `
  <h2>Terms</h2>
  <p><b>Not financial advice:</b> fdv.lol is a research/education and tooling project. You are responsible for your own decisions and trades.</p>

  <h3>No custody / no managed account</h3>
  <p>You control your keys and execution. We do not custody funds, and we are not an exchange, broker, or investment adviser.</p>

  <h3>Acceptable use</h3>
  <ul>
    <li>No unlawful activity, harassment, or attempts to compromise users/services.</li>
    <li>No abuse of third-party APIs (rate limits apply).</li>
    <li>No market manipulation (e.g., wash trading/spoofing/pump-and-dump).</li>
    <li>No sanctions/export-control violations; do not use where prohibited.</li>
  </ul>

  <h3>Warranty / liability</h3>
  <p>Provided “as is” and “as available” without warranty. Crypto is risky and automation amplifies mistakes; we do not guarantee accuracy, uptime, or outcomes.</p>

  <p>Full policy: <a href="https://fdv.lol/onboard/policy.html" target="_blank" rel="noreferrer">fdv.lol/onboard/policy.html</a></p>
`;

export const AGREEMENT = `
  <h2>Service Agreement</h2>
  <p>fdv.lol may change, break, or discontinue at any time. Features may be experimental and may rely on third-party infrastructure that can fail.</p>

  <h3>Availability</h3>
  <p>Best-effort only. Maintenance, upstream outages, network congestion, MEV conditions, and rate limits may impact functionality and execution.</p>

  <h3>Limitations</h3>
  <p>You accept the risks of using crypto software and automation. We are not responsible for trading outcomes, lost funds, or third-party actions/services.</p>

  <p>Full policy: <a href="https://fdv.lol/onboard/policy.html" target="_blank" rel="noreferrer">fdv.lol/onboard/policy.html</a></p>
`;