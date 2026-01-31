import { addKpiAddon, getLatestSnapshot } from '../ingest.js';
import { createSolanaDepsLoader } from '../../../widgets/auto/lib/solana/deps.js';

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNb1KzYrNU3G1bqbp1VZr1z7jWmzuXyaS6uJ';

export const HONEY_STORAGE_KEY = 'meme_honeypot_kpi_v1';

const RPC_REQUIRED_MSG = 'Error: This service only works if you have a working RPC saved to your Auto tools config';

const DEFAULT_SCAN_PER_TICK = 4;
const DEFAULT_CACHE_MS = 15 * 60 * 1000;
const DEFAULT_MAX_MINTS = 600;
const DEFAULT_MIN_RISK_SCORE = 40;

const { loadWeb3 } = createSolanaDepsLoader({
	cacheKeyPrefix: 'fdv:meme:honey',
	web3Version: '1.95.4',
	prefer: 'esm',
});

function now() {
	return Date.now();
}

function safeJsonParse(raw, fallback) {
	try {
		const v = JSON.parse(raw);
		return v && typeof v === 'object' ? v : fallback;
	} catch {
		return fallback;
	}
}

function loadStore() {
	try {
		return safeJsonParse(localStorage.getItem(HONEY_STORAGE_KEY) || '', { byMint: {} });
	} catch {
		return { byMint: {} };
	}
}

function saveStore(s) {
	try { localStorage.setItem(HONEY_STORAGE_KEY, JSON.stringify(s)); } catch {}
}

function readU32LE(u8, offset) {
	try {
		const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
		return dv.getUint32(offset, true);
	} catch {
		return 0;
	}
}

function getRpcUrl() {
	try {
		const fromLs = String(localStorage.getItem('fdv_rpc_url') || '').trim();
		if (fromLs) return fromLs;
	} catch {}
	return '';
}

let _connPromise;
let _rpcLastUrl = '';
let _rpcError = '';

function _refreshRpcStatus() {
  const url = getRpcUrl();
  const changed = url !== _rpcLastUrl;
  _rpcLastUrl = url;

  if (!url) {
    _rpcError = RPC_REQUIRED_MSG;
    _connPromise = null;
    return { ok: false, url: '', why: 'rpc_missing' };
  }

  if (changed) {
    _rpcError = '';
    _connPromise = null;
  }

  return { ok: true, url, why: '' };
}

async function getConn() {
	const st = _refreshRpcStatus();
	if (!st.ok) {
		const e = new Error(st.why || 'rpc_missing');
		e.code = 'rpc_missing';
		throw e;
	}
	if (_connPromise) return _connPromise;
	_connPromise = (async () => {
		const web3 = await loadWeb3();
		const url = _rpcLastUrl || getRpcUrl();
		const Connection = web3?.Connection;
		if (!Connection) throw new Error('web3_connection_missing');
		try {
			return new Connection(url, { commitment: 'processed' });
		} catch (e) {
			_rpcError = RPC_REQUIRED_MSG;
			throw e;
		}
	})();
	return _connPromise;
}

function scoreHoneypotFlags({ token2022, hasFreezeAuthority, hasMintAuthority }) {
	// Score is “riskiness”: higher means more likely sell issues.
	let score = 0;
	if (token2022) score += 60;
	if (hasFreezeAuthority) score += 40;
	if (hasMintAuthority) score += 10;
	return Math.max(0, Math.min(100, score));
}

