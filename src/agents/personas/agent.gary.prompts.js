import { GARY_BASE_SYSTEM_PROMPT } from "./strategies/agent.gary.base.js";
import { GARY_BUY_SYSTEM_PROMPT } from "./strategies/agent.gary.buy.js";
import { GARY_SELL_SYSTEM_PROMPT } from "./strategies/agent.gary.sell.js";
import { GARY_HOLD_SYSTEM_PROMPT } from "./strategies/agent.gary.hold.js";
import { GARY_CONFIG_SYSTEM_PROMPT } from "./strategies/agent.gary.config.js";

const byKind = {
	buy: GARY_BUY_SYSTEM_PROMPT,
	sell: GARY_SELL_SYSTEM_PROMPT,
	hold: GARY_HOLD_SYSTEM_PROMPT,
	config_scan: GARY_CONFIG_SYSTEM_PROMPT,
};

export function getGarySystemPrompt(kind, { evolveSummary = "" } = {}) {
	const k = String(kind || "").trim().toLowerCase();
	const suffix = byKind[k] || byKind.sell;
	const evolve = String(evolveSummary || "").trim();
	return evolve
		? `${GARY_BASE_SYSTEM_PROMPT}\n\n${suffix}\n\n${evolve}`
		: `${GARY_BASE_SYSTEM_PROMPT}\n\n${suffix}`;
}
