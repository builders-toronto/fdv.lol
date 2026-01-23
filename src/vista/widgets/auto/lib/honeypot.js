function _toLamportsSafe(v) {
	try {
		const n = Number(v || 0);
		if (!Number.isFinite(n) || n <= 0) return 0;
		return Math.max(0, Math.floor(n));
	} catch {
		return 0;
	}
}

export function createRoundtripEdgeEstimator({
	solMint,
	quoteGeneric,
	requiredAtaLamportsForSwap,
	platformFeeBps = 0,
	txFeeEstimateLamports = 0,
	smallSellFeeFloorSol = 0,
	log,
	logObj,
} = {}) {
	const _log = typeof log === "function" ? log : () => {};
	const _logObj = typeof logObj === "function" ? logObj : () => {};
	const _quoteGeneric = typeof quoteGeneric === "function" ? quoteGeneric : null;
	const _requiredAta = typeof requiredAtaLamportsForSwap === "function" ? requiredAtaLamportsForSwap : null;

	return async function estimateRoundtripEdgePct(ownerPub, outMint, buySolUi, { slippageBps, dynamicFee = true, ataRentLamports } = {}) {
		try {
			const sol = String(solMint || "").trim();
			const mint = String(outMint || "").trim();
			if (!sol || !mint || sol === mint) return null;
			if (!_quoteGeneric) return null;

			const buyLamports = _toLamportsSafe(Math.floor(Number(buySolUi || 0) * 1e9));
			if (!Number.isFinite(buyLamports) || buyLamports <= 0) return null;

			const fwd = await _quoteGeneric(sol, mint, buyLamports, slippageBps);
			const outRaw = Number(fwd?.outAmount || 0);
			if (!outRaw || outRaw <= 0) return null;

			const back = await _quoteGeneric(mint, sol, outRaw, slippageBps);
			const backLamports = Number(back?.outAmount || 0);
			if (!backLamports || backLamports <= 0) return null;

			const feeBps = Number(platformFeeBps || 0);
			const txFeesL = _toLamportsSafe(txFeeEstimateLamports);
			const ataRentL = (() => {
				if (Number.isFinite(Number(ataRentLamports))) return _toLamportsSafe(Math.floor(Number(ataRentLamports)));
				if (_requiredAta) return null;
				return 0;
			})();

			const ataRentResolved = (ataRentL === null)
				? await _requiredAta(ownerPub, sol, mint)
				: ataRentL;

			let appliedFeeBps = feeBps;
			if (dynamicFee) {
				const outSol = backLamports / 1e9;
				if (!(outSol >= Number(smallSellFeeFloorSol || 0))) {
					appliedFeeBps = 0;
				} else {
					const feeSol = outSol * (feeBps / 10_000);
					const buySol = buyLamports / 1e9;
					const pnlNoFee = outSol - buySol;
					const pnlWithFee = outSol - feeSol - buySol;
					if (!(pnlWithFee > 0) || !(pnlNoFee > 0)) {
						appliedFeeBps = 0;
					}
				}
			}

			const platformL = Math.floor(backLamports * (appliedFeeBps / 10_000));
			const recurringL = platformL + txFeesL;

			const edgeL_inclOnetime = backLamports - buyLamports - recurringL - Math.max(0, ataRentResolved);
			const edgeL_noOnetime = backLamports - buyLamports - recurringL;

			const pct = (edgeL_inclOnetime / Math.max(1, buyLamports)) * 100;
			const pctNoOnetime = (edgeL_noOnetime / Math.max(1, buyLamports)) * 100;

			try {
				_logObj("Roundtrip edge breakdown", {
					buySol: buyLamports / 1e9,
					backSol: backLamports / 1e9,
					platformBpsConfigured: feeBps,
					platformBpsApplied: appliedFeeBps,
					platformSol: platformL / 1e9,
					txFeesSol: txFeesL / 1e9,
					ataRentSol: (Number(ataRentResolved || 0) / 1e9),
					netSolInclOnetime: edgeL_inclOnetime / 1e9,
					netSolNoOnetime: edgeL_noOnetime / 1e9,
					pctInclOnetime: Number(pct.toFixed(2)),
					pctNoOnetime: Number(pctNoOnetime.toFixed(2)),
				});
			} catch {}

			return {
				pct,
				pctNoOnetime,
				sol: edgeL_inclOnetime / 1e9,
				feesLamports: recurringL + Math.max(0, ataRentResolved),
				ataRentLamports: Math.max(0, ataRentResolved),
				recurringLamports: recurringL,
				platformBpsApplied: appliedFeeBps,
				forward: fwd,
				backward: back,
			};
		} catch (e) {
			try {
				_log(`Roundtrip edge estimator failed: ${e?.message || e}`, "warn");
			} catch {}
			return null;
		}
	};
}
