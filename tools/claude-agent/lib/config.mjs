// CLI parsing + profile loading for the Claude agent runtime.

import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import process from "node:process";

const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_CYCLE_MS = 30_000;
const SUPPORTED_MODELS = new Set([
	"claude-haiku-4-5",
	"claude-sonnet-4-6",
	"claude-opus-4-7",
]);

function parseFlag(argv, name) {
	const idx = argv.findIndex((a) => a === name);
	if (idx < 0) return null;
	const v = argv[idx + 1];
	if (!v || v.startsWith("--")) return "";
	return v;
}

function hasFlag(argv, name) {
	return argv.includes(name);
}

export function parseCliArgs(argv = process.argv.slice(2)) {
	if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
		return { help: true };
	}

	const profilePath = parseFlag(argv, "--profile") || "../profiles/dev.json";
	const modelOverride = parseFlag(argv, "--model");
	const cycleMs = Number(parseFlag(argv, "--cycle-ms")) || DEFAULT_CYCLE_MS;
	const maxCycles = Number(parseFlag(argv, "--max-cycles")) || 0;
	const logFile = parseFlag(argv, "--log-file") || "";
	const enableTrading = hasFlag(argv, "--enable-trading");
	const logToConsole = hasFlag(argv, "--log-to-console");

	if (modelOverride && !SUPPORTED_MODELS.has(modelOverride)) {
		throw new Error(`Unsupported model: ${modelOverride}. Supported: ${[...SUPPORTED_MODELS].join(", ")}`);
	}

	return {
		profilePath: resolvePath(profilePath),
		modelOverride: modelOverride || "",
		cycleMs: Math.max(5_000, Math.floor(cycleMs)),
		maxCycles: Math.max(0, Math.floor(maxCycles)),
		logFile: logFile ? resolvePath(logFile) : "",
		enableTrading,
		logToConsole,
	};
}

export function helpText() {
	return [
		"fdv-claude-agent (safety-first MVP)",
		"",
		"Usage:",
		"  node run.mjs [--profile <path>] [--model <id>] [--cycle-ms <n>] [--log-to-console]",
		"",
		"Options:",
		"  --profile <path>     Path to profile JSON (default: ../profiles/dev.json)",
		"  --model <id>         claude-haiku-4-5 (default) | claude-sonnet-4-6 | claude-opus-4-7",
		"  --cycle-ms <n>       Milliseconds between cycles (default: 30000, min 5000)",
		"  --max-cycles <n>     Stop after N cycles (default: 0 = forever)",
		"  --log-file <path>    Append JSONL trace events to this file",
		"  --log-to-console     Also print events to stdout",
		"  --enable-trading     RESERVED. Live trading not yet implemented; flag is rejected.",
		"  --help               Print this message",
		"",
		"Auth:",
		"  ANTHROPIC_API_KEY in env, OR profile.agentGaryFullAi.apiKey in the profile JSON.",
		"",
		"Safety:",
		"  Only read-only tools and 'propose' tools are exposed. The agent cannot execute swaps.",
	].join("\n");
}

export async function loadProfile(profilePath) {
	const raw = await readFile(profilePath, "utf8");
	const profile = JSON.parse(raw);
	if (!profile || typeof profile !== "object") throw new Error(`Profile is not an object: ${profilePath}`);
	return profile;
}

export function resolveAnthropicKey(profile) {
	const env = process.env || {};
	const fromEnv = String(env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY || env.FDV_ANTHROPIC_KEY || env.FDV_CLAUDE_KEY || "").trim();
	if (fromEnv) return fromEnv;
	const fromProfile = String(profile?.agentGaryFullAi?.apiKey || "").trim();
	if (fromProfile) return fromProfile;
	return "";
}

export function resolveModel(profile, override) {
	if (override) return override;
	const fromProfile = String(profile?.agentGaryFullAi?.model || "").trim();
	if (fromProfile && SUPPORTED_MODELS.has(fromProfile)) return fromProfile;
	return DEFAULT_MODEL;
}

export function resolveRpcUrl(profile) {
	const url = String(profile?.rpc?.url || profile?.rpcUrl || "").trim();
	if (!url) throw new Error("Profile is missing rpc.url");
	return url;
}

export function resolveRpcHeaders(profile) {
	const h = profile?.rpc?.headers || profile?.rpcHeaders || {};
	if (h && typeof h === "object") return h;
	return {};
}
