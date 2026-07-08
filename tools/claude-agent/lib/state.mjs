// In-memory + on-disk decision log. Persists across cycles within a session;
// the per-cycle seed (see prompt.mjs) reads the most recent N entries.

import { appendFile } from "node:fs/promises";

export function createState({ logFilePath = "", maxRecent = 20 } = {}) {
	const decisions = [];
	const observations = [];
	const proposals = [];

	let cycle = 0;
	let lastError = null;

	async function persist(kind, payload) {
		if (!logFilePath) return;
		const line = JSON.stringify({ ts: new Date().toISOString(), kind, ...payload }) + "\n";
		try { await appendFile(logFilePath, line, "utf8"); } catch (e) {
			lastError = String(e?.message || e);
		}
	}

	return {
		get cycle() { return cycle; },
		nextCycle() { cycle += 1; return cycle; },
		get lastError() { return lastError; },

		async recordObservation(text) {
			const entry = { cycle, text: String(text || "").slice(0, 1000) };
			observations.push(entry);
			while (observations.length > maxRecent * 3) observations.shift();
			await persist("observation", entry);
		},

		async recordProposal({ actionType, mint, sizeSol, reason, confidence }) {
			const entry = {
				cycle,
				actionType: String(actionType || ""),
				mint: String(mint || ""),
				sizeSol: Number(sizeSol) || 0,
				reason: String(reason || "").slice(0, 500),
				confidence: Number(confidence) || 0,
			};
			proposals.push(entry);
			while (proposals.length > maxRecent * 3) proposals.shift();
			await persist("proposal", entry);
			return entry;
		},

		async recordCycleSummary({ text, usage, model, durationMs }) {
			const entry = {
				cycle,
				text: String(text || "").slice(0, 2000),
				usage,
				model,
				durationMs,
			};
			decisions.push(entry);
			while (decisions.length > maxRecent) decisions.shift();
			await persist("cycle_summary", entry);
			return entry;
		},

		async recordError(err) {
			const entry = { cycle, error: String(err?.stack || err?.message || err) };
			lastError = entry.error;
			await persist("error", entry);
		},

		// Tiny summary used to seed the next cycle's prompt.
		buildRecentSummary({ recentN = 5 } = {}) {
			const lastDecisions = decisions.slice(-recentN);
			const lastProposals = proposals.slice(-recentN);
			return {
				cycle,
				recentProposals: lastProposals.map((p) => ({
					cycle: p.cycle,
					action: p.actionType,
					mint: p.mint,
					sizeSol: p.sizeSol,
				})),
				recentDecisionsSummary: lastDecisions.map((d) => ({
					cycle: d.cycle,
					note: d.text.slice(0, 200),
				})),
			};
		},
	};
}
