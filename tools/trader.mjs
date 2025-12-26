#!/usr/bin/env node

import { runAutoTraderCli } from "../src/vista/widgets/auto/cli/app.js";

try {
  const code = await runAutoTraderCli(process.argv.slice(2));
  process.exitCode = Number.isFinite(code) ? code : 0;
} catch (err) {
  const msg = err?.stack || err?.message || String(err);
  console.error(msg);
  process.exitCode = 1;
}
