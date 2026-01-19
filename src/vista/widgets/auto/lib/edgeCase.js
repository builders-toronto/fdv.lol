export function toLamports(v) {
	const n = Number(v || 0);
	if (!Number.isFinite(n) || n <= 0) return 0;
	return Math.max(0, Math.floor(n));
}

export function lamportsToSol(lamports) {
	return toLamports(lamports) / 1e9;
}

export function computeEdgeCaseCostLamports({
	ataRentLamports = 0,
	txFeeEstimateLamports = 0,
	txFeeBufferLamports = 0,
	includeBuffer = false,
} = {}) {
	const ata = toLamports(ataRentLamports);
	const fee = toLamports(txFeeEstimateLamports);
	const buf = toLamports(txFeeBufferLamports);
	const total = ata + fee + (includeBuffer ? buf : 0);
	return { totalLamports: total, ataRentLamports: ata, txFeeEstimateLamports: fee, txFeeBufferLamports: buf };
}

// Returns null when buySol is unknown/invalid.
export function recommendTargetProfitPct({ buySol, edgeCostLamports, safetyBufferPct = 0.1, minPct = 0 } = {}) {
	const buy = Number(buySol || 0);
	if (!Number.isFinite(buy) || buy <= 0) return null;
	const edgeSol = lamportsToSol(edgeCostLamports);
	const base = (edgeSol / buy) * 100;
	const buf = Math.max(0, Number(safetyBufferPct || 0));
	const min = Math.max(0, Number(minPct || 0));
	return Math.max(min, base + buf);
}
