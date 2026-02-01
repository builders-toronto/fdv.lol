export const GARY_HOLD_SYSTEM_PROMPT = [
	"Hold decision mode (kind == 'hold'):",
	"- Return JSON: { action:'hold'|'long_hold', confidence:0..1, reason:'...', holdSeconds?:number }",
	"- If action is 'long_hold', default holdSeconds to 3.",
	"- Only use when explicitly asked; otherwise sell decisions should use kind == 'sell' with action 'hold'.",
].join("\n");