async function assessMint(mintStr) {
	const mint = String(mintStr || '').trim();
	if (!mint) return null;

	const web3 = await loadWeb3();
	const PublicKey = web3?.PublicKey;
	if (!PublicKey) throw new Error('web3_pubkey_missing');

	const conn = await getConn();
	const pk = new PublicKey(mint);
	const ai = await conn.getAccountInfo(pk, 'processed');
	if (!ai || !ai.data) return { ok: false, why: 'mint_account_missing' };

	const ownerStr = (() => {
		try { return ai.owner?.toBase58?.() || String(ai.owner || ''); } catch { return ''; }
	})();
	const program = ownerStr === TOKEN_2022_PROGRAM_ID ? 'token-2022' : (ownerStr === TOKEN_PROGRAM_ID ? 'token' : 'unknown');

	const u8 = (ai.data instanceof Uint8Array) ? ai.data : new Uint8Array(ai.data);
	if (u8.length < 82) {
		return { ok: false, why: 'mint_data_too_small', program, owner: ownerStr, dataLen: u8.length };
	}

	const mintAuthOpt = readU32LE(u8, 0);
	const freezeAuthOpt = readU32LE(u8, 46);
	const mintAuthority = (mintAuthOpt !== 0) ? new PublicKey(u8.slice(4, 36)).toBase58() : null;
	const freezeAuthority = (freezeAuthOpt !== 0) ? new PublicKey(u8.slice(50, 82)).toBase58() : null;

	const flags = {
		token2022: program === 'token-2022',
		hasFreezeAuthority: !!freezeAuthority,
		hasMintAuthority: !!mintAuthority,
	};
	const score = scoreHoneypotFlags(flags);

	return {
		ok: true,
		program,
		owner: ownerStr,
		mintAuthority,
		freezeAuthority,
		flags,
		score,
	};
}

const _queue = [];
let _scanInFlight = false;
let _snapshotByMint = new Map();

function updateSnapshotIndex(items) {
	const list = Array.isArray(items) ? items : [];
	const next = new Map();
	for (const it of list) {
		const mint = it?.mint || it?.id;
		if (!mint) continue;
		next.set(mint, {
			mint,
			symbol: it?.symbol || '',
			name: it?.name || '',
			imageUrl: it?.logoURI || it?.imageUrl || '',
			pairUrl: it?.pairUrl || '',
			priceUsd: Number(it?.priceUsd || 0),
			chg24: Number(it?.change?.h24 ?? 0),
			liqUsd: Number(it?.liquidityUsd ?? 0),
			vol24: Number(it?.volume?.h24 ?? 0),
		});
	}
	_snapshotByMint = next;
}

function enqueueSnapshot(items) {
	updateSnapshotIndex(items);
	const list = Array.isArray(items) ? items : [];
	const s = loadStore();
	const cacheMs = DEFAULT_CACHE_MS;
	const t = now();

	// Bias toward higher-liquidity tokens so we surface “dangerous and relevant”.
	const ordered = list
		.map(it => ({ it, mint: it?.mint || it?.id, liq: Number(it?.liquidityUsd || 0), vol: Number(it?.volume?.h24 || 0) }))
		.filter(x => !!x.mint)
		.sort((a, b) => (b.liq - a.liq) || (b.vol - a.vol))
		.slice(0, DEFAULT_MAX_MINTS);

	for (const row of ordered) {
		const mint = row.mint;
		const rec = s.byMint?.[mint] || null;
		const age = rec ? (t - Number(rec.ts || 0)) : Infinity;
		if (age < cacheMs) continue;
		if (_queue.includes(mint)) continue;
		_queue.push(mint);
	}

	// Clamp queue size (avoid unbounded growth)
	if (_queue.length > DEFAULT_MAX_MINTS) {
		_queue.splice(0, _queue.length - DEFAULT_MAX_MINTS);
	}
}

async function tickScan() {
	if (_scanInFlight) return;
	if (!_queue.length) return;
	_scanInFlight = true;

	try {
		const st = _refreshRpcStatus();
		if (!st.ok) {
			_queue.length = 0;
			return;
		}
		const s = loadStore();
		const t = now();
		const scanN = Math.max(1, DEFAULT_SCAN_PER_TICK);

		for (let i = 0; i < scanN && _queue.length; i++) {
			const mint = _queue.shift();
			try {
				const res = await assessMint(mint);
				if (res && typeof res === 'object') {
					s.byMint[mint] = { ts: t, ...res };
				}
			} catch (e) {
				// If RPC is broken/missing, stop scanning and show error.
				const msg = String(e?.message || e);
				if (/rpc_missing/i.test(msg) || e?.code === 'rpc_missing') {
					_rpcError = RPC_REQUIRED_MSG;
					_queue.length = 0;
					break;
				}
				if (/failed to fetch|fetch failed|networkerror|socket|timed out|timeout|503|429|cors/i.test(msg)) {
					_rpcError = RPC_REQUIRED_MSG;
					_queue.length = 0;
					_connPromise = null;
					break;
				}
			}
		}

		// prune old/unknown entries
		const cutoff = t - (12 * 60 * 60 * 1000);
		for (const [mint, rec] of Object.entries(s.byMint || {})) {
			const ts = Number(rec?.ts || 0);
			if (!ts || ts < cutoff) delete s.byMint[mint];
		}

		saveStore(s);
	} finally {
		_scanInFlight = false;
		// Keep scanning in the background as long as we have work.
		if (_queue.length && !_rpcError) {
			setTimeout(() => tickScan().catch(() => {}), 75);
		}
	}
}

