#!/usr/bin/env node
const DEFAULT_BASE_URL = "https://fdv.lol";
const DEFAULT_ENTRY = "/src/vista/widgets/auto/cli/app.js";

let _os = null;
let _path = null;
let _pathToFileURL = null;
let _createHash = null;
let _fsPromises = null;

function parseBootstrapArgs(argv) {
	const args = Array.isArray(argv) ? argv.slice() : [];
	const out = {
		baseUrl: DEFAULT_BASE_URL,
		entry: DEFAULT_ENTRY,
		noClean: false,
		printDir: false,
		explicitBaseUrl: false,
		passthrough: [],
	};

	for (let i = 0; i < args.length; i += 1) {
		const a = String(args[i] ?? "");
		const next = () => (i + 1 < args.length ? String(args[i + 1] ?? "") : "");

		if (a === "--base-url") {
			out.baseUrl = next();
			out.explicitBaseUrl = true;
			i += 1;
			continue;
		}
		if (a === "--entry") {
			out.entry = next();
			i += 1;
			continue;
		}
		if (a === "--no-clean") {
			out.noClean = true;
			continue;
		}
		if (a === "--print-dir") {
			out.printDir = true;
			continue;
		}

		out.passthrough.push(args[i]);
	}

	out.baseUrl = String(out.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
	out.entry = String(out.entry || DEFAULT_ENTRY).trim();
	if (!out.entry.startsWith("/")) out.entry = "/" + out.entry;
	return out;
}

function normalizePassthroughArgs(argv) {
	const args = Array.isArray(argv) ? argv.slice() : [];
	if (!args.length) return args;

	const first = String(args[0] || "").trim();
	if (!first || first.startsWith("-")) return args;

	const map = new Map([
		["help", "--help"],
		["--help", "--help"],
		["quick-start", "--quick-start"],
		["quickstart", "--quick-start"],
		["run-profile", "--run-profile"],
		["runprofile", "--run-profile"],
		["flame", "--flame"],
		["sim-index", "--sim-index"],
		["simindex", "--sim-index"],
		["validate-sell-bypass", "--validate-sell-bypass"],
		["dry-run-sell", "--dry-run-sell"],
	]);

	const mapped = map.get(first.toLowerCase());
	if (!mapped) return args;
	args[0] = mapped;
	return args;
}

function sha1(s) {
	if (typeof _createHash !== "function") throw new Error("sha1() not initialized");
	return _createHash("sha1").update(String(s || "")).digest("hex");
}

function isUrlLike(spec) {
	return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(String(spec || ""));
}

function stripJsComments(src) {
	const s = String(src || "");
	let out = "";
	let i = 0;
	let inS = false;
	let inD = false;
	let inT = false;
	let inLine = false;
	let inBlock = false;
	let esc = false;

	while (i < s.length) {
		const ch = s[i];
		const next = i + 1 < s.length ? s[i + 1] : "";

		if (inLine) {
			if (ch === "\n") {
				inLine = false;
				out += ch;
			} else {
				// keep newlines only
				out += " ";
			}
			i += 1;
			continue;
		}

		if (inBlock) {
			if (ch === "*" && next === "/") {
				inBlock = false;
				out += "  ";
				i += 2;
				continue;
			}
			if (ch === "\n") out += "\n";
			else out += " ";
			i += 1;
			continue;
		}

		// Inside strings/templates: only handle escapes and exits.
		if (inS || inD || inT) {
			out += ch;
			if (esc) {
				esc = false;
				i += 1;
				continue;
			}
			if (ch === "\\") {
				esc = true;
				i += 1;
				continue;
			}
			if (inS && ch === "'") inS = false;
			else if (inD && ch === '"') inD = false;
			else if (inT && ch === "`") inT = false;
			i += 1;
			continue;
		}

		// Not in string/comment: detect comment starts.
		if (ch === "/" && next === "/") {
			inLine = true;
			out += "  ";
			i += 2;
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlock = true;
			out += "  ";
			i += 2;
			continue;
		}

		// Enter strings/templates.
		out += ch;
		if (ch === "'") inS = true;
		else if (ch === '"') inD = true;
		else if (ch === "`") inT = true;
		i += 1;
	}

	return out;
}

function extractImportSpecifiers(js) {
	const src = stripJsComments(js);
	const out = [];

	// import ... from "..." / import "..."
	for (const m of src.matchAll(/\bimport\s*(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g)) {
		out.push(m[1]);
	}
	// export ... from "..."
	for (const m of src.matchAll(/\bexport\s*[\s\S]*?\s+from\s+["']([^"']+)["']/g)) {
		out.push(m[1]);
	}
	// import("...")
	for (const m of src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
		out.push(m[1]);
	}

	return out;
}

function resolveModulePath(fromPath, spec) {
	const s = String(spec || "").trim();
	if (!s) return null;

	// Ignore builtins / external packages / data/http
	if (s.startsWith("node:")) return null;
	if (isUrlLike(s)) return null;
	if (!s.startsWith(".") && !s.startsWith("/")) return null;

	if (!_path?.posix) return null;
	const fromDir = _path.posix.dirname(String(fromPath || "/"));
	const joined = s.startsWith("/") ? s : _path.posix.join(fromDir, s);
	const normalized = _path.posix.normalize(joined);
	return normalized.startsWith("/") ? normalized : "/" + normalized;
}

async function fetchText(url, { retries = 2 } = {}) {
	let lastErr = null;
	for (let i = 0; i <= retries; i += 1) {
		try {
			const resp = await fetch(url);
			if (!resp.ok) throw new Error(`fetch failed ${resp.status} ${resp.statusText} :: ${url}`);
			return await resp.text();
		} catch (e) {
			lastErr = e;
			await new Promise((r) => setTimeout(r, 250 + i * 250));
		}
	}
	throw lastErr || new Error(`fetch failed :: ${url}`);
}

async function fileExists(fsPromises, filePath) {
	try {
		await fsPromises.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function findLocalRepoRoot({ fsPromises, path, startDir }) {
	let cur = String(startDir || "");
	if (!cur) return null;

	for (let i = 0; i < 12; i += 1) {
		const candidate = cur;
		const entry = path.join(candidate, DEFAULT_ENTRY.replace(/^\/+/, ""));
		// If we can import the CLI entry from disk, we consider this a usable local root.
		if (await fileExists(fsPromises, entry)) return candidate;
		const parent = path.dirname(candidate);
		if (!parent || parent === candidate) break;
		cur = parent;
	}

	return null;
}

async function main() {
	const [osMod, pathMod, urlMod, cryptoMod, fsPromises] = await Promise.all([
		import("node:os"),
		import("node:path"),
		import("node:url"),
		import("node:crypto"),
		import("node:fs/promises"),
	]);
	_os = osMod;
	_path = pathMod;
	_pathToFileURL = urlMod.pathToFileURL;
	_createHash = cryptoMod.createHash;
	_fsPromises = fsPromises;

	const { mkdir, writeFile, rm } = _fsPromises;

	const opts = parseBootstrapArgs(process.argv.slice(2));
	opts.passthrough = normalizePassthroughArgs(opts.passthrough);

	if (!Array.isArray(opts.passthrough) || opts.passthrough.length === 0) {
		opts.passthrough = ["--quick-start"];
	}

	// If the user didn't explicitly pass --base-url, allow an env override.
	if (!opts.explicitBaseUrl) {
		const envBase = String(process?.env?.FDV_BASE_URL || process?.env?.FDV_CLI_BASE_URL || "").trim();
		if (envBase) opts.baseUrl = envBase.replace(/\/+$/, "");
	}

	// If we're running from inside a repo checkout, prefer local filesystem imports.
	const cwd = typeof process?.cwd === "function" ? process.cwd() : "";
	const localRoot = await findLocalRepoRoot({ fsPromises: _fsPromises, path: _path, startDir: cwd });
	if (localRoot) {
		const entryFs = _path.join(localRoot, opts.entry.replace(/^\/+/, ""));
		const entryUrl = _pathToFileURL(entryFs).href;
		const mod = await import(entryUrl);
		const fn = mod?.runAutoTraderCli;
		if (typeof fn !== "function") throw new Error(`Entry did not export runAutoTraderCli(): ${opts.entry}`);
		const code = await fn(opts.passthrough);
		process.exitCode = Number.isFinite(code) ? code : 0;
		return;
	}

	const cacheKey = sha1(`${opts.baseUrl}|${opts.entry}|v3`);
	const rootDir = _path.join(_os.tmpdir(), `fdv-cli-${cacheKey}`);

	await mkdir(rootDir, { recursive: true });
	if (opts.printDir) {
		// eslint-disable-next-line no-console
		console.log(rootDir);
	}

	const downloaded = new Set();

	async function downloadModule(modulePath, { optional = false } = {}) {
		const p = String(modulePath || "");
		if (!p.startsWith("/")) return;
		if (downloaded.has(p)) return;
		downloaded.add(p);

		const url = `${opts.baseUrl}${p}`;
		const localPath = _path.join(rootDir, p.replace(/^\/+/, ""));
		await mkdir(_path.dirname(localPath), { recursive: true });

		let text;
		try {
			text = await fetchText(url);
		} catch (e) {
			if (optional) return;
			const msg = String(e?.message || e || "");
			if (!opts.explicitBaseUrl && String(opts.baseUrl || "") === DEFAULT_BASE_URL) {
				// eslint-disable-next-line no-console
				console.error(
					[
						msg,
						"",
						"Hint: This bootstrap downloads dependencies from a base URL.",
						"If you curled this from localhost/VM, pass --base-url (or set FDV_BASE_URL):",
						"  curl -fsSL http://localhost:3000/cli.mjs | node - -- --base-url http://localhost:3000 --help",
					].join("\n"),
				);
				throw new Error("bootstrap dependency fetch failed (missing --base-url)");
			}
			throw new Error(msg);
		}
		await writeFile(localPath, text, "utf8");

		// Recurse through JS imports.
		if (!/\.(m?js)$/i.test(p)) return;
		const specifiers = extractImportSpecifiers(text);
		for (const spec of specifiers) {
			const resolved = resolveModulePath(p, spec);
			if (!resolved) continue;
			await downloadModule(resolved);
		}
	}

	// Optional: splash banner file (CLI catches read failures).
	await downloadModule("/src/vista/widgets/auto/cli/splash.gary", { optional: true });

	// Preferred: vendored web3 shim.
	await downloadModule("/src/vendor/solana-web3/index.iife.min.js");
	await downloadModule("/vendor/solana-web3/index.iife.min.js", { optional: true });

	// Download CLI entry + dependency closure.
	await downloadModule(opts.entry);

	const entryLocal = _path.join(rootDir, opts.entry.replace(/^\/+/, ""));
	const entryUrl = _pathToFileURL(entryLocal).href;

	const mod = await import(entryUrl);
	const fn = mod?.runAutoTraderCli;
	if (typeof fn !== "function") {
		throw new Error(`Entry did not export runAutoTraderCli(): ${opts.entry}`);
	}

	const code = await fn(opts.passthrough);
	process.exitCode = Number.isFinite(code) ? code : 0;

	if (!opts.noClean) {
		try {
			await rm(rootDir, { recursive: true, force: true });
		} catch {}
	}
}

(async () => {
	try {
		await main();
	} catch (err) {
		const msg = err?.stack || err?.message || String(err);
		// eslint-disable-next-line no-console
		console.error(msg);
		process.exitCode = 1;
	}
})();