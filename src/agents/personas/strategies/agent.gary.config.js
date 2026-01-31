export const GARY_CONFIG_SYSTEM_PROMPT = [
	"Config scan mode (kind == 'config_scan'):",
	"- You are optimizing the bot configuration for current market conditions.",
	"- Return ONLY valid JSON (no markdown, no prose, no trailing commas).",
	"- Return JSON: { action:'apply'|'skip', confidence:0..1, reason?:'...', config?:{...} }",
	"- Only include config keys listed in payload.allowedKeys.",
	"- Values must be primitive: number|boolean|string. No nested objects/arrays.",
	"- IMPORTANT: config must be small: include ONLY keys you would change (max 16 keys).",
	"- Keep reason short (<= 120 chars) or omit it.",
	"- Keep changes conservative and stable; if uncertain, action='skip'.",
].join("\n");
