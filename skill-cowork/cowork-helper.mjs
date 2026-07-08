#!/usr/bin/env node
// Self-contained cowork helper. Reads and writes the trader<->Claude bridge
// with the safety contract enforced inline (no imports from the repo —
// installable standalone). Designed to be invoked from a Claude session's
// Bash tool: every command prints structured, parseable output.
//
// Usage:
//   node cowork-helper.mjs status [--bridge-dir <path>]
//   node cowork-helper.mjs decisions [--tail 20]
//   node cowork-helper.mjs results [--tail 20]
//   node cowork-helper.mjs tune --reason "<text>" [options]
//   node cowork-helper.mjs queue-buy <mint> --sol <n> --slip <bps> --reason "<text>" [--ttl <s>]
//   node cowork-helper.mjs queue-sell <mint> --frac <n> --slip <bps> --reason "<text>" [--ttl <s>]
//   node cowork-helper.mjs observe "<text>"
//   node cowork-helper.mjs market-snapshot [--limit 10]
//   node cowork-helper.mjs token-info <mint>
//   node cowork-helper.mjs scout [--limit 5]
//   node cowork-helper.mjs watch add <mint> [--note "<text>"]
//   node cowork-helper.mjs watch remove <mint>
//   node cowork-helper.mjs watch list
//   node cowork-helper.mjs retro <mint> --entry <sol> --exit <sol> --peak <pct> --reason "<text>" [--note "<text>"]
//
// Tuning options:
//   --risk safe|medium|degen          set risk level
//   --tp <pct>                        takeProfitPct (clamped 1-100)
//   --sl <pct>                        stopLossPct   (clamped 2-50)
//   --trail <pct>                     trailPct      (clamped 0.5-20)
//   --slip <bps>                      slippageBps   (clamped 50-1000)
//   --watch <mint>                    add to watchlist (repeatable, max 20)
//   --block <mint>                    add to blocklist (repeatable, max 200)
//   --pause / --unpause               set pauseTrading
//
// All paths default to <bridge-dir>/* under tools/agent-bridge/ relative to CWD.
// Override with --bridge-dir <abs-path> if installed elsewhere.

import { readFile, writeFile, appendFile, mkdir, rename } from "node:fs/promises";
import { resolve as resolvePath, dirname } from "node:path";
import process from "node:process";

// ─── Contract (inlined — must match tools/agent-bridge/contract.mjs) ──

const CONTRACT_VERSION = 2;
const STATE_STALE_MS = 15_000;
const TUNING_RISK_LEVELS = ["safe", "medium", "degen"];
const TUNING_MAX_WATCHLIST = 20;
const TUNING_MAX_BLOCKLIST = 200;
const TUNING_KNOB_BOUNDS = {
	takeProfitPct: { min: 1,   max: 100, alias: "tp" },
	stopLossPct:   { min: 2,   max: 50,  alias: "sl" },
	trailPct:      { min: 0.5, max: 20,  alias: "trail" },
	slippageBps:   { min: 50,  max: 1000, alias: "slip" },
};
const EXECUTION_TTL_SECS_DEFAULT = 60;
const EXECUTION_TTL_SECS_MAX = 300;

// Hold contract bounds (mirror src/vista/addons/auto/hold/index.js:371-373).
const HOLD_BOUNDS = {
	pollMs:          { min: 250,  max: 60_000 },
	buyPct:          { min: 10,   max: 70 },
	profitPct:       { min: 0.1,  max: 500 },
	rugSevThreshold: { min: 1,    max: 4 },
};
const HOLD_STOP_KINDS = ["liquidate", "cancel"];

function clampHold(name, value) {
	const b = HOLD_BOUNDS[name];
	if (!b) return null;
	const v = Number(value);
	if (!Number.isFinite(v)) return null;
	return Math.max(b.min, Math.min(b.max, v));
}

function clampKnob(name, value) {
	const bound = TUNING_KNOB_BOUNDS[name];
	if (!bound) return null;
	const v = Number(value);
	if (!Number.isFinite(v)) return null;
	return Math.max(bound.min, Math.min(bound.max, v));
}

// ─── Bridge paths ─────────────────────────────────────────────────────

function resolveBridgePaths(bridgeDirArg) {
	const dir = resolvePath(bridgeDirArg || resolvePath(process.cwd(), "tools/agent-bridge"));
	const claudeDir = resolvePath(dir, "claude-state");
	return {
		dir,
		traderState:        resolvePath(dir, "trader-state.json"),
		tuning:             resolvePath(dir, "tuning.json"),
		decisions:          resolvePath(dir, "decisions.jsonl"),
		executionQueue:     resolvePath(dir, "execution-queue.jsonl"),
		executionResults:   resolvePath(dir, "execution-results.jsonl"),
		holdRequests:       resolvePath(dir, "hold-requests.jsonl"),
		holdEvents:         resolvePath(dir, "hold-events.jsonl"),
		// Claude-side persistence (watchlist + retrospective journal).
		// Lives under the bridge dir but separate from the trader<->Claude protocol.
		claudeDir,
		watchlist:          resolvePath(claudeDir, "watchlist.json"),
		retroJournal:       resolvePath(claudeDir, "retro.jsonl"),
	};
}

async function ensureDir(filePath) {
	try { await mkdir(dirname(filePath), { recursive: true }); } catch {}
}

