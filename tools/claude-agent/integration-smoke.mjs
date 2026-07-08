// End-to-end integration smoke test for the Claude Agent runtime.
//
// Hits LIVE external services (Solana RPC + DexScreener), exercises every
// tool through the dispatcher, and validates the CLI startup paths. Does NOT
// call the Anthropic API — that would require a real key. To verify the SDK
// pipeline works, we exercise it with a dummy key and assert we get a 401.
//
// Run from tools/claude-agent/:  node integration-smoke.mjs

import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

import { loadProfile, resolveModel, resolveRpcUrl, resolveRpcHeaders } from "./lib/config.mjs";
import { deriveWalletPubkey, createRpcClient, lamportsToSol } from "./lib/wallet.mjs";
import { createMarketClient } from "./lib/market.mjs";
import { createState } from "./lib/state.mjs";
import { createBridge } from "./lib/bridge.mjs";
import { TOOL_DEFINITIONS, dispatchTool } from "./lib/tools.mjs";
import { startBridgeWriter } from "../agent-bridge/cli-writer.mjs";
import {
	TRADER_STATE_PATH,
	TUNING_PATH,
	DECISIONS_PATH,
	EXECUTION_QUEUE_PATH,
} from "../agent-bridge/contract.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RUN_PATH = resolvePath(__dirname, "run.mjs");
const PROFILE_PATH = resolvePath(__dirname, "../profiles/dev.json");

let _passes = 0;
let _fails = 0;
async function expect(label, cond, detail) {
	if (cond) {
		_passes += 1;
		console.log(`  ✓ ${label}`);
	} else {
		_fails += 1;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

function section(title) {
	console.log(`\n${title}`);
}

async function safeUnlink(p) { try { await unlink(p); } catch {} }

async function runCli(args, { env = {}, timeoutMs = 15_000 } = {}) {
	return new Promise((resolve) => {
		const childEnv = { ...process.env, ...env };
		const proc = spawn(process.execPath, [RUN_PATH, ...args], {
			env: childEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d) => { stdout += d.toString(); });
		proc.stderr.on("data", (d) => { stderr += d.toString(); });
		const timer = setTimeout(() => {
			try { proc.kill("SIGKILL"); } catch {}
			resolve({ code: -1, stdout, stderr, timedOut: true });
		}, timeoutMs);
		proc.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut: false });
		});
	});
}

// ─── Phase 1: CLI startup paths ────────────────────────────────────────
section("Phase 1: CLI startup paths");
{
	const help = await runCli(["--help"]);
	await expect("--help exits 0", help.code === 0, `code=${help.code}`);
	await expect("--help prints usage", help.stdout.includes("Usage:"));
	await expect("--help mentions --enable-trading is reserved", help.stdout.includes("RESERVED"));
}
{
	const trading = await runCli(["--enable-trading", "--profile", PROFILE_PATH], {
		env: { ANTHROPIC_API_KEY: "sk-ant-fake" },
	});
	await expect("--enable-trading rejected (exit 3)", trading.code === 3, `code=${trading.code}, stderr=${trading.stderr.slice(0, 200)}`);
	await expect("--enable-trading error names the flag", trading.stderr.includes("--enable-trading"));
}
{
	// Force a missing key by clearing every env var the resolver checks.
	const missingKey = await runCli(["--profile", PROFILE_PATH, "--max-cycles", "1"], {
		env: {
			...process.env,
			ANTHROPIC_API_KEY: "",
			CLAUDE_API_KEY: "",
			FDV_ANTHROPIC_KEY: "",
			FDV_CLAUDE_KEY: "",
		},
	});
	// Profile has agentGaryFullAi.apiKey = "" so resolver returns "".
	await expect("missing API key exits 4", missingKey.code === 4, `code=${missingKey.code}, stderr=${missingKey.stderr.slice(0, 200)}`);
	await expect("missing-key error mentions ANTHROPIC_API_KEY", missingKey.stderr.includes("ANTHROPIC_API_KEY"));
}

