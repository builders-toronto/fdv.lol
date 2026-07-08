#!/usr/bin/env node
// One-shot util: generates a fresh ed25519 Solana keypair, patches `wallet.secret`
// in the given profile JSON, and prints ONLY the resulting public address.
// The 64-byte secret never crosses stdout/stderr.
//
//   node tools/keygen-patch-profile.mjs <path-to-profile.json>
//
// Refuses to overwrite a non-empty `wallet.secret` (pass --force to override).

import { readFile, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import process from "node:process";

const B58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58encode(bytes) {
	let n = 0n;
	for (const b of bytes) n = (n << 8n) | BigInt(b);
	let out = "";
	while (n > 0n) {
		out = B58_ALPHA[Number(n % 58n)] + out;
		n /= 58n;
	}
	for (const b of bytes) {
		if (b !== 0) break;
		out = "1" + out;
	}
	return out;
}

function ed25519Keypair() {
	const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
	// PKCS#8 DER for ed25519 ends with the 32-byte raw seed.
	const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
	// SPKI DER for ed25519 ends with the 32-byte raw pubkey.
	const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
	// Solana's "secret key" is the 64-byte concatenation [seed || pubkey].
	const secret64 = Buffer.concat([seed, pub]);
	return { secret64, pub };
}

async function main() {
	const args = process.argv.slice(2);
	const force = args.includes("--force");
	const path = args.find((a) => !a.startsWith("--"));
	if (!path) {
		console.error("usage: node tools/keygen-patch-profile.mjs <profile.json> [--force]");
		process.exit(2);
	}

	const raw = await readFile(path, "utf8");
	const profile = JSON.parse(raw);
	if (!profile.wallet || typeof profile.wallet !== "object") profile.wallet = {};

	const existing = String(profile.wallet.secret || "").trim();
	if (existing && !force) {
		console.error(`Refusing to overwrite existing wallet.secret in ${path}. Pass --force to overwrite.`);
		process.exit(3);
	}

	const { secret64, pub } = ed25519Keypair();
	profile.wallet.secret = b58encode(secret64);

	await writeFile(path, JSON.stringify(profile, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });

	// Only the public address is safe to print.
	console.log(b58encode(pub));
}

main().catch((e) => {
	console.error(String(e?.stack || e?.message || e));
	process.exit(1);
});