function buildRiskLabel(rec) {
	try {
		const flags = rec?.flags || {};
		const parts = [];
		if (flags.token2022) parts.push('token-2022');
		if (flags.hasFreezeAuthority) parts.push('freeze');
		if (flags.hasMintAuthority) parts.push('mintAuth');
		return parts.length ? parts.join(' • ') : '—';
	} catch {
		return '—';
	}
}

function rowsFromStore(limit = 6, minScore = DEFAULT_MIN_RISK_SCORE) {
	const s = loadStore();
	const rows = [];

	for (const [mint, rec] of Object.entries(s.byMint || {})) {
		if (!rec || rec.ok !== true) continue;
		const score = Number(rec.score || 0);
		if (!Number.isFinite(score) || score < minScore) continue;

		const snap = _snapshotByMint.get(mint) || { mint };
		rows.push({
			mint,
			symbol: snap.symbol || '',
			name: snap.name || '',
			imageUrl: snap.imageUrl || '',
			priceUsd: Number(snap.priceUsd || 0),
			chg24: Number(snap.chg24 || 0),
			liqUsd: Number(snap.liqUsd || 0),
			vol24: buildRiskLabel(rec),
			pairUrl: snap.pairUrl || '',
			metric: Math.round(score),
		});
	}

	rows.sort((a, b) => (b.metric - a.metric) || (b.liqUsd - a.liqUsd));
	return rows.slice(0, limit);
}

function _errorPayload() {
	return {
		title: 'Honeypot Watch',
		metricLabel: 'Risk',
		items: [
			{
				mint: '',
				symbol: 'RPC',
				name: 'Auto RPC required',
				imageUrl: '',
				priceUsd: NaN,
				chg24: NaN,
				liqUsd: NaN,
				vol24: _rpcError || RPC_REQUIRED_MSG,
				pairUrl: '',
				metric: null,
			},
		],
	};
}

function _statusPayload(msg) {
	return {
		title: 'Honeypot Watch',
		metricLabel: 'Risk',
		items: [
			{
				mint: '',
				symbol: 'HONEY',
				name: 'Honeypot Watch',
				imageUrl: '',
				priceUsd: NaN,
				chg24: NaN,
				liqUsd: NaN,
				vol24: msg,
				pairUrl: '',
				metric: null,
			},
		],
	};
}

addKpiAddon(
	{
		id: 'honey',
		updateMode: 'throttled',
		throttleMs: 350,
		ingestLimit: 220,
		order: 4,
		label: 'HONEY',
		title: 'Honeypot Watch',
		metricLabel: 'Risk',
		limit: 6,
	},
	{
		computePayload() {
			try { _refreshRpcStatus(); } catch {}
			if (_rpcError) return _errorPayload();

			// Keep the scan moving even if ingest throttles.
			try {
				const snap = getLatestSnapshot();
				if (Array.isArray(snap) && snap.length) {
					enqueueSnapshot(snap);
					tickScan().catch(() => {});
				}
			} catch {}

			const items = rowsFromStore(6, DEFAULT_MIN_RISK_SCORE);
			if (!items.length) {
				let msg = 'Scanning… keep the stream running.';
				try {
					const q = Number(_queue.length || 0);
					const haveSnap = Array.isArray(getLatestSnapshot?.()) && getLatestSnapshot().length;
					if (!haveSnap) msg = 'Waiting for stream… keep the stream running.';
					else if (q > 0) msg = `Scanning ${q} mint${q === 1 ? '' : 's'}… keep the stream running.`;
					else msg = `No risky mints cached yet (min risk ${DEFAULT_MIN_RISK_SCORE}).`;
				} catch {}
				return _statusPayload(msg);
			}
			return {
				title: 'Honeypot Watch',
				metricLabel: 'Risk',
				items,
			};
		},
		ingestSnapshot(items) {
			try { _refreshRpcStatus(); } catch {}
			if (_rpcError) return;
			enqueueSnapshot(items);
			tickScan().catch(() => {});
		},
	}
);