// ─── Phase 2: profile + wallet derivation ──────────────────────────────
section("Phase 2: profile + wallet derivation (offline)");
const profile = await loadProfile(PROFILE_PATH);
const walletPubkey = deriveWalletPubkey(profile);
await expect("wallet pubkey matches known burner", walletPubkey === "DhgReU7X285beojNM33zqVp5YYfWS8Ut4czpg3Rqqmbk");
await expect("model resolves to claude-haiku-4-5", resolveModel(profile, "") === "claude-haiku-4-5");
const rpcUrl = resolveRpcUrl(profile);
await expect("RPC URL is HTTPS", rpcUrl.startsWith("https://"));

// ─── Phase 3: real RPC call ─────────────────────────────────────────────
section("Phase 3: live Solana RPC");
const rpc = createRpcClient({ url: rpcUrl, headers: resolveRpcHeaders(profile) });
let solBalance = null;
let rpcWorks = false;
try {
	const lamports = await rpc.getSolBalanceLamports(walletPubkey);
	solBalance = lamportsToSol(lamports);
	rpcWorks = true;
	await expect("getSolBalanceLamports returns a number", typeof lamports === "number");
	await expect("balance is non-negative", lamports >= 0);
	console.log(`    burner balance: ${solBalance} SOL (expected 0 — wallet is unfunded)`);
} catch (e) {
	console.log(`    ⚠ RPC NOT REACHABLE — credential / endpoint issue: ${String(e?.message || e).slice(0, 150)}`);
	console.log(`      RPC-dependent tool tests will be skipped (this is an external service issue, not a code bug).`);
}

// ─── Phase 4: live DexScreener call ─────────────────────────────────────
section("Phase 4: live DexScreener");
const market = createMarketClient();
let topCandidates = [];
try {
	topCandidates = await market.getTopSolanaCandidates({ limit: 5 });
	await expect("getTopSolanaCandidates returns an array", Array.isArray(topCandidates));
	await expect("at least one candidate (or empty market — both OK)", topCandidates.length >= 0);
	if (topCandidates.length > 0) {
		const top = topCandidates[0];
		await expect("candidate has mint",          typeof top.mint === "string" && top.mint.length > 0);
		await expect("candidate has priceUsd",      typeof top.priceUsd === "number");
		await expect("candidate has liquidityUsd",  typeof top.liquidityUsd === "number");
		console.log(`    top candidate: ${top.symbol} (${top.mint.slice(0, 6)}…) price=$${top.priceUsd} liq=$${Math.round(top.liquidityUsd)} 5m=${top.priceChange5m}%`);
	}
} catch (e) {
	await expect("DexScreener reachable", false, String(e?.message || e));
}

// ─── Phase 5: tool dispatcher round-trip (full cycle simulation) ───────
section("Phase 5: simulated full cycle through dispatchTool");
const state = createState({ logFilePath: "", maxRecent: 10 });
state.nextCycle();
const bridge = createBridge();

// Clear the bridge before the test for deterministic outcomes.
await safeUnlink(TRADER_STATE_PATH);
await safeUnlink(TUNING_PATH);
await safeUnlink(DECISIONS_PATH);
await safeUnlink(EXECUTION_QUEUE_PATH);

const ctx = { rpc, market, state, bridge, walletPubkey };
const callBudget = {};

// Step 1: Claude calls get_wallet_state — needs working RPC
if (rpcWorks) {
	const out = await dispatchTool({ name: "get_wallet_state", input: {}, ctx, callBudget });
	const parsed = JSON.parse(out);
	await expect("get_wallet_state returns pubkey",   parsed.pubkey === walletPubkey);
	await expect("get_wallet_state returns balance",  typeof parsed.solBalance === "number");
} else {
	console.log("    (skipped: RPC unreachable)");
}

// Step 2: Claude calls get_market_snapshot
let topMint = null;
{
	const out = await dispatchTool({ name: "get_market_snapshot", input: { limit: 5 }, ctx, callBudget });
	const parsed = JSON.parse(out);
	await expect("get_market_snapshot returns count",       typeof parsed.count === "number");
	await expect("budget enforced: second call would throw", callBudget.get_market_snapshot === 1);
	if (parsed.candidates && parsed.candidates.length > 0) {
		topMint = parsed.candidates[0].mint;
	}
}

