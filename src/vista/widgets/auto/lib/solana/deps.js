import { importFromUrlWithFallback } from "../../../../../utils/netImport.js";

export function createSolanaDepsLoader({
	web3Version = "1.95.4",
	bs58Version = "6.0.0",
	cacheKeyPrefix = "fdv:auto",
	prefer = "jsdelivr",
} = {}) {
	let web3Promise;
	let bs58Promise;
	const preferKey = String(prefer || "jsdelivr").toLowerCase();

	async function loadWeb3() {
		try {
			if (typeof window !== "undefined" && window.solanaWeb3) return window.solanaWeb3;
			if (typeof window !== "undefined" && window._fdvAutoDepsPromise) {
				const deps = await window._fdvAutoDepsPromise.catch(() => null);
				if (deps?.web3) {
					try {
						window.solanaWeb3 = deps.web3;
					} catch {}
					return deps.web3;
				}
			}
		} catch {}

		if (web3Promise) return web3Promise;
		const web3Urls = [
			`https://cdn.jsdelivr.net/npm/@solana/web3.js@${web3Version}/+esm`,
			`https://esm.sh/@solana/web3.js@${web3Version}?bundle`,
		];
		if (preferKey === "esm") web3Urls.reverse();
		web3Promise = (async () =>
			importFromUrlWithFallback(web3Urls, { cacheKey: `${cacheKeyPrefix}:web3@${web3Version}` }))();
		const mod = await web3Promise;
		try {
			if (typeof window !== "undefined") window.solanaWeb3 = mod;
		} catch {}
		return mod;
	}

	async function loadBs58() {
		try {
			if (typeof window !== "undefined" && window._fdvBs58Module) {
				const m = window._fdvBs58Module;
				const b = m?.default || m;
				if (b && typeof b.decode === "function" && typeof b.encode === "function") return b;
			}
			if (typeof window !== "undefined" && window._fdvAutoDepsPromise) {
				const deps = await window._fdvAutoDepsPromise.catch(() => null);
				const b = deps?.bs58;
				if (b && typeof b.decode === "function" && typeof b.encode === "function") return b;
			}
			if (typeof window !== "undefined" && window.bs58) {
				const b = window.bs58;
				if (b && typeof b.decode === "function" && typeof b.encode === "function") return b;
			}
		} catch {}

		if (bs58Promise) return bs58Promise;
		const bs58Urls = [
			`https://cdn.jsdelivr.net/npm/bs58@${bs58Version}/+esm`,
			`https://esm.sh/bs58@${bs58Version}?bundle`,
		];
		if (preferKey === "esm") bs58Urls.reverse();
		bs58Promise = (async () =>
			importFromUrlWithFallback(bs58Urls, { cacheKey: `${cacheKeyPrefix}:bs58@${bs58Version}` }))().then((mod) => {
			const b = mod?.default || mod;
			try {
				if (typeof window !== "undefined") {
					window._fdvBs58Module = mod;
					window.bs58 = b;
				}
			} catch {}
			return b;
		});
		return bs58Promise;
	}

	return { loadWeb3, loadBs58 };
}