async function atomicWriteJson(filePath, obj) {
	await ensureDir(filePath);
	const tmp = `${filePath}.tmp`;
	await writeFile(tmp, JSON.stringify(obj, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
	await rename(tmp, filePath);
}

async function readJsonOrNull(filePath) {
	try {
		const raw = await readFile(filePath, "utf8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

async function readJsonlTail(filePath, n) {
	try {
		const raw = await readFile(filePath, "utf8");
		const lines = raw.split("\n").filter(Boolean);
		const tail = lines.slice(-Math.max(0, Math.floor(n)));
		const out = [];
		for (const line of tail) {
			try { out.push(JSON.parse(line)); } catch {}
		}
		return out;
	} catch {
		return [];
	}
}

// ─── Arg parsing (no deps) ────────────────────────────────────────────

function parseArgs(argv) {
	const out = { _: [], flags: new Set(), opts: {} };
	const repeatable = new Set(["watch", "block"]);
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) {
				out.flags.add(key);
			} else if (repeatable.has(key)) {
				out.opts[key] = out.opts[key] || [];
				out.opts[key].push(next);
				i += 1;
			} else {
				out.opts[key] = next;
				i += 1;
			}
		} else {
			out._.push(a);
		}
	}
	return out;
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function fail(msg) { console.error(JSON.stringify({ ok: false, error: msg })); process.exit(2); }
function ok(payload) { console.log(JSON.stringify({ ok: true, ...payload }, null, 2)); }

// ─── Commands ─────────────────────────────────────────────────────────

async function cmdStatus(paths) {
	const state = await readJsonOrNull(paths.traderState);
	if (!state) {
		return ok({
			present: false,
			stale: true,
			ageMs: null,
			message: "Trader is not running (no trader-state.json found). The standalone agent can still observe markets and propose, but cannot tune or queue execution.",
			bridgeDir: paths.dir,
		});
	}
	const ts = state.ts ? Date.parse(state.ts) : NaN;
	const ageMs = Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : null;
	const stale = ageMs == null || ageMs > STATE_STALE_MS;
	return ok({
		present: true,
		stale,
		ageMs,
		warning: stale ? `State is stale (age=${ageMs}ms > ${STATE_STALE_MS}ms). Trader may be down. Avoid execute requests.` : null,
		state,
	});
}

async function cmdDecisions(paths, tail) {
	const entries = await readJsonlTail(paths.decisions, tail);
	return ok({ count: entries.length, entries });
}

async function cmdResults(paths, tail) {
	const entries = await readJsonlTail(paths.executionResults, tail);
	return ok({ count: entries.length, entries });
}

async function cmdObserve(paths, text) {
	if (!text) fail("observe requires text");
	await ensureDir(paths.decisions);
	const line = JSON.stringify({
		contractVersion: CONTRACT_VERSION,
		ts: new Date().toISOString(),
		source: "agent-runtime",  // chat-driven Claude appears the same as the API agent in the log
		kind: "observation",
		note: String(text).slice(0, 1000),
	}) + "\n";
	await appendFile(paths.decisions, line, "utf8");
	return ok({ appended: true, kind: "observation" });
}

async function cmdTune(paths, opts) {
	if (!opts.opts.reason) fail("tune requires --reason \"<text>\"");

	// Surface that tuning is a no-op for the current Hold-only runtime.
	// The Hold runner's bridge poller only honors start/update/stop hold
	// requests, not the legacy auto-trader tuning channel. Without this
	// warning the call silently writes a tuning.json that nothing reads.
	const traderState = await readJsonOrNull(paths.traderState);
	const holdsRunning = Array.isArray(traderState?.holds) && traderState.holds.length >= 0;
	const hasAutoPositions = Array.isArray(traderState?.positions) && traderState.positions.length > 0;
	if (holdsRunning && !hasAutoPositions) {
		console.error("[warn] tune is for the legacy auto-trader. The Hold runner does NOT consume tuning.json. For Hold parameter changes, use update-hold <holdId> instead.");
	}

	const prev = await readJsonOrNull(paths.tuning);
	const prevVersion = Number(prev?.version) || 0;

	const tuning = {
		contractVersion: CONTRACT_VERSION,
		ts: new Date().toISOString(),
		version: prevVersion + 1,
		riskLevel: null,
		watchlist: [],
		blocklist: [],
		knobs: {},
		pauseTrading: null,
		reason: String(opts.opts.reason).slice(0, 500),
	};

	if (opts.opts.risk) {
		const rl = String(opts.opts.risk).trim().toLowerCase();
		if (!TUNING_RISK_LEVELS.includes(rl)) fail(`--risk must be one of ${TUNING_RISK_LEVELS.join(", ")}`);
		tuning.riskLevel = rl;
	}

	// knobs (aliased on CLI as --tp / --sl / --trail / --slip)
	for (const [knobName, bound] of Object.entries(TUNING_KNOB_BOUNDS)) {
		const raw = opts.opts[bound.alias];
		if (raw == null) continue;
		const clamped = clampKnob(knobName, raw);
		if (clamped == null) fail(`--${bound.alias} must be a number`);
		tuning.knobs[knobName] = clamped;
	}

	if (opts.opts.watch) {
		const watch = (Array.isArray(opts.opts.watch) ? opts.opts.watch : [opts.opts.watch])
			.map((m) => String(m).trim()).filter(Boolean);
		if (watch.length > TUNING_MAX_WATCHLIST) fail(`watchlist max ${TUNING_MAX_WATCHLIST}`);
		tuning.watchlist = watch;
	}

	if (opts.opts.block) {
		const block = (Array.isArray(opts.opts.block) ? opts.opts.block : [opts.opts.block])
			.map((m) => String(m).trim()).filter(Boolean);
		if (block.length > TUNING_MAX_BLOCKLIST) fail(`blocklist max ${TUNING_MAX_BLOCKLIST}`);
		tuning.blocklist = block;
	}

	if (opts.flags.has("pause")) tuning.pauseTrading = true;
	if (opts.flags.has("unpause")) tuning.pauseTrading = false;

	const meaningfulFields = [
		tuning.riskLevel,
		Object.keys(tuning.knobs).length ? "knobs" : null,
		tuning.watchlist.length ? "watch" : null,
		tuning.blocklist.length ? "block" : null,
		tuning.pauseTrading,
	].filter((v) => v !== null && v !== undefined && v !== "" && v !== false);
	if (meaningfulFields.length === 0 && tuning.pauseTrading !== false) {
		fail("tune requires at least one of --risk / --tp / --sl / --trail / --slip / --watch / --block / --pause / --unpause");
	}

	await atomicWriteJson(paths.tuning, tuning);

	// Mirror to the decision log so it's visible alongside trader decisions.
	await ensureDir(paths.decisions);
	await appendFile(paths.decisions, JSON.stringify({
		contractVersion: CONTRACT_VERSION,
		ts: tuning.ts,
		source: "agent-runtime",
		kind: "tuning_published",
		version: tuning.version,
		riskLevel: tuning.riskLevel,
		knobs: tuning.knobs,
		reason: tuning.reason,
	}) + "\n", "utf8");

	return ok({ written: paths.tuning, tuning });
}

async function cmdQueue(paths, action, posArg, opts) {
	if (!posArg) fail(`${action} requires a mint as first positional argument`);

	// Block execution against a missing/stale trader so requests don't pile up
	// in the queue waiting for a trader that's not coming back.
	const state = await readJsonOrNull(paths.traderState);
	if (!state) fail("trader is not running (no trader-state.json) — refusing to queue execution. Use the observe / tune commands instead.");
	const ts = state.ts ? Date.parse(state.ts) : NaN;
	const ageMs = Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : null;
	if (ageMs == null || ageMs > STATE_STALE_MS) fail(`trader state is stale (age=${ageMs}ms). Trader may be down — refusing to queue execution.`);

	if (!opts.opts.reason) fail(`${action} requires --reason "<text>"`);
	const slippageBps = Math.floor(num(opts.opts.slip) || 250);
	if (slippageBps < 50 || slippageBps > 5000) fail("--slip must be 50–5000 bps");

	const ttlSecs = Math.min(EXECUTION_TTL_SECS_MAX, Math.max(5, Math.floor(num(opts.opts.ttl) || EXECUTION_TTL_SECS_DEFAULT)));

	const req = {
		contractVersion: CONTRACT_VERSION,
		id: `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
		ts: new Date().toISOString(),
		action,
		mint: String(posArg),
		slippageBps,
		reason: String(opts.opts.reason).slice(0, 500),
		confidence: num(opts.opts.confidence) || 0.5,
		ttlSecs,
		expiresAt: new Date(Date.now() + ttlSecs * 1000).toISOString(),
	};

	if (action === "buy") {
		const s = num(opts.opts.sol);
		if (s == null || s <= 0) fail("buy requires --sol <positive number>");
		req.sizeSol = s;
	} else {
		const f = num(opts.opts.frac);
		if (f == null || f <= 0 || f > 1) fail("sell requires --frac in (0, 1]");
		req.fraction = f;
	}

	await ensureDir(paths.executionQueue);
	await appendFile(paths.executionQueue, JSON.stringify(req) + "\n", "utf8");

	// Mirror to decisions
	await ensureDir(paths.decisions);
	await appendFile(paths.decisions, JSON.stringify({
		contractVersion: CONTRACT_VERSION,
		ts: req.ts,
		source: "agent-runtime",
		kind: "execute_requested",
		id: req.id,
		action: req.action,
		mint: req.mint,
		sizeSol: req.sizeSol,
		fraction: req.fraction,
		reason: req.reason,
	}) + "\n", "utf8");

	return ok({
		queued: req,
		note: "Queued in execution-queue.jsonl. Trader will process ONLY if started with --accept-claude-execution AND request passes its safety policies. Check results with: node cowork-helper.mjs results --tail 10",
	});
}

// ─── Hold commands (v2) ──────────────────────────────────────────────

async function cmdHolds(paths, opts) {
	const state = await readJsonOrNull(paths.traderState);
	if (!state) {
		return ok({
			present: false,
			stale: true,
			count: 0,
			activeCount: 0,
			holds: [],
			message: "No Hold runner detected (trader-state.json not found).",
		});
	}
	const ts = state.ts ? Date.parse(state.ts) : NaN;
	const ageMs = Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : null;
	const stale = ageMs == null || ageMs > STATE_STALE_MS;
	const all = Array.isArray(state.holds) ? state.holds : [];
	const wallet = state.wallet || null;
	// By default, return only ACTIVE holds (buying or holding). Closed/idle/stopped
	// holds linger in trader-state.holds as a "last cycle" record — they should
	// not be surfaced as live by default because callers that branch on
	// `count > 0` would otherwise mis-treat residue as in-flight work.
	// Pass --all to see everything including the last closed cycle.
	const isActive = (h) => h && (h.status === "holding" || h.status === "buying" || h.status === "ready");
	const visible = opts?.flags?.has("all") ? all : all.filter(isActive);
	const activeCount = all.filter(isActive).length;
	return ok({
		present: true,
		stale,
		ageMs,
		count: visible.length,
		activeCount,
		totalCount: all.length,
		holds: visible,
		wallet,
	});
}

async function cmdHold(paths, holdId) {
	if (!holdId) fail("hold requires a holdId as positional argument");
	const state = await readJsonOrNull(paths.traderState);
	if (!state) fail("No Hold runner detected (trader-state.json not found).");
	const holds = Array.isArray(state.holds) ? state.holds : [];
	const hold = holds.find((h) => h.holdId === holdId);
	if (!hold) fail(`No hold with id ${holdId} found. Use 'holds' to list active holds.`);
	const events = await readJsonlTail(paths.holdEvents, 30);
	const myEvents = events.filter((e) => e.holdId === holdId).slice(-10);
	return ok({ hold, recentEvents: myEvents });
}

// Solana base58 mint validator. Mints are 32-byte pubkeys encoded as base58
// (32-44 chars), excluding 0OIl. Rejects empty strings, placeholders, and
// obvious typos before they hit the runner and spawn useless bots.
const SOLANA_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function validateSolanaMint(mint) {
	const m = String(mint || "").trim();
	if (!m) return { ok: false, reason: "empty mint" };
	if (!SOLANA_MINT_RE.test(m)) return { ok: false, reason: `not a valid base58 mint (got ${m.length} chars: "${m.slice(0, 20)}${m.length > 20 ? "…" : ""}")` };
	return { ok: true, mint: m };
}

async function cmdStartHold(paths, mint, opts) {
	if (!mint) fail("start-hold requires a mint as positional argument");
	const mv = validateSolanaMint(mint);
	if (!mv.ok) fail(`start-hold: ${mv.reason}`);
	if (!opts.opts.reason) fail("start-hold requires --reason \"<text>\"");

	// Pre-flight: don't queue a request when nothing's listening for it.
	const state = await readJsonOrNull(paths.traderState);
	if (!state) fail("No Hold runner detected (trader-state.json not found). Start the runner before queuing a Hold.");
	const ts = state.ts ? Date.parse(state.ts) : NaN;
	const ageMs = Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : null;
	if (ageMs == null || ageMs > STATE_STALE_MS) {
		fail(`Hold runner state is stale (ageMs=${ageMs}). Runner may be down — refusing to queue start.`);
	}
	// Don't queue a start when a bot is already active — runner would reject
	// with buy_failed but caller gets ok:true and can't tell. Block it here so
	// the failure is loud and immediate.
	const existingHolds = Array.isArray(state.holds) ? state.holds : [];
	const activeExisting = existingHolds.find((h) => h && (h.status === "holding" || h.status === "buying" || h.status === "ready"));
	if (activeExisting) {
		fail(`A Hold is already active (holdId=${activeExisting.holdId}, mint=${activeExisting.mint}, status=${activeExisting.status}). Stop or wait for it first.`);
	}

	const req = {
		contractVersion: CONTRACT_VERSION,
		id: `hreq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
		ts: new Date().toISOString(),
		action: "start",
		mint: mv.mint,
		reason: String(opts.opts.reason).slice(0, 500),
		ttlSecs: Math.min(EXECUTION_TTL_SECS_MAX, Math.max(5, num(opts.opts.ttl) || EXECUTION_TTL_SECS_DEFAULT)),
	};
	req.expiresAt = new Date(Date.now() + req.ttlSecs * 1000).toISOString();

	// Optional knobs — only attach if explicitly set, so the runner uses Hold's defaults otherwise.
	for (const [name, alias] of [["pollMs", "poll-ms"], ["buyPct", "buy-pct"], ["profitPct", "profit-pct"], ["rugSevThreshold", "rug-sev"]]) {
		const v = opts.opts[alias];
		if (v == null) continue;
		const c = clampHold(name, v);
		if (c == null) fail(`--${alias} must be a number`);
		req[name] = name === "rugSevThreshold" ? Math.floor(c) : c;
	}
	if (opts.flags.has("repeat-buy")) req.repeatBuy = true;
	if (opts.flags.has("no-uptick")) req.uptickEnabled = false;
	else if (opts.flags.has("uptick")) req.uptickEnabled = true;

	await ensureDir(paths.holdRequests);
	await appendFile(paths.holdRequests, JSON.stringify(req) + "\n", "utf8");

	// Mirror to decision log for visibility.
	await ensureDir(paths.decisions);
	await appendFile(paths.decisions, JSON.stringify({
		contractVersion: CONTRACT_VERSION,
		ts: req.ts,
		source: "agent-runtime",
		kind: "hold_requested",
		holdReqId: req.id,
		mint: req.mint,
		reason: req.reason,
	}) + "\n", "utf8");

	return ok({
		queued: req,
		note: "Queued in hold-requests.jsonl. The Hold runner will pick it up on its next poll, start the lifecycle, and emit accepted/buy_attempted/buy_executed events. Use 'holds' to track or 'hold-events --tail' to watch.",
	});
}

async function cmdUpdateHold(paths, holdId, opts) {
	if (!holdId) fail("update-hold requires a holdId");
	if (!opts.opts.reason) fail("update-hold requires --reason \"<text>\"");

	const state = await readJsonOrNull(paths.traderState);
	if (!state) fail("No Hold runner detected.");
	const holds = Array.isArray(state.holds) ? state.holds : [];
	if (!holds.find((h) => h.holdId === holdId)) {
		fail(`No hold with id ${holdId} found.`);
	}

	const req = {
		contractVersion: CONTRACT_VERSION,
		id: `hreq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
		ts: new Date().toISOString(),
		action: "update",
		holdId: String(holdId),
		reason: String(opts.opts.reason).slice(0, 500),
		ttlSecs: Math.min(EXECUTION_TTL_SECS_MAX, Math.max(5, num(opts.opts.ttl) || EXECUTION_TTL_SECS_DEFAULT)),
	};
	req.expiresAt = new Date(Date.now() + req.ttlSecs * 1000).toISOString();

	let any = false;
	for (const [name, alias] of [["profitPct", "profit-pct"], ["rugSevThreshold", "rug-sev"], ["pollMs", "poll-ms"]]) {
		const v = opts.opts[alias];
		if (v == null) continue;
		const c = clampHold(name, v);
		if (c == null) fail(`--${alias} must be a number`);
		req[name] = name === "rugSevThreshold" ? Math.floor(c) : c;
		any = true;
	}
	if (opts.flags.has("repeat-buy")) { req.repeatBuy = true; any = true; }
	if (opts.flags.has("no-repeat-buy")) { req.repeatBuy = false; any = true; }
	if (!any) fail("update-hold requires at least one of --profit-pct / --rug-sev / --poll-ms / --repeat-buy / --no-repeat-buy");

	await ensureDir(paths.holdRequests);
	await appendFile(paths.holdRequests, JSON.stringify(req) + "\n", "utf8");
	return ok({ queued: req, note: "Update queued; runner will apply on next poll." });
}

async function cmdStopHold(paths, holdId, opts) {
	if (!holdId) fail("stop-hold requires a holdId");
	if (!opts.opts.reason) fail("stop-hold requires --reason \"<text>\"");
	const stopKind = String(opts.opts["stop-kind"] || "liquidate").toLowerCase();
	if (!HOLD_STOP_KINDS.includes(stopKind)) {
		fail(`--stop-kind must be one of ${HOLD_STOP_KINDS.join(", ")}`);
	}

	// Validate the holdId exists in current trader state. Without this, stop
	// requests for unknown bots queue successfully and get silently dropped by
	// the runner — caller has no way to know the stop did nothing.
	const state = await readJsonOrNull(paths.traderState);
	if (!state) fail("No Hold runner detected (trader-state.json not found).");
	const holds = Array.isArray(state.holds) ? state.holds : [];
	const target = holds.find((h) => h.holdId === holdId);
	if (!target) {
		fail(`No hold with id ${holdId} found. Use 'holds --all' to list every hold (active or closed).`);
	}
	// Refuse stop on already-terminal holds — there's nothing to stop.
	if (target.status !== "holding" && target.status !== "buying" && target.status !== "ready") {
		fail(`Hold ${holdId} is in status "${target.status}", not active. Stop requests only apply to ready/buying/holding. No-op refused.`);
	}
	// Stop-liquidate on a "ready" bot (no position yet) makes no sense — there's
	// nothing to sell. Force --stop-kind cancel for ready bots.
	if (target.status === "ready" && stopKind === "liquidate") {
		fail(`Hold ${holdId} is in status "ready" (no position bought yet). Use --stop-kind cancel to halt the lifecycle.`);
	}

	const req = {
		contractVersion: CONTRACT_VERSION,
		id: `hreq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
		ts: new Date().toISOString(),
		action: "stop",
		holdId: String(holdId),
		stopKind,
		reason: String(opts.opts.reason).slice(0, 500),
		ttlSecs: Math.min(EXECUTION_TTL_SECS_MAX, Math.max(5, num(opts.opts.ttl) || EXECUTION_TTL_SECS_DEFAULT)),
	};
	req.expiresAt = new Date(Date.now() + req.ttlSecs * 1000).toISOString();

	await ensureDir(paths.holdRequests);
	await appendFile(paths.holdRequests, JSON.stringify(req) + "\n", "utf8");
	return ok({
		queued: req,
		note: stopKind === "liquidate"
			? "Stop queued (liquidate): runner will exit the position via Jupiter at current quote."
			: "Stop queued (cancel): runner will halt the lifecycle without selling — position stays in wallet.",
	});
}

async function cmdHoldEvents(paths, tail) {
	const entries = await readJsonlTail(paths.holdEvents, tail);
	return ok({ count: entries.length, entries });
}

async function cmdPnl(paths) {
	const state = await readJsonOrNull(paths.traderState);
	if (!state) {
		return ok({ present: false, stale: true, message: "No trader-state.json — runner not active." });
	}
	const ts = state.ts ? Date.parse(state.ts) : NaN;
	const ageMs = Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : null;
	const stale = ageMs == null || ageMs > STATE_STALE_MS;
	const wallet = state.wallet || {};
	const holds = Array.isArray(state.holds) ? state.holds : [];
	const positions = Array.isArray(state.positions) ? state.positions : [];

	// Compute per-hold PnL summary
	const activeHolds = holds.filter((h) => h.status === "holding" || h.status === "buying" || h.status === "ready");
	const totalUnrealizedFromHolds = activeHolds.reduce((s, h) => s + (Number(h.currentPnlSol) || 0), 0);

	return ok({
		present: true,
		stale,
		ageMs,
		solBalance: Number(state.solBalance) || 0,
		realizedPnlSol: Number(wallet.realizedPnlSol) || 0,
		sessionPnlSol: Number(wallet.sessionPnlSol) || 0,
		unrealizedPnlSol: Number(wallet.unrealizedPnlSol) || 0,
		activeHoldCount: activeHolds.length,
		activeHoldUnrealizedSol: totalUnrealizedFromHolds,
		openPositionCount: positions.length,
		flamebar: state.flamebar || null,
	});
}

// ─── DexScreener (optional convenience) ───────────────────────────────

const DEX_BASE = "https://api.dexscreener.com";
const SOL_QUOTE = "So11111111111111111111111111111111111111112";

async function cmdMarketSnapshot(limit) {
	try {
		const [latest, top] = await Promise.all([
			fetch(`${DEX_BASE}/token-boosts/latest/v1`).then((r) => r.ok ? r.json() : []).catch(() => []),
			fetch(`${DEX_BASE}/token-boosts/top/v1`).then((r) => r.ok ? r.json() : []).catch(() => []),
		]);
		const all = [...(Array.isArray(latest) ? latest : []), ...(Array.isArray(top) ? top : [])]
			.filter((b) => b?.chainId === "solana" && b?.tokenAddress);
		const seen = new Set();
		const addrs = [];
		for (const b of all) {
			const a = String(b.tokenAddress);
			if (!seen.has(a)) { seen.add(a); addrs.push(a); }
			if (addrs.length >= 30) break;
		}
		if (!addrs.length) return ok({ count: 0, candidates: [] });

		const resp = await fetch(`${DEX_BASE}/latest/dex/tokens/${addrs.join(",")}`);
		const json = await resp.json();
		const pairs = Array.isArray(json?.pairs) ? json.pairs : [];

		const bestPerMint = new Map();
		for (const p of pairs) {
			if (p?.chainId !== "solana" || p?.quoteToken?.address !== SOL_QUOTE) continue;
			const liq = Number(p?.liquidity?.usd);
			const vol1h = Number(p?.volume?.h1);
			const pc5 = Number(p?.priceChange?.m5);
			if (!Number.isFinite(liq) || liq < 5000) continue;
			if (!Number.isFinite(vol1h) || vol1h < 10_000) continue;
			if (!Number.isFinite(pc5)) continue;
			const mint = String(p?.baseToken?.address || "");
			const shaped = {
				mint,
				symbol: String(p?.baseToken?.symbol || ""),
				priceUsd: Number(p?.priceUsd),
				liquidityUsd: liq,
				volumeUsd1h: vol1h,
				priceChange5m: pc5,
				priceChange1h: Number(p?.priceChange?.h1),
				buys5m: Number(p?.txns?.m5?.buys),
				sells5m: Number(p?.txns?.m5?.sells),
			};
			const prev = bestPerMint.get(mint);
			if (!prev || liq > prev.liquidityUsd) bestPerMint.set(mint, shaped);
		}

		const candidates = [...bestPerMint.values()]
			.sort((a, b) => {
				const A = (a.priceChange5m || 0) * Math.sqrt(a.liquidityUsd || 0);
				const B = (b.priceChange5m || 0) * Math.sqrt(b.liquidityUsd || 0);
				return B - A;
			})
			.slice(0, limit);

		return ok({ count: candidates.length, candidates });
	} catch (e) {
		fail(`market-snapshot failed: ${e?.message || e}`);
	}
}

async function cmdTokenInfo(mint) {
	if (!mint) fail("token-info requires a mint");
	try {
		const resp = await fetch(`${DEX_BASE}/latest/dex/tokens/${encodeURIComponent(mint)}`);
		if (!resp.ok) fail(`DexScreener HTTP ${resp.status}`);
		const json = await resp.json();
		const pairs = (Array.isArray(json?.pairs) ? json.pairs : [])
			.filter((p) => p?.chainId === "solana");
		if (!pairs.length) return ok({ found: false, mint });
		pairs.sort((a, b) => (Number(b?.liquidity?.usd) || 0) - (Number(a?.liquidity?.usd) || 0));
		const p = pairs[0];
		return ok({
			found: true,
			mint,
			pairAddress: p?.pairAddress,
			symbol: p?.baseToken?.symbol,
			priceUsd: Number(p?.priceUsd),
			liquidityUsd: Number(p?.liquidity?.usd),
			fdvUsd: Number(p?.fdv),
			priceChange5m: Number(p?.priceChange?.m5),
			priceChange1h: Number(p?.priceChange?.h1),
			priceChange24h: Number(p?.priceChange?.h24),
			volumeUsd1h: Number(p?.volume?.h1),
			volumeUsd24h: Number(p?.volume?.h24),
			buys5m: Number(p?.txns?.m5?.buys),
			sells5m: Number(p?.txns?.m5?.sells),
		});
	} catch (e) {
		fail(`token-info failed: ${e?.message || e}`);
	}
}

// ─── Continuous monitoring: scout / watch / retro ────────────────────
//
// These commands operationalize the "don't tunnel on a single Hold" pattern:
// `scout` is a one-shot situational read (position + market + watchlist),
// `watch` lets Claude track candidate mints across sessions/calls without
// involving the auto trader's watchlist, and `retro` records closed-position
// outcomes for cross-session pattern matching (paired with Claude memory).

const WATCHLIST_MAX = 20;

async function loadWatchlist(paths) {
	const w = await readJsonOrNull(paths.watchlist);
	if (!w || !Array.isArray(w.entries)) return { version: 1, entries: [] };
	return w;
}

async function saveWatchlist(paths, wl) {
	await atomicWriteJson(paths.watchlist, {
		version: 1,
		updatedAt: new Date().toISOString(),
		entries: wl.entries.slice(0, WATCHLIST_MAX),
	});
}

async function cmdWatch(paths, sub, mint, opts) {
	const wl = await loadWatchlist(paths);
	if (sub === "list" || !sub) {
		return ok({ count: wl.entries.length, entries: wl.entries });
	}
	if (sub === "add") {
		if (!mint) fail("watch add requires a mint");
		const existing = wl.entries.find((e) => e.mint === mint);
		if (existing) {
			if (opts.opts.note) existing.note = String(opts.opts.note).slice(0, 300);
			existing.updatedAt = new Date().toISOString();
		} else {
			if (wl.entries.length >= WATCHLIST_MAX) fail(`watchlist full (max ${WATCHLIST_MAX}) — remove one first`);
			wl.entries.push({
				mint: String(mint),
				addedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				note: opts.opts.note ? String(opts.opts.note).slice(0, 300) : "",
			});
		}
		await saveWatchlist(paths, wl);
		return ok({ added: mint, count: wl.entries.length });
	}
	if (sub === "remove") {
		if (!mint) fail("watch remove requires a mint");
		const before = wl.entries.length;
		wl.entries = wl.entries.filter((e) => e.mint !== mint);
		await saveWatchlist(paths, wl);
		return ok({ removed: before - wl.entries.length, count: wl.entries.length });
	}
	fail(`watch subcommand must be add | remove | list (got: ${sub})`);
}

async function fetchDexForMints(mints) {
	if (!mints.length) return [];
	try {
		const resp = await fetch(`${DEX_BASE}/latest/dex/tokens/${mints.join(",")}`);
		if (!resp.ok) return [];
		const json = await resp.json();
		const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
		const bestPerMint = new Map();
		for (const p of pairs) {
			if (p?.chainId !== "solana" || p?.quoteToken?.address !== SOL_QUOTE) continue;
			const mint = String(p?.baseToken?.address || "");
			if (!mint) continue;
			const liq = Number(p?.liquidity?.usd) || 0;
			const shaped = {
				mint,
				symbol: String(p?.baseToken?.symbol || ""),
				priceUsd: Number(p?.priceUsd),
				liquidityUsd: liq,
				volumeUsd1h: Number(p?.volume?.h1),
				priceChange5m: Number(p?.priceChange?.m5),
				priceChange1h: Number(p?.priceChange?.h1),
				buys5m: Number(p?.txns?.m5?.buys),
				sells5m: Number(p?.txns?.m5?.sells),
			};
			const prev = bestPerMint.get(mint);
			if (!prev || liq > (prev.liquidityUsd || 0)) bestPerMint.set(mint, shaped);
		}
		return [...bestPerMint.values()];
	} catch {
		return [];
	}
}

async function cmdScout(paths, limit) {
	// Position snapshot
	const state = await readJsonOrNull(paths.traderState);
	const ts = state?.ts ? Date.parse(state.ts) : NaN;
	const ageMs = Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : null;
	const stale = !state || ageMs == null || ageMs > STATE_STALE_MS;
	const holds = Array.isArray(state?.holds) ? state.holds : [];
	const activeHolds = holds.filter((h) => h.status === "holding" || h.status === "buying" || h.status === "ready");
	const wallet = state?.wallet || null;

	// Market snapshot (reuse cmdMarketSnapshot logic inline, return data not stdout)
	const marketResult = await (async () => {
		try {
			const [latest, top] = await Promise.all([
				fetch(`${DEX_BASE}/token-boosts/latest/v1`).then((r) => r.ok ? r.json() : []).catch(() => []),
				fetch(`${DEX_BASE}/token-boosts/top/v1`).then((r) => r.ok ? r.json() : []).catch(() => []),
			]);
			const all = [...(Array.isArray(latest) ? latest : []), ...(Array.isArray(top) ? top : [])]
				.filter((b) => b?.chainId === "solana" && b?.tokenAddress);
			const seen = new Set();
			const addrs = [];
			for (const b of all) {
				const a = String(b.tokenAddress);
				if (!seen.has(a)) { seen.add(a); addrs.push(a); }
				if (addrs.length >= 30) break;
			}
			const pairs = await fetchDexForMints(addrs);
			return pairs
				.filter((p) => Number.isFinite(p.liquidityUsd) && p.liquidityUsd >= 5000)
				.filter((p) => Number.isFinite(p.volumeUsd1h) && p.volumeUsd1h >= 10_000)
				.filter((p) => Number.isFinite(p.priceChange5m))
				.sort((a, b) => {
					const A = (a.priceChange5m || 0) * Math.sqrt(a.liquidityUsd || 0);
					const B = (b.priceChange5m || 0) * Math.sqrt(b.liquidityUsd || 0);
					return B - A;
				})
				.slice(0, limit);
		} catch {
			return [];
		}
	})();

	// Watchlist refresh (always queried even if held mint is on it)
	const wl = await loadWatchlist(paths);
	const watchMints = wl.entries.map((e) => e.mint);
	const watchPairs = await fetchDexForMints(watchMints);
	const watchByMint = new Map(watchPairs.map((p) => [p.mint, p]));
	const watchlistLive = wl.entries.map((e) => ({
		mint: e.mint,
		note: e.note,
		addedAt: e.addedAt,
		live: watchByMint.get(e.mint) || null,
	}));

	// Tag held mints inline for fast scanning
	const heldMints = new Set(activeHolds.map((h) => h.mint));
	const market = marketResult.map((m) => ({ ...m, held: heldMints.has(m.mint) }));

	return ok({
		ts: new Date().toISOString(),
		position: {
			runnerPresent: !!state,
			stale,
			ageMs,
			solBalance: Number(state?.solBalance) || 0,
			activeHoldCount: activeHolds.length,
			activeHolds: activeHolds.map((h) => ({
				holdId: h.holdId,
				mint: h.mint,
				status: h.status,
				costSol: h.costSol,
				estOutSol: h.estOutSol,
				currentPnlPct: h.currentPnlPct,
				peakPnlPct: h.peakPnlPct,
				profitTargetPct: h.profitTargetPct,
				ageSecs: h.ageSecs,
			})),
			wallet,
		},
		market,
		watchlist: watchlistLive,
	});
}

async function cmdRetro(paths, mint, opts) {
	if (!mint) fail("retro requires a mint as positional argument");
	const entry = num(opts.opts.entry);
	const exitVal = num(opts.opts.exit);
	const peak = num(opts.opts.peak);
	if (entry == null) fail("retro requires --entry <sol>");
	if (exitVal == null) fail("retro requires --exit <sol>");
	if (peak == null) fail("retro requires --peak <pct>");
	if (!opts.opts.reason) fail("retro requires --reason \"<text>\"");

	const realizedPnlSol = exitVal - entry;
	const realizedPnlPct = entry > 0 ? ((exitVal - entry) / entry) * 100 : 0;

	const record = {
		ts: new Date().toISOString(),
		mint: String(mint),
		entrySol: entry,
		exitSol: exitVal,
		realizedPnlSol,
		realizedPnlPct,
		peakPnlPct: peak,
		reason: String(opts.opts.reason).slice(0, 500),
		note: opts.opts.note ? String(opts.opts.note).slice(0, 500) : "",
	};

	await ensureDir(paths.retroJournal);
	await appendFile(paths.retroJournal, JSON.stringify(record) + "\n", "utf8");
	return ok({
		appended: true,
		record,
		note: "Retrospective recorded. Consider also saving a Claude memory entry for cross-session pattern recall.",
	});
}

// ─── Main ─────────────────────────────────────────────────────────────

function usage() {
	console.error("Usage: node cowork-helper.mjs <command> [options]");
	console.error("Trader cowork: status | decisions | results | tune | queue-buy | queue-sell | observe");
	console.error("Hold cowork:   holds | hold <id> | start-hold <mint> | update-hold <id> | stop-hold <id> | hold-events | pnl");
	console.error("Market:        market-snapshot | token-info <mint>");
	console.error("Continuous:    scout | watch (add|remove|list) | retro");
	console.error("See top of file for full reference.");
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const cmd = args._[0];
	if (!cmd || cmd === "help" || args.flags.has("help")) {
		usage();
		process.exit(args.flags.has("help") ? 0 : 1);
		return;
	}
	const paths = resolveBridgePaths(args.opts["bridge-dir"]);

	switch (cmd) {
		case "status":           return cmdStatus(paths);
		case "decisions":        return cmdDecisions(paths, num(args.opts.tail) || 20);
		case "results":          return cmdResults(paths, num(args.opts.tail) || 20);
		case "tune":             return cmdTune(paths, args);
		case "queue-buy":        return cmdQueue(paths, "buy", args._[1], args);
		case "queue-sell":       return cmdQueue(paths, "sell", args._[1], args);
		case "observe":          return cmdObserve(paths, args._.slice(1).join(" "));
		// Hold cowork (v2)
		case "holds":            return cmdHolds(paths, args);
		case "hold":             return cmdHold(paths, args._[1]);
		case "start-hold":       return cmdStartHold(paths, args._[1], args);
		case "update-hold":      return cmdUpdateHold(paths, args._[1], args);
		case "stop-hold":        return cmdStopHold(paths, args._[1], args);
		case "hold-events":      return cmdHoldEvents(paths, num(args.opts.tail) || 30);
		case "pnl":              return cmdPnl(paths);
		// Market
		case "market-snapshot":  return cmdMarketSnapshot(num(args.opts.limit) || 10);
		case "token-info":       return cmdTokenInfo(args._[1]);
		// Continuous monitoring
		case "scout":            return cmdScout(paths, num(args.opts.limit) || 5);
		case "watch":            return cmdWatch(paths, args._[1], args._[2], args);
		case "retro":            return cmdRetro(paths, args._[1], args);
		default:                 usage(); process.exit(1);
	}
}

main().catch((err) => {
	console.error(JSON.stringify({ ok: false, error: String(err?.stack || err?.message || err) }));
	process.exit(1);
});