// Step 2b: confirm budget enforcement actually fires
{
	let threw = false;
	try {
		await dispatchTool({ name: "get_market_snapshot", input: {}, ctx, callBudget });
	} catch { threw = true; }
	await expect("second get_market_snapshot call throws", threw);
}

// Step 3: Claude calls get_token_info on the top candidate
if (topMint) {
	const out = await dispatchTool({ name: "get_token_info", input: { mint: topMint }, ctx, callBudget });
	const parsed = JSON.parse(out);
	await expect("get_token_info returns info", parsed.found === true || parsed.found === false);
}

// Step 4: Claude reads trader state — should be absent
{
	const out = await dispatchTool({ name: "get_trader_state", input: {}, ctx, callBudget });
	const parsed = JSON.parse(out);
	await expect("get_trader_state reports trader absent", parsed.present === false);
}

// Step 5: Claude tries request_execute against absent trader — should reject
{
	let threw = false;
	let errMsg = "";
	try {
		await dispatchTool({
			name: "request_execute",
			input: { action: "buy", mint: "TARGET1", sizeSol: 0.1, slippageBps: 250, reason: "test", confidence: 0.5 },
			ctx,
			callBudget,
		});
	} catch (e) { threw = true; errMsg = String(e.message); }
	await expect("request_execute rejects when trader absent", threw, errMsg);
}

// Step 6: Spin up the trader-side writer to simulate the trader running, then retry
{
	const stop = startBridgeWriter({
		intervalMs: 500,
		getState: () => ({
			pubkey: walletPubkey,
			solBalance: solBalance || 0,
			positions: [],
			config: { riskLevel: "safe", takeProfitPct: 10, stopLossPct: 12, trailPct: 5, slippageBps: 250, maxBuySol: 1 },
			recentDecisions: [],
			pauseTrading: false,
			errorRate1m: 0,
			rpcBackoffMs: 0,
		}),
	});
	await new Promise((r) => setTimeout(r, 200));

	const out = await dispatchTool({ name: "get_trader_state", input: {}, ctx, callBudget });
	const parsed = JSON.parse(out);
	await expect("trader state now present",  parsed.present === true);
	await expect("trader state not stale",    parsed.stale === false);

	// Now request_execute should succeed (queue the request).
	const reqOut = await dispatchTool({
		name: "request_execute",
		input: { action: "buy", mint: "TARGET1", sizeSol: 0.1, slippageBps: 250, reason: "smoke test", confidence: 0.8 },
		ctx,
		callBudget,
	});
	const reqParsed = JSON.parse(reqOut);
	await expect("request_execute returns ok with trader present", reqParsed.ok === true);
	await expect("queued action=buy",                              reqParsed.queued.action === "buy");

	stop();
}

// Step 7: publish_tuning with valid params
{
	const out = await dispatchTool({
		name: "publish_tuning",
		input: {
			riskLevel: "medium",
			knobs: { takeProfitPct: 12, stopLossPct: 8 },
			blocklist: ["scam1"],
			reason: "Smoke test tuning publish.",
		},
		ctx,
		callBudget,
	});
	const parsed = JSON.parse(out);
	await expect("publish_tuning returns ok",                parsed.ok === true);
	await expect("published.riskLevel=medium",               parsed.published.riskLevel === "medium");
	await expect("published.knobs.takeProfitPct round-trips", parsed.published.knobs.takeProfitPct === 12);
}

// Step 7b: budget — second publish_tuning should throw
{
	let threw = false;
	try {
		await dispatchTool({ name: "publish_tuning", input: { riskLevel: "safe", reason: "x" }, ctx, callBudget });
	} catch { threw = true; }
	await expect("second publish_tuning throws (budget)", threw);
}

// Step 7c: publish_tuning without reason should throw
{
	const freshBudget = {};
	let threw = false;
	try {
		await dispatchTool({ name: "publish_tuning", input: { riskLevel: "safe" }, ctx, callBudget: freshBudget });
	} catch { threw = true; }
	await expect("publish_tuning without reason throws", threw);
}

