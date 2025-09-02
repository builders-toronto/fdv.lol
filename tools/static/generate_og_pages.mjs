#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

/* ----------------------------- helpers: io/img ----------------------------- */

async function downloadToFile(url, destPath) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const ab = await res.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(ab));
  return destPath;
}

async function makeOgImage(
  inputPath,
  outputPath,
  {
    titleText = 'Token • Name',
    metrics = [
      ['💸 Price', '$0.0000'],
      ['💧 Liquidity', '$0'],
      ['🏷️ FDV', '$0'],
      ['🧪 L/F', '0.00%'],
      ['📈 24h', '+0.00%'],
      ['📊 Vol24h', '$0']
    ],

    canvas = { w: 1200, h: 630, bg: '#000000ff' },
    panel  = { w: 980, h: 400, r: 24, padX: 28, padY: 24 },

    logoMax = 128,
    logoOffset = { dx: 15, dy: 10 },

    fonts = {
      family: 'DejaVu-Sans',
      familyBold: 'DejaVu-Sans-Bold',
      titleSize: 66,
      labelSize: 34,
      valueSize: 30,
      lineGap: 14,
      labelW: 200
    },
    colors = {
      panel: 'rgba(0, 0, 0, 0.78)',
      title: '#ffffff',
      label: '#a9e7f2',
      value: '#ffffff',
      divider: 'rgba(34, 34, 34, 0.2)'
    }
  } = {}
) {
  async function hasCmd(cmd){ try{ await execFileP(cmd, ['-version']); return true; } catch{ return false; } }
  const hasMagick = await hasCmd('magick');
  const bin = hasMagick ? 'magick' : 'convert';

  const px = Math.round((canvas.w - panel.w) / 2);
  const py = Math.round((canvas.h - panel.h) / 2);
  const panelX2 = px + panel.w;
  const panelY2 = py + panel.h;

  const titleBoxW = panel.w - panel.padX * 2;
  const titleBoxH = 70;

  const metricsTop = py + panel.padY + titleBoxH + 10;
  const lineH = fonts.valueSize + fonts.lineGap;

  const args = [
    // bg
    '-size', `${canvas.w}x${canvas.h}`, `canvas:${canvas.bg}`,
    // rounded panel
    '-fill', colors.panel,
    '-draw', `roundrectangle ${px},${py} ${panelX2},${panelY2} ${panel.r},${panel.r}`
  ];

  // logo (keeps aspect, only downscale; no stretching)
  args.push(
    '(',
      inputPath + '[0]',
      '-auto-orient',
      '-resize', `${logoMax}x${logoMax}>`,
    ')',
    '-gravity', 'NorthWest',
    '-geometry', `+${px + logoOffset.dx}+${py + logoOffset.dy + 20}`,
    '-compose', 'over', '-composite'
  );

  // title (center)
  args.push(
    '(',
      '-background', 'none',
      '-fill', colors.title,
      '-font', fonts.family,
      '-pointsize', String(fonts.titleSize),
      '-size', `${titleBoxW}x${titleBoxH}`,
      '-gravity', 'center',
      `caption:${titleText}`,
    ')',
    '-gravity', 'North',
    `-geometry`, `+0+${py + panel.padY}`,
    '-composite'
  );

  // metrics rows (left label, right value bold)
  metrics.forEach(([label, value], idx) => {
    const y = metricsTop + idx * lineH;

    // label (left)
    args.push(
      '(',
        '-background', 'none',
        '-fill', colors.label,
        '-font', fonts.family,
        '-pointsize', String(fonts.labelSize),
        '-size', `${fonts.labelW}x${lineH}`,
        '-gravity', 'West',
        `caption:${label}`,
      ')',
      '-gravity', 'NorthWest',
      `-geometry`, `+${px + panel.padX + 80}+${y}`,
      '-composite'
    );

    // value (right, bold)
    const valueBoxW = panel.w - panel.padX * 2 - fonts.labelW;
    args.push(
      '(',
        '-background', 'none',
        '-fill', colors.value,
        '-font', fonts.familyBold,
        '-pointsize', String(fonts.valueSize),
        '-size', `${valueBoxW}x${lineH}`,
        '-gravity', 'East',
        `caption:${value}`,
      ')',
      '-gravity', 'NorthWest',
      `-geometry`, `+${px + panel.padX + fonts.labelW - 105}+${y}`,
      '-composite'
    );
  });

  // finalize
  args.push('-colorspace','sRGB','-strip','-quality','88', outputPath);

  await execFileP(bin, args);
  return outputPath;
}

