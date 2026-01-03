import { withTimeout } from "../async.js";

export function createConfirmSig({
	getConn,
	markRpcStress,
	defaultCommitment = "confirmed",
	defaultTimeoutMs = 20_000,
	throwOnTimeout = false,
} = {}) {
	return async function confirmSig(sig, opts = {}) {
		const conn = await getConn();
		const commitment = opts.commitment || defaultCommitment;
		const timeoutMs = Number(opts.timeoutMs || defaultTimeoutMs);
		const requireFinalized = !!opts.requireFinalized;
		const pollMs = Math.max(200, Number(opts.pollMs || 500));
		const searchTransactionHistory = !!opts.searchTransactionHistory;

		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			try {
				const st = await withTimeout(
					conn.getSignatureStatuses([sig], searchTransactionHistory ? { searchTransactionHistory: true } : undefined),
					8_000,
					{ label: "sigStatus" },
				);
				const v = st?.value?.[0];
				if (v?.err) return false;
				const c = v?.confirmationStatus;
				if (requireFinalized) {
					if (c === "finalized") return true;
				} else {
					if (commitment === "confirmed" && (c === "confirmed" || c === "finalized")) return true;
					if (commitment === "finalized" && c === "finalized") return true;
				}
			} catch (e) {
				try {
					markRpcStress?.(e, 1500);
				} catch {}
			}
			await new Promise((r) => setTimeout(r, pollMs));
		}
		if (throwOnTimeout) throw new Error("CONFIRM_TIMEOUT");
		return false;
	};
}