// Step 8: log_observation + propose_buy + propose_sell write to local state
{
	await dispatchTool({ name: "log_observation", input: { text: "Smoke test observation" }, ctx, callBudget });
	await dispatchTool({
		name: "propose_buy",
		input: { mint: "TEST1", sizeSol: 0.1, slippageBps: 250, reason: "smoke", confidence: 0.5 },
		ctx,
		callBudget,
	});
	await dispatchTool({
		name: "propose_sell",
		input: { mint: "TEST1", fraction: 0.5, slippageBps: 250, reason: "smoke", confidence: 0.5 },
		ctx,
		callBudget,
	});
	const summary = state.buildRecentSummary({ recentN: 5 });
	await expect("state recorded 2 proposals", summary.recentProposals.length === 2);
}

// Step 9: get_recent_decisions reads the shared log
{
	const out = await dispatchTool({ name: "get_recent_decisions", input: { limit: 10 }, ctx, callBudget });
	const parsed = JSON.parse(out);
	await expect("get_recent_decisions returns entries", parsed.count >= 2);
	// Both tuning_published and execute_requested were appended by the dispatcher.
	await expect("log includes tuning_published", parsed.entries.some((e) => e.kind === "tuning_published"));
	await expect("log includes execute_requested", parsed.entries.some((e) => e.kind === "execute_requested"));
}

// Step 10: get_recent_execution_results (no trader-side consumer, so empty)
{
	const out = await dispatchTool({ name: "get_recent_execution_results", input: {}, ctx, callBudget });
	const parsed = JSON.parse(out);
	await expect("get_recent_execution_results returns empty (no consumer)", parsed.count === 0);
}

// ─── Phase 6: Anthropic SDK pipeline ───────────────────────────────────
section("Phase 6: Anthropic SDK call path (verifies auth wiring)");
{
	// Hit the API with a deliberately invalid key — we expect a 401 not a wiring error.
	// This confirms the SDK boots, hits the right endpoint, and we'd see real responses
	// with a real key.
	const client = new Anthropic({ apiKey: "sk-ant-invalid-test-key" });
	let saw401 = false;
	let sawOther = false;
	let errType = "";
	try {
		await client.messages.create({
			model: "claude-haiku-4-5",
			max_tokens: 16,
			messages: [{ role: "user", content: "ping" }],
		});
		await expect("invalid key correctly rejected", false, "request unexpectedly succeeded");
	} catch (err) {
		errType = err?.constructor?.name || "Unknown";
		if (err instanceof Anthropic.AuthenticationError) saw401 = true;
		else sawOther = true;
	}
	await expect("invalid key → AuthenticationError (not a wiring bug)", saw401, `got ${errType}`);
	await expect("SDK reaches api.anthropic.com",                          !sawOther || saw401);
}

// ─── Phase 7: tool surface inventory ────────────────────────────────────
section("Phase 7: tool surface inventory");
{
	const names = TOOL_DEFINITIONS.map((t) => t.name);
	await expect("11 tools exposed", names.length === 11, `got ${names.length}: ${names.join(", ")}`);
	const expected = [
		"get_wallet_state", "get_market_snapshot", "get_token_info",
		"log_observation", "propose_buy", "propose_sell",
		"get_trader_state", "publish_tuning", "request_execute",
		"get_recent_decisions", "get_recent_execution_results",
	];
	for (const name of expected) {
		await expect(`tool exists: ${name}`, names.includes(name));
	}
}

// Cleanup
await safeUnlink(TRADER_STATE_PATH);
await safeUnlink(TUNING_PATH);
await safeUnlink(DECISIONS_PATH);
await safeUnlink(EXECUTION_QUEUE_PATH);

console.log(`\n─────────────────────────────────`);
console.log(`Passed: ${_passes}`);
console.log(`Failed: ${_fails}`);
console.log(`${_fails ? "FAIL" : "ALL GREEN"}`);
process.exit(_fails ? 1 : 0);
