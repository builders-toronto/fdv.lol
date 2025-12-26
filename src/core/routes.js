import * as web3 from 'https://esm.sh/@solana/web3.js';
import * as Orca from 'https://esm.sh/@orca-so/whirlpools';
const RAY_SWAP_HOST = 'https://transaction-v1.raydium.io';
import { DLMM } from 'https://esm.sh/@meteora-ag/dlmm';
import BN from 'https://esm.sh/bn.js';

export const SOL_MINT  = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const toPk = (x) => (x instanceof web3.PublicKey ? x : new web3.PublicKey(x));
const byOutDesc = (a,b) => (a.outAmount > b.outAmount ? -1 : 1);

const percentageFromBps = (bps=150) => Orca.Percentage.fromFraction(bps, 10_000);
const isSame = (a,b) => String(a).toLowerCase() === String(b).toLowerCase();

async function orcaQuote({ connection, inMint, outMint, inAmount, slippageBps }) {
  try {
    const ctx = Orca.WhirlpoolContext.from(
      connection,
      { publicKey: web3.PublicKey.default },
      Orca.ORCA_WHIRLPOOLS_CONFIG
    );
    const client = Orca.buildWhirlpoolClient(ctx);

    const feeTiers = [5, 25, 100, 200];
    let best = null;

    for (const fee of feeTiers) {
      const pool = await client.getPoolForPair(toPk(inMint), toPk(outMint), fee).catch(()=>null);
      if (!pool) continue;

      const aToB = toPk(inMint).toBase58() < toPk(outMint).toBase58();
      const quote = await Orca.swapQuoteByInputToken(
        pool,
        toPk(inMint),
        BigInt(inAmount),
        aToB,
        percentageFromBps(slippageBps),
        ctx.program.programId
      ).catch(()=>null);
      if (!quote) continue;

      const out = BigInt(quote.estimatedAmountOut.toString());
      if (!best || out > best.outAmount) {
        best = {
          dex: 'orca',
          inMint, outMint,
          inAmount: BigInt(inAmount),
          outAmount: out,
          meta: { pool: pool.getAddress().toBase58(), aToB }
        };
      }
    }
    return best;
  } catch { return null; }
}

async function raydiumQuote({ inMint, outMint, inAmount, slippageBps }) {
  try {
    const url = new URL(`${RAY_SWAP_HOST}/compute/swap-base-in`);
    url.searchParams.set('inputMint', inMint);
    url.searchParams.set('outputMint', outMint);
    url.searchParams.set('amount', String(inAmount));   // raw, account for decimals on caller
    url.searchParams.set('slippageBps', String(slippageBps ?? 150));
    url.searchParams.set('txVersion', 'V0');

    const res = await fetch(url.toString(), { mode: 'cors' });
    if (!res.ok) return null;
    const data = await res.json();

    const out =
      BigInt(
        // common fields seen across versions; choose the first that exists
        (data?.otherAmountThreshold ?? data?.amountOut ?? data?.outAmount ?? '0')
      );

    if (out <= 0n) return null;

    return {
      dex: 'raydium',
      inMint, outMint,
      inAmount: BigInt(inAmount),
      outAmount: out,
      meta: { route: data?.routePlan ?? data?.routes ?? null }
    };
  } catch { return null; }
}

async function meteoraQuote({
  connection,
  inMint, outMint, inAmount, slippageBps,
  poolList, poolListUrl = 'https://dlmm-api.meteora.ag/liquidity-book-pairs/all'
}) {
  try {
    let list = Array.isArray(poolList) ? poolList : null;
    if (!list) {
      const res = await fetch(poolListUrl, { mode: 'cors' });
      if (!res.ok) return null;
      list = await res.json();
    }

    const candidates = (list || []).filter(p => {
      const x = (p.mint_x || p.tokenXMint || p.token_x || '').toLowerCase();
      const y = (p.mint_y || p.tokenYMint || p.token_y || '').toLowerCase();
      return (x && y) && (
        (x === inMint.toLowerCase() && y === outMint.toLowerCase()) ||
        (x === outMint.toLowerCase() && y === inMint.toLowerCase())
      );
    });

    if (!candidates.length) return null;

    // prefer verified / highest liquidity
    candidates.sort((a,b)=>{
      const av = (a.is_verified?1:0) - (b.is_verified?1:0);
      if (av) return -av;
      const la = Number(a.liquidity || a.tvl || 0);
      const lb = Number(b.liquidity || b.tvl || 0);
      return lb - la;
    });

    const chosen = candidates[0];
    const poolPk = new web3.PublicKey(chosen.address);

    const dlmm = await DLMM.create(connection, poolPk);
    const swapForY = isSame(inMint, chosen.mint_x || chosen.tokenXMint);
    const inBn = new BN(String(inAmount));                // raw lamports
    const slipBn = new BN(String(slippageBps ?? 150));    // bps

    const binArrays = await dlmm.getBinArrayForSwap(inBn, swapForY);
    const q = await dlmm.swapQuote(inBn, swapForY, slipBn, binArrays);

    const out = BigInt(String(q.outAmount ?? q.amountOut ?? 0));
    if (!out || out <= 0n) return null;

    return {
      dex: 'meteora',
      inMint, outMint,
      inAmount: BigInt(inAmount),
      outAmount: out,
      meta: { pool: poolPk.toBase58(), swapForY, binsTouched: q.binsTouched ?? undefined }
    };
  } catch {
    return null;
  }
}

