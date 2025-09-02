#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PAGES_ROOT  = process.cwd();
const OUT_DIR     = path.join(PAGES_ROOT, 'token'); // /token/<mint>/index.html
const STATIC_DIR  = path.join(process.cwd(), 'tools', 'static');
const MINTS_FILE  = path.join(STATIC_DIR, 'mints.json');
const BUILT_FILE  = path.join(STATIC_DIR, 'built.json');

const SITE_ORIGIN = (process.env.SITE_ORIGIN || '').replace(/\/+$/, '');
if (!SITE_ORIGIN) { console.error('SITE_ORIGIN env var is brokens'); process.exit(1); }

const REFRESH_HOURS     = Number(process.env.REFRESH_HOURS || 12); 
const MAX_PER_RUN       = Number(process.env.MAX_PER_RUN   || 150); 
const REQUEST_DELAY_MS  = Number(process.env.REQUEST_DELAY_MS || 120); 

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const esc = (s='') => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
const fileExists = (p) => { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } };
const loadJsonSafe = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

async function fetchDexToken(mint) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`dexscreener ${res.status}`);
  return res.json();
}

function pickBestPair(json) {
  const list = Array.isArray(json?.pairs) ? json.pairs : [];
  if (!list.length) return null;
  return list.slice().sort((a,b) => (a?.liquidity?.usd||0) - (b?.liquidity?.usd||0)).pop();
}

function ogHtml({ title, description, image, canonical }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">

<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">

<!-- Instant redirect for humans; bots ignore JS and keep OG -->
<meta http-equiv="refresh" content="0; url=${esc(canonical)}">

<style>
  :root { color-scheme: dark light; }
  html,body{background:#071117;color:#cfe8f1;font-family:ui-sans-serif,system-ui,sans-serif;margin:0;min-height:100%}
  .wrap{display:grid;place-items:center;min-height:100vh;text-align:center;padding:24px}
  a{color:#7aedff;text-decoration:none;border-bottom:1px dotted rgba(122,222,255,.5)}
  a:hover{border-bottom-style:solid}
</style>
</head>
<body>
  <div class="wrap">
    <h1>${esc(title)}</h1>
    <p>${esc(description)}</p>
    <p><a href="${esc(canonical)}">Continue</a></p>
  </div>
</body>
</html>`;
}

async function buildOne(mint) {
  let title = 'Token on Solana';
  let desc  = 'View token details, price, liquidity and pairs.';
  let img   = `https://fdv.lol/src/assets/images/fdv.lol.png`;

  try {
    const json = await fetchDexToken(mint);
    const best = pickBestPair(json);
    if (best) {
      const symbol = best?.baseToken?.symbol || 'Token';
      const name   = best?.baseToken?.name || symbol;
      const price  = Number.isFinite(+best?.priceUsd) ? `$${(+best.priceUsd).toFixed(6)}` : '—';
      const liq    = Number.isFinite(+best?.liquidity?.usd) ? `$${Math.round(+best.liquidity.usd).toLocaleString()}` : '—';
      title = `${symbol} on Solana`;
      desc  = `${name} • Price: ${price} • Liquidity: ${liq}`;
      img   = best?.info?.imageUrl || img;
    }
  } catch {
    // keep defaults on failure 
  }

  const canonical = `${SITE_ORIGIN}/token/${encodeURIComponent(mint)}`;

  const html = ogHtml({ title, description: desc, image: img, canonical });
  const outDir  = path.join(OUT_DIR, mint);
  const outFile = path.join(outDir, 'index.html');
  ensureDir(outDir);
  fs.writeFileSync(outFile, html, 'utf8');
  return outFile;
}

async function main() {
  ensureDir(OUT_DIR);
  ensureDir(STATIC_DIR);

  if (!fs.existsSync(MINTS_FILE)) {
    console.error(`Missing ${MINTS_FILE}.`);
    process.exit(1);
  }

  let mints = loadJsonSafe(MINTS_FILE, []);
  if (!Array.isArray(mints)) mints = [];
  mints = [...new Set(mints.map(String))];

  const built = loadJsonSafe(BUILT_FILE, {}); 
  const now = Date.now();
  const maxAgeMs = REFRESH_HOURS * 3600_000;

  const work = [];
  for (const mint of mints) {
    const outFile = path.join(OUT_DIR, mint, 'index.html');
    const lastTs = built[mint] || 0;
    const fresh = (now - lastTs) < maxAgeMs;
    const exists = fileExists(outFile);
    if (!exists || !fresh) {
      work.push(mint);
      if (work.length >= MAX_PER_RUN) break;
    }
  }

  console.log(`Mints total: ${mints.length}`);
  console.log(`To (re)build (max ${MAX_PER_RUN}, age > ${REFRESH_HOURS}h or missing): ${work.length}`);

  let ok = 0, fail = 0;
  for (const [i, mint] of work.entries()) {
    try {
      await buildOne(mint);
      built[mint] = Date.now();
      ok++;
    } catch (e) {
      console.warn('Failed:', mint, e.message);
      fail++;
    }
    if ((i+1) % 25 === 0) console.log(`  …processed ${i+1}/${work.length}`);
    if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
  }

  fs.writeFileSync(BUILT_FILE, JSON.stringify(built, null, 2));
  console.log(`Done. OK=${ok} Fail=${fail}. Output → /token/<mint>/index.html`);
}

main().catch(err => { console.error(err); process.exit(1); });
