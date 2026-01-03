export function createConnectionGetter({
	loadWeb3,
	getRpcUrl,
	getRpcHeaders,
	commitment = "confirmed",
} = {}) {
	let connPromise = null;
	let lastKey = "";

	return async function getConn() {
		const url = String(getRpcUrl?.() || "").trim();
		if (!url) throw new Error("RPC URL not configured");
		let headers = null;
		try {
			headers = getRpcHeaders?.() || null;
		} catch {
			headers = null;
		}
		const hdrKey = headers && typeof headers === "object" ? JSON.stringify(headers) : "";
		const key = `${url}|${hdrKey}`;

		if (connPromise && lastKey === key) return connPromise;
		const { Connection } = await loadWeb3();
		const conn = new Connection(url, {
			commitment,
			wsEndpoint: undefined,
			httpHeaders: headers && typeof headers === "object" && Object.keys(headers).length ? headers : undefined,
		});
		connPromise = Promise.resolve(conn);
		lastKey = key;
		return conn;
	};
}
