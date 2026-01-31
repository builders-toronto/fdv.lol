export const NARRATIVE_BUCKETS = {
	infra: {
		label: "Infrastructure",
		mints: [
			// Example token mints/program IDs go here.
		],
	},
	defi: {
		label: "DeFi Plumbing",
		mints: [],
	},
	depin: {
		label: "DePIN",
		mints: [],
	},
	meme: {
		label: "Meme / High Velocity",
		mints: [],
	},
	unknown: {
		label: "Unknown",
		mints: [],
	},
};

function _normKey(v) {
	return String(v || "").trim().toLowerCase();
}

export function getNarrativeBucketForMint(mint) {
	const m = _normKey(mint);
	if (!m) return "unknown";

	for (const [key, bucket] of Object.entries(NARRATIVE_BUCKETS)) {
		if (!bucket || typeof bucket !== "object") continue;
		const list = Array.isArray(bucket.mints) ? bucket.mints : [];
		for (const x of list) {
			if (_normKey(x) === m) return key;
		}
	}
	return "unknown";
}

export function getNarrativeBucketLabel(bucketKey) {
	const k = _normKey(bucketKey);
	const b = NARRATIVE_BUCKETS[k];
	return String(b?.label || k || "unknown");
}
