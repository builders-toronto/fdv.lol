export const CACHE_TTL_MS = 90_000; 
export const CACHE_KEY = 'sol-meme-ultralite-cache-v1';
export const MAX_CARDS = 21;
export const MEME_REGEX = /(bonk|wif|dog|inu|pepe|cat|meme|ponk|ponke|samo|pipi|bodi|boden|beer|mog|pop|paws|purry|purr|kitty|kit|meow|woof|hamster|frog|toad|snek|sponge|bob|smurf|dino|monke|monkey|ape|corgi|floki|elon|keem|pump|dump|poo|poop|turd|goat|degen|baby|wife|husband|shib|shiba|giga|sigma|skib|rizz|reno)/i;
export const RANK_WEIGHTS = { volume:0.35, liquidity:0.25, momentum:0.20, activity:0.20 };
export const BUY_RULES = { score:0.65, liq:50_000, vol24:100_000, change1h:0 };
export const FDV_LIQ_PENALTY = { ratio:150, penalty:0.10 };
export const JUP_SWAP = (mint)=>`https://jup.ag/tokens/${encodeURIComponent(mint)}`;
export const EXPLORER = (address)=>`https://explorer.solana.com/address/${address}`;
export const FALLBACK_LOGO = (sym)=>"data:image/svg+xml;utf8,"+encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='38' height='38'><rect width='100%' height='100%' fill='#0b111d'/><text x='50%' y='54%' dominant-baseline='middle' text-anchor='middle' fill='#7bd7ff' font-family='Arial' font-size='12'>${(sym||'?').slice(0,5)}</text></svg>`);
export const ADS_CACHE_KEY = 'fdv-ads-cache-v1';
export const ADS_CACHE_MS  = 5 * 60 * 1000;

export const clamp=(x,min,max)=>Math.max(min,Math.min(max,x));
export const nz=(v,d=0)=>Number.isFinite(+v)?+v:d;
export const normLog=(v,div=6)=>clamp(Math.log10(Math.max(v,1)+1)/div,0,1);
export const pct=(x)=> (x==null||isNaN(x))? '—' : `${x>0?'+':''}${x.toFixed(2)}%`;
export const shortAddr=(m)=>m.slice(0,4)+'…'+m.slice(-4);
export const ts=()=>new Date().toISOString();

export const GISCUS = {
  repo:        (window.GISCUS_REPO        || "builders-toronto/fdv.lol"),
  repoId:      (window.GISCUS_REPO_ID     || "R_kgDOPnY0_Q"),
  category:    (window.GISCUS_CATEGORY    || "Show and tell"),
  categoryId:  (window.GISCUS_CATEGORY_ID || "DIC_kwDOPnY0_c4Cu2mD"),
  theme:       (window.GISCUS_THEME       || "dark"),
};

export const MEME_KEYWORDS = [
    'pepe','dog','wif','bonk','reno',
    // 'frog','shib','meme','snek','bob',
    // 'new','trending','pump','dump','inu',
    // 'elon','floki','corgi','monke','ape',
    // 'dino','purr','purry','kitty','paws',
    // 'toad','hamster','doge','shiba','giga',
    // 'sigma','baby','wife','husband','reno',
];

