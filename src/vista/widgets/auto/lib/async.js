export function delay(ms) {
	return new Promise((r) => setTimeout(r, Math.max(0, Number(ms || 0))));
}

export function withTimeout(promise, ms, { label = "op" } = {}) {
	const timeoutMs = Math.max(1, Number(ms || 0));
	let t = null;
	return Promise.race([
		Promise.resolve(promise).finally(() => {
			try {
				if (t) clearTimeout(t);
			} catch {}
		}),
		new Promise((_, reject) => {
			t = setTimeout(() => reject(new Error(`${label}_TIMEOUT_${timeoutMs}`)), timeoutMs);
		}),
	]);
}
