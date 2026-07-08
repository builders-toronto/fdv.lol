function _g() {
  try {
    return typeof window !== "undefined" ? window : globalThis;
  } catch {
    return globalThis;
  }
}

async function importWithFallback(urls) {
  let lastErr;
  for (const url of urls) {
    try {
      return await import(url);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("IMPORT_FAILED");
}

async function loadWeb3() {
  const g = _g();
  try {
    const w = g?.window || g;
    const local = w?.solanaWeb3 || g?.solanaWeb3;
    if (local?.PublicKey) return local;
  } catch {}
  if (g.__fdvWeb3Promise) return g.__fdvWeb3Promise;
  g.__fdvWeb3Promise = (async () =>
    importWithFallback([
      "https://cdn.jsdelivr.net/npm/@solana/web3.js@1.95.4/+esm",
      "https://esm.sh/@solana/web3.js@1.95.4?bundle",
    ]))();
  return g.__fdvWeb3Promise;
}

function normalizeModule(mod) {
  if (!mod || (typeof mod !== "object" && typeof mod !== "function")) return mod;

  const d = mod.default;
  if (d && (typeof d === "object" || typeof d === "function")) {
    try {
      // keep the namespace module shape but also expose default exports
      return { ...mod, ...d };
    } catch {
      return d;
    }
  }
  return mod;
}

export async function loadSplToken() {
  const g = _g();

  if (g.splToken) return g.splToken;
  if (g.__fdvSplTokenPromise) return g.__fdvSplTokenPromise;

  g.__fdvSplTokenPromise = (async () => {
    // Prefer newer spl-token, but keep a fallback to the older version used elsewhere in the repo.
    const urls = [
      "https://cdn.jsdelivr.net/npm/@solana/spl-token@0.4.14/+esm",
      "https://esm.sh/@solana/spl-token@0.4.14?bundle",
      "https://cdn.jsdelivr.net/npm/@solana/spl-token@0.4.9/+esm",
      "https://esm.sh/@solana/spl-token@0.4.9?bundle",
    ];

    let mod;
    try {
      mod = await importWithFallback(urls);
    } catch {
      mod = null;
    }

    const m = normalizeModule(mod) || {};

    // Ensure commonly-used constants/functions exist even if the import failed.
    // Each fallback is wrapped individually so a single bad assignment
    // doesn't poison the others. The TOKEN_2022 constant especially had a
    // typo'd fallback in earlier versions — a thrown PublicKey constructor
    // there would otherwise leave it null and silently break every
    // Token-2022 ATA derivation downstream.
    let PublicKeyCtor = null;
    try { PublicKeyCtor = (await loadWeb3()).PublicKey; } catch {}

    const tryConst = (current, raw) => {
      if (current) return current;
      try {
        if (PublicKeyCtor) return new PublicKeyCtor(raw);
      } catch {}
      return null;
    };

    m.TOKEN_PROGRAM_ID = tryConst(m.TOKEN_PROGRAM_ID, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    m.TOKEN_2022_PROGRAM_ID = tryConst(m.TOKEN_2022_PROGRAM_ID, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    m.ASSOCIATED_TOKEN_PROGRAM_ID = tryConst(m.ASSOCIATED_TOKEN_PROGRAM_ID, "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

    if (typeof m.getAssociatedTokenAddress !== "function") {
      if (PublicKeyCtor) {
        m.getAssociatedTokenAddress = async function getAssociatedTokenAddress(
          mint,
          owner,
          _allowOwnerOffCurve = true,
          programId = m.TOKEN_PROGRAM_ID,
          associatedTokenProgramId = m.ASSOCIATED_TOKEN_PROGRAM_ID,
        ) {
          if (!programId || !associatedTokenProgramId) return null;
          const seeds = [owner.toBuffer(), programId.toBuffer(), mint.toBuffer()];
          const [addr] = await PublicKeyCtor.findProgramAddress(seeds, associatedTokenProgramId);
          return addr;
        };
      } else {
        m.getAssociatedTokenAddress = async () => null;
      }
    }

    g.splToken = m;
    return m;
  })();

  try {
    if (!g.fdv) g.fdv = {};
    if (!g.fdv.loadSplToken) g.fdv.loadSplToken = loadSplToken;
  } catch {}

  return g.__fdvSplTokenPromise;
}