/* ---------------------------------- utils --------------------------------- */

function fmtMoney(n){
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return '$' + (v/1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return '$' + (v/1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return '$' + (v/1e3).toFixed(2) + 'K';
  return '$' + v.toFixed(2);
}
const fmtPct = x => Number.isFinite(x) ? (x >= 0 ? `+${x.toFixed(2)}%` : `${x.toFixed(2)}%`) : '—';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PAGES_ROOT  = process.cwd();
const OUT_DIR     = path.join(PAGES_ROOT, 'token'); // /token/<mint>/index.html
const STATIC_DIR  = path.join(process.cwd(), 'tools', 'static');
const MINTS_FILE  = path.join(STATIC_DIR, 'mints.json');
const BUILT_FILE  = path.join(STATIC_DIR, 'built.json');
const SITE_ORIGIN = (process.env.SITE_ORIGIN || 'https://fdv.lol').replace(/\/+$/,'');
if (!SITE_ORIGIN) { console.error('SITE_ORIGIN env var is brokens'); process.exit(1); }

const REFRESH_HOURS     = Number(process.env.REFRESH_HOURS || 12);
const MAX_PER_RUN       = Number(process.env.MAX_PER_RUN   || 150);
const REQUEST_DELAY_MS  = Number(process.env.REQUEST_DELAY_MS || 120);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const esc = (s='') => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
const fileExists = (p) => { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } };
const loadJsonSafe = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

/* ---------------------------- dexscreener fetch ---------------------------- */

async function fetchDexToken(mint) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) return null; // treat as not listed
  return res.json();
}

function pickBestPair(json) {
  const list = Array.isArray(json?.pairs) ? json.pairs : [];
  if (!list.length) return null;
  return list.slice().sort((a,b) => (a?.liquidity?.usd||0) - (b?.liquidity?.usd||0)).pop();
}

/* ------------------------------- static HTML ------------------------------ */

function profileHtml({ title, description, primaryImage, secondaryImage, canonical }) {
  const extraOg = secondaryImage && secondaryImage !== primaryImage
    ? `\n    <meta property="og:image" content="${esc(secondaryImage)}" />`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}" />
    <meta name="author" content="builders-toronto" />
    <meta name="keywords" content="solana, memecoin, bonk, wif, dog, inu, pepe, cat, meme, ponk, samo, purry, purr, kitty, meow, woof, frog, snek, toad, bob, dino, monke, monkey, ape, corgi, floki, elon" />

    <!-- OG -->
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:url" content="${esc(canonical)}" />
    <meta property="og:image" content="${esc(primaryImage)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />${extraOg}

    <!-- Twitter -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(title)}" />
    <meta name="twitter:description" content="${esc(description)}" />
    <meta name="twitter:image" content="${esc(primaryImage)}" />

    <link rel="icon" type="image/png" href="/src/assets/images/icons/fdv.lol.ico" />
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/src/styles/global.css" />
  </head>
  <body>
    <div id="loader" class="loader-overlay" aria-live="polite" aria-busy="true" hidden>
      <div class="loader-wrap">
        <span class="sr-only">Loading…</span>
        <svg class="spinner" viewBox="0 0 50 50" role="img" aria-label="Loading">
          <circle class="ring" cx="25" cy="25" r="22" />
          <circle class="arc"  cx="25" cy="25" r="22" />
        </svg>
        <div id="meta" class="sub">Loading…</div>
      </div>
      <noscript>
        <div class="wrap"><p>JavaScript is required.</p></div>
      </noscript>
    </div>
    <header class="header">
      <div class="container">
        <div id="metaBase" class="sub">Loading…</div>
        <div class="controls">
          <select id="sort">
            <option value="score">Sort: Score</option>
            <option value="volume">Sort: 24h Volume</option>
            <option value="liquidity">Sort: Liquidity</option>
            <option value="change24">Sort: 24h Change</option>
          </select>
          <div class="innerControls">
            <button id="refresh" class="btn">Refresh</button>
            <div class="relaxControl">
              relax filter
              <input type="checkbox" id="relax" disabled />
            </div>
          </div>
        </div>
      </div>
    </header>
    <main id="app" class="container grid">
      <div id="cards" class="cards"></div>
    </main>
    <footer>
      <p>Cached in your browser for 90s. Not financial advice.</p>
      <p><a href="https://github.com/builders-toronto/fdv.lol" target="_blank" rel="noopener">Source code</a></p>
      <p><span class="joinCta">Join us</span> on <a href="https://t.me/fdvlol" target="_blank" rel="noopener">Telegram</a></p>
    </footer>
    <script>window.__BOOT_PROFILE_CANONICAL__=${JSON.stringify(canonical)};</script>
    <script type="module" src="/main.js"></script>
  </body>
