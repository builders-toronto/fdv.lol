const RPC_MAX_CONCURRENT = 2;
let _rpcInFlight = 0;
let _rpcBlockUntil = 0;
const RPC_RETRY_BACKOFF_MS = 60_000;

function looksLikeMint(s) {
  if (!s) return false;
  const x = String(s).trim();
  if (x.length < 30 || x.length > 48) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(x);
}

export async function fetchTrending(){ return []; }

const DEFAULT_RPC_POOL = [
  'https://api.mainnet-beta.solana.com',
];
function getRpcUrl() { return SOLANA_RPC_URL || DEFAULT_RPC_POOL[0]; }

export async function rpcCall(method, params, { signal } = {}) {
  const now = Date.now();
  if (now < _rpcBlockUntil) {
    throw new Error(`rpc_backoff:${Math.ceil((_rpcBlockUntil - now)/1000)}s`);
  }

  while (_rpcInFlight >= RPC_MAX_CONCURRENT) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await sleep(40);
  }

  _rpcInFlight += 1;
  const url = getRpcUrl();
  const body = { jsonrpc: '2.0', id: 1, method, params };
  try {
    const fetcher = (sig) => fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: sig,
    }).then(async r => {
      if (!r.ok) {
        if (r.status === 403 || r.status === 429) {
          _rpcBlockUntil = Date.now() + RPC_RETRY_BACKOFF_MS;
        }
        throw new Error(`rpc ${r.status}`);
      }
      return r.json();
    });

    const json = await withTimeout(fetcher, 8_000, signal);
    if (json?.error) {
      if (/rate/i.test(json.error?.message || "")) {
        _rpcBlockUntil = Date.now() + RPC_RETRY_BACKOFF_MS;
      }
      throw new Error(json.error?.message || 'rpc error');
    }
    return json?.result;
  } finally {
    _rpcInFlight = Math.max(0, _rpcInFlight - 1);
  }
}

export async function provSolanaRPCSearch(query, { signal } = {}) {
  const name = 'solana-rpc';
  const q = (query || '').trim();
  if (!looksLikeMint(q)) return [];
  try {
    const info = await rpcCall('getAccountInfo', [
      q, { encoding: 'jsonParsed', commitment: 'processed' }
    ], { signal });

    const type = info?.value?.data?.parsed?.type;
    if (type !== 'mint') { health.onSuccess(name); return []; }

    let supply = null, decimals = null;
    try {
      const sup = await rpcCall('getTokenSupply', [q, { commitment: 'processed' }], { signal });
      supply = asNum(sup?.value?.amount);
      decimals = asNum(sup?.value?.decimals);
    } catch {}

    health.onSuccess(name);
    return [{
      mint: q, symbol: '', name: '', imageUrl: '',
      priceUsd: null, bestLiq: null, dexId: 'solana', url: '',
      supply, decimals, sources: ['solana-rpc'],
    }];
  } catch {
    health.onFailure(name);
    return [];
  }
}
