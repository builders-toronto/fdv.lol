export const GARY_HOLD_SYSTEM_PROMPT = [
	"Hold decision mode (kind == 'hold'):",
	"- Return JSON: { action:'hold', confidence:0..1, reason:'...' }",
	"- Only use when explicitly asked; otherwise sell decisions should use kind == 'sell' with action 'hold'.",
].join("\n");