</html>`;
}

/* ----------------------------- page generation ---------------------------- */

async function buildOne(mint) {
  // Don’t write anything unless listed on Dexscreener
  const json = await fetchDexToken(mint);
  if (!json) return null;

  const list = Array.isArray(json?.pairs) ? json.pairs : [];
  const best = pickBestPair(json);
  if (!best || !list.length) return null;

  // Now that we know it’s listed, compute fields
  const bannerFallback = `${SITE_ORIGIN}/src/assets/images/fdv.lol.png`;
  let tokenImageUrl = best?.info?.imageUrl || null;

  let symbol = best?.baseToken?.symbol || 'Token';
  let name   = best?.baseToken?.name   || symbol;

  const pNum = Number(best?.priceUsd);
  const lNum = Number(best?.liquidity?.usd);
  const fdvN = Number(best?.fdv ?? best?.marketCap);
  const lfP  = (Number.isFinite(lNum) && Number.isFinite(fdvN) && fdvN > 0) ? (lNum/fdvN)*100 : null;
  const ch24N = Number(best?.priceChange?.h24);
  let vol24N = 0;
  for (const p of list) vol24N += Number(p?.volume?.h24) || 0;

  const price = Number.isFinite(pNum) ? `$${pNum.toFixed(6)}` : '—';
  const liq   = fmtMoney(lNum);
  const fdv   = fmtMoney(fdvN);
  const lf    = Number.isFinite(lfP)  ? `${lfP.toFixed(2)}% L/F` : '—';
  const ch24  = fmtPct(ch24N);
  const vol24 = fmtMoney(vol24N);

  const title = `${symbol} on Solana`;
  const desc  = `${name} • Price: ${price} • Liquidity: ${liq}`;
  const canonical = `${SITE_ORIGIN}/token/${encodeURIComponent(mint)}`;

  const outDir  = path.join(OUT_DIR, mint);
  const rawDir  = path.join(outDir, 'raw');
  const ogPath  = path.join(outDir, 'og.jpg');
  const rawBase = path.join(rawDir, 'source');

  ensureDir(outDir);
  ensureDir(rawDir);

  let primaryOgUrl = bannerFallback;

  const metrics = [
    ['💸 Price', price],
    ['💧 Liquidity', liq],
    ['🏷️ FDV', fdv],
    ['🧪 L/F', lf],
    ['📈 24h', ch24],
    ['📊 Vol24h', vol24]
  ];

  // Attempt token image → normalized OG
  if (tokenImageUrl) {
    try {
      const extGuess   = (/\.(jpe?g|png|webp|gif|svg)(\?.*)?$/i.exec(tokenImageUrl)?.[1] || 'img').toLowerCase();
      const rawWithExt = `${rawBase}.${extGuess}`;
      await downloadToFile(tokenImageUrl, rawWithExt);
      await makeOgImage(rawWithExt, ogPath, { titleText: `${symbol} • ${name}`, metrics });
      primaryOgUrl = `${SITE_ORIGIN}/token/${encodeURIComponent(mint)}/og.jpg`;
    } catch {
      // fallback remains
    }
  }

  const html = profileHtml({
    title,
    description: desc,
    primaryImage: primaryOgUrl,
    secondaryImage: (tokenImageUrl && tokenImageUrl !== primaryOgUrl) ? tokenImageUrl : null,
    canonical
  });

  fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');
  return path.join(outDir, 'index.html');
}

/* ------------------------------- sitemap bits ------------------------------ */

const SITEMAP_FILE = path.join(PAGES_ROOT, 'sitemap.xml');
const ROBOTS_FILE  = path.join(PAGES_ROOT, 'robots.txt');

function isoDate(ts = Date.now()) {
  return new Date(ts).toISOString();
}

function listBuiltTokenDirs(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => fileExists(path.join(rootDir, name, 'index.html')));
}

function writeSitemap({ base, tokenDir, extraPaths = ['/', '/token/'], lastmodMap = {} }) {
  const tokens = listBuiltTokenDirs(tokenDir);
  const urls = [];

  for (const p of extraPaths) {
    const loc = (p.startsWith('http') ? p : `${base}${p.startsWith('/') ? '' : '/'}${p}`);
    urls.push({ loc, lastmod: isoDate() });
  }

  for (const mint of tokens) {
    const loc = `${base}/token/${encodeURIComponent(mint)}/`;
    const lastmod = lastmodMap[loc] || lastmodMap[mint] || isoDate();
    urls.push({ loc, lastmod });
  }

  const xml =
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${u.lastmod}</lastmod>
    <changefreq>hourly</changefreq>
    <priority>${u.loc.includes('/token/') ? '0.6' : '0.8'}</priority>
  </url>`).join('\n')}