export async function findBestRoute({
  rpc,
  inMint, outMint,
  inAmount,            // bigint raw (decimals already applied)
  slippageBps = 150,
  enableOrca = true,
  enableRaydium = true,
  enableMeteora = true,
  meteoraPoolListUrl,  // optional override/cached list
  meteoraPoolList      // optional pre-fetched array
}) {
  if (!rpc) throw new Error('rpc required');
  if (!inMint || !outMint) throw new Error('mints required');
  if (!BigInt(inAmount)) throw new Error('inAmount must be bigint');

  const connection = new web3.Connection(rpc, { commitment: 'confirmed' });

  const direct = await Promise.all([
    enableOrca     ? orcaQuote({ connection, inMint, outMint, inAmount, slippageBps }) : null,
    enableRaydium  ? raydiumQuote({ inMint, outMint, inAmount, slippageBps }) : null,
    enableMeteora  ? meteoraQuote({ connection, inMint, outMint, inAmount, slippageBps, poolList: meteoraPoolList, poolListUrl: meteoraPoolListUrl }) : null,
  ]);
  const directBest = direct.filter(Boolean).sort(byOutDesc)[0] || null;

  let bridgeBest = null;
  if (!isSame(inMint, USDC_MINT) && !isSame(outMint, USDC_MINT)) {
    const leg1s = await Promise.all([
      enableOrca    ? orcaQuote({ connection, inMint, outMint: USDC_MINT, inAmount, slippageBps }) : null,
      enableRaydium ? raydiumQuote({ inMint, outMint: USDC_MINT, inAmount, slippageBps }) : null,
      enableMeteora ? meteoraQuote({ connection, inMint, outMint: USDC_MINT, inAmount, slippageBps, poolList: meteoraPoolList, poolListUrl: meteoraPoolListUrl }) : null,
    ]);
    const leg1 = leg1s.filter(Boolean).sort(byOutDesc)[0];

    if (leg1) {
      const leg2s = await Promise.all([
        enableOrca    ? orcaQuote({ connection, inMint: USDC_MINT, outMint, inAmount: leg1.outAmount, slippageBps }) : null,
        enableRaydium ? raydiumQuote({ inMint: USDC_MINT, outMint, inAmount: leg1.outAmount, slippageBps }) : null,
        enableMeteora ? meteoraQuote({ connection, inMint: USDC_MINT, outMint, inAmount: leg1.outAmount, slippageBps, poolList: meteoraPoolList, poolListUrl: meteoraPoolListUrl }) : null,
      ]);
      const leg2 = leg2s.filter(Boolean).sort(byOutDesc)[0];

      if (leg2) {
        bridgeBest = {
          kind: 'usdc-bridge',
          dexPath: `${leg1.dex}+${leg2.dex}`,
          quotes: [leg1, leg2],
          outAmount: BigInt(leg2.outAmount)
        };
      }
    }
  }

  const directOut = directBest ? directBest.outAmount : 0n;
  const bridgeOut = bridgeBest ? bridgeBest.outAmount : 0n;

  if (!directBest && !bridgeBest) throw new Error('NO_ROUTE');

  if (bridgeBest && bridgeOut > directOut) return bridgeBest;
  return { kind: 'direct', dexPath: directBest.dex, quotes: [directBest], outAmount: directOut };
}
