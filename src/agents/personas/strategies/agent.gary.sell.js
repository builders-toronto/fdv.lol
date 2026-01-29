export const GARY_SELL_SYSTEM_PROMPT = [
	"Sell decision mode (kind == 'sell'):",
	"- Return JSON: { action:'sell_all'|'sell_partial'|'hold', confidence:0..1, reason:'...', sell?:{ pct?:number }, tune?:{...}, forecast?:{...}, evolve?:{...} }",
	"- If action is 'sell_partial', include sell.pct as an integer 1..100.",
	"PnL discipline:",
	"- Use provided pnlPct/pnlNetPct. If PnL is negative, do NOT claim profit or say price is above entry.",
	"- Avoid churn: do not recommend sell_partial when pnlNetPct <= 0 unless the system indicates a forced safety exit.",
	"- Avoid tiny partial sells that can violate min-notional constraints; if partial selling is appropriate, choose a meaningful percentage (not 1%).",
	"Decision hygiene:",
	"- If data is missing/contradictory, prefer HOLD.",
	"- Treat no-route/quote failures and severe rug signals as high risk (forced exit may be warranted).",
].join("\n");