</urlset>
`;

  fs.writeFileSync(SITEMAP_FILE, xml, 'utf8');

  try {
    let robots = fs.existsSync(ROBOTS_FILE) ? fs.readFileSync(ROBOTS_FILE, 'utf8') : '';
    const line = `Sitemap: ${base}/sitemap.xml`;
    if (!robots.includes(line)) {
      robots = (robots.trim() + '\n\n' + line + '\n').trim() + '\n';
      fs.writeFileSync(ROBOTS_FILE, robots, 'utf8');
    }
  } catch {}

  return SITEMAP_FILE;
}

/* ---------------------------------- main ---------------------------------- */

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

  let ok = 0, fail = 0, skip = 0;

  for (const [i, mint] of work.entries()) {
    try {
      const outPath = await buildOne(mint);
      if (outPath) {
        built[mint] = Date.now();
        ok++;
      } else {
        // not listed or fetch failed → skip
        skip++;
      }
    } catch (e) {
      console.warn('Failed:', mint, e.message);
      fail++;
    }
    if ((i+1) % 25 === 0) console.log(`  …processed ${i+1}/${work.length}`);
    if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
  }

  fs.writeFileSync(BUILT_FILE, JSON.stringify(built, null, 2));
  console.log(`Done. OK=${ok} SKIP=${skip} FAIL=${fail}. Output → /token/<mint>/index.html`);

  const lastmodMap = {};
  for (const mint of Object.keys(built)) {
    lastmodMap[mint] = new Date(built[mint]).toISOString();
    lastmodMap[`${SITE_ORIGIN}/token/${encodeURIComponent(mint)}/`] = lastmodMap[mint];
  }
  const sitemapPath = writeSitemap({
    base: SITE_ORIGIN,
    tokenDir: OUT_DIR,
    extraPaths: ['/'],
    lastmodMap
  });
  console.log(`Sitemap updated → ${path.relative(PAGES_ROOT, sitemapPath)}`);
}

main().catch(err => { console.error(err); process.exit(1); });
