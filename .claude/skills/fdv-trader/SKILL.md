---
name: fdv-trader
description: Use when working on the fdv.lol Solana memecoin radar/auto-trader codebase — questions about Agent Gary, sell policies, the headless CLI (`cli.mjs`), profiles, KPIs (PUMP/DEGEN/etc.), warming/light-entry/rebound gates, the trader widget, or the LLM framework adapters under `src/agents/frameworks/`. Triggers on: "how does the trader X", "where is X policy", "run the CLI", "agent gary", "switch provider", "profile json", "burner wallet", "headless run", "snapshot", "sim-index", "claude provider".
---

# fdv-trader

Client-side Solana memecoin radar + headless auto-trader. No build step, no backend, all logic runs in the browser or in Node via `cli.mjs`. LLM-driven decisioning (Agent Gary) is optional; deterministic policies run with or without it.

## Orient fast

- **Repo root**: static site. `index.html`, `main.js`, `cli.mjs` ship to fdv.lol directly. No bundler.
- **Two runtime targets**: browser (full UI in `src/vista/`) and Node CLI (`cli.mjs` → `src/vista/addons/auto/cli/app.js`). Both share the same `src/agents/` and `src/vista/addons/auto/lib/` code.
- **Local profile**: `tools/profiles/dev.json` (gitignored — see `.gitignore:16`). Holds RPC + Jupiter key + wallet secret + agent config. Generate a wallet with `tools/keygen-patch-profile.mjs`.
- **Node for local checks**: WSL Ubuntu has nvm + Node LTS at `~/.nvm/`. Invoke via `wsl -d Ubuntu --cd "<windows-path>" -- bash -lc '. $HOME/.nvm/nvm.sh; node ...'`.

## Architecture map

### CLI bootstrap → runtime
- [cli.mjs](cli.mjs) — thin bootstrapper; downloads `src/vista/addons/auto/cli/app.js` (or uses a local checkout) and calls its exported `runAutoTraderCli(argv)`.
- [src/vista/addons/auto/cli/app.js:4530](src/vista/addons/auto/cli/app.js) — main `runAutoTraderCli`. Parses flags, hydrates a fake `localStorage`, applies the profile, then either runs the auto-trader loop or one of the dev modes.
- Headless flags: `--run-profile`, `--quick-start`, `--sim-index`, `--validate-sell-bypass`, `--dry-run-sell` (see [cli.mjs:67-79](cli.mjs)).
- Profile → storage: [`_applyAgentGaryFromProfile()`](src/vista/addons/auto/cli/app.js:52) and [`applyAgentGaryFullAiToStorage()`](src/vista/addons/auto/cli/app.js:1392).

### Auto-trader runtime
- [src/vista/addons/auto/trader/index.js](src/vista/addons/auto/trader/index.js) — the trader widget AND headless trader loop. Exports `initTraderWidget()` (~line 11876) plus CLI-facing `__fdvCli_start()` / `__fdvCli_stop()` (~lines 10479/10548).
- [src/vista/addons/auto/lib/pipeline.js](src/vista/addons/auto/lib/pipeline.js) — runs the ordered sell-policy chain; short-circuits on `stop` / `returned`.
- [src/vista/addons/auto/lib/constants.js](src/vista/addons/auto/lib/constants.js) — global limits. **Read this first** for any "what's the max X?" question. Notable: `MAX_BUY_SOL_MIN=1`, `MAX_BUY_SOL_MAX=5`, `URGENT_SELL_COOLDOWN_MS=20_000`, `URGENT_SELL_MIN_AGE_MS=7_000`.
- [src/vista/addons/auto/sniper/index.js](src/vista/addons/auto/sniper/index.js) — separate higher-frequency sniper bot. Fast hard-stops and warming-max-loss live here (lines ~1824, ~1910).

### Sell policy chain (run in this order)
All under `src/vista/addons/auto/lib/sell/policies/`. The pipeline composes them in the order shown in [src/vista/addons/auto/cli/app.js:112-122](src/vista/addons/auto/cli/app.js):
1. `preflight.js` — pre-swap validation.
2. `urgent.js` — rug / momentum-drop urgent sell.
3. `quoteAndEdge.js` — net-edge gate using fresh Jupiter quote.
4. `fastExit.js` — fast TP / SL exits.
5. `dynamicHardStop.js` — dynamic stop based on volatility; reason format `HARD_STOP {pnl}% <= -{stop}%`.
6. `profitLock.js` — locks in profit once thresholds met.
7. `forceFlagDecision.js` — enforces `max-hold>{secs}s` etc.
8. `reboundGate.js` — defers sells when rebound score crosses `reboundMinScore`.
9. `fallbackSell.js` — split sizing / slippage bumps / bridge paths.
10. `executeSellDecision.js` — final swap execution.

### Agent Gary (LLM layer)
- [src/agents/driver.js](src/agents/driver.js) — builds the LLM config from `globalThis.__fdvAgentOverrides` + localStorage, dispatches to the right framework, runs `decideBuy`/`decideSell`/`scanConfig`/`tune`. Reads keys from `fdv_<provider>_key` and overrides like `o.claudeApiKey`/`o.openaiApiKey`/etc.
- [src/agents/frameworks/index.js](src/agents/frameworks/index.js) — `normalizeLlmConfig()` + `createChatClient()`. Provider inference: `claude-*` → claude, `gpt-*`/`o*` → openai, `gemini-*` → gemini, `grok-*` → grok, `deepseek-*` → deepseek, `gary-*` → gary.
- Framework clients (uniform `{ chatJson, chatJsonWithMeta, estimateTokensForText }` interface):
  - [claude.js](src/agents/frameworks/claude.js) — Anthropic Messages API, JSON-forced via assistant prefill `{`.
  - [open.js](src/agents/frameworks/open.js) — OpenAI Chat Completions + Responses API (handles GPT-5/o-series).
  - [gemini.js](src/agents/frameworks/gemini.js), [grok.js](src/agents/frameworks/grok.js), [deepseek.js](src/agents/frameworks/deepseek.js), [gary.js](src/agents/frameworks/gary.js) — OpenAI-compatible or provider-native.
- [src/agents/personas/agent.gary.prompts.js](src/agents/personas/agent.gary.prompts.js) — prompt templates.
- [src/agents/personas/strategies/](src/agents/personas/strategies) — `agent.gary.base.js`, `.buy.js`, `.sell.js`, `.config.js` (config validator — note `maxBuySol >= 1` rule at [agent.gary.config.js:7](src/agents/personas/strategies/agent.gary.config.js)).
- [src/agents/memory.js](src/agents/memory.js) — decision ring buffer, per-wallet session.
- [src/agents/sentry.js](src/agents/sentry.js) — real-time mint flagging.
- [src/agents/training.js](src/agents/training.js) — JSONL training capture; gated on env `TRAINING_CAPTURE`.

### KPIs / scoring
All under `src/vista/meme/metrics/kpi/`:
- `pumping.js` — short-lookback Pumping/Warming/Calm badges, hard gates on liq/vol/price sanity.
- `degen.js` — DEGEN Bottom Sniper: 3-day decay (half-life 1.25d), recency-weighted bounce detection.
- `mom.js` — 24h momentum.
- `holders.js`, `sticky.js` — holder growth/retention.
- `bsi.js`, `engagement.js`, `smq.js` — sentiment / engagement / smart-money.
- `liquid.js`, `honey.js`, `comeback.js`, `draw.js`, `das.js`, `three.js`, `24h.js`, `performers.js` — supporting scores.

### Stores
Under `src/vista/addons/auto/lib/stores/`:
- `posCacheStore.js` — position cache; LS prefix `fdv_poscache_v1:{ownerPubkey}`.
- `dustCacheStore.js` — dust tracking; LS prefix `fdv_dustcache_v1:{ownerPubkey}`.
- `urgentSellStore.js` — urgent-sell flags + cooldowns.

## Profile JSON (canonical shape)

Reference templates: [tools/profiles/fdv.profiles.example.json](tools/profiles/fdv.profiles.example.json), [skill/openclaw.example.json](skill/openclaw.example.json). Local-only working copy: `tools/profiles/dev.json` (gitignored).

Top-level keys:
```
rpc:               { url, headers }
wallet:            { secret (base58 64-byte), recipientPub }
jupiter:           { apiKey }
agentGaryFullAi:   { enabled, provider, model, riskLevel, fullAiControl, apiKey }
auto:              { ... ~45 trader knobs ... }
follow:            { enabled, targetWallet, buyPct, maxHoldMin, pollMs }  // optional, for follow-bot
```

Provider values for `agentGaryFullAi.provider`: `claude` (default + recommended), `openai`, `gemini`, `grok`, `deepseek`, `gary`. `anthropic` is normalized to `claude`. Default models per provider live in [src/agents/frameworks/index.js:50-71](src/agents/frameworks/index.js).

## Common dev tasks

### Generate a fresh burner wallet for `tools/profiles/dev.json`
```
node tools/keygen-patch-profile.mjs tools/profiles/dev.json
```
Refuses to overwrite a populated `wallet.secret`; pass `--force` to override. Prints only the public address.

### Headless run (real swaps)
```
node cli.mjs --run-profile --profiles tools/profiles/dev.json --log-to-console
```
Requires: funded `wallet.secret`, valid `rpc.url`, valid `jupiter.apiKey`. For Full AI Control: `agentGaryFullAi.{enabled:true, fullAiControl:true, apiKey}` (or env-var fallback).

### Env-var API key fallback
`agentGaryFullAi.apiKey` can be empty if a matching env var is set ([src/vista/addons/auto/cli/app.js:1362-1380](src/vista/addons/auto/cli/app.js)):
- Claude: `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`, `FDV_ANTHROPIC_KEY`, `FDV_CLAUDE_KEY`
- OpenAI: `OPENAI_API_KEY`, `FDV_OPENAI_KEY`
- Gemini: `GEMINI_API_KEY`, `FDV_GEMINI_KEY`
- Grok: `GROK_API_KEY`, `XAI_API_KEY`, `FDV_GROK_KEY`
- DeepSeek: `DEEPSEEK_API_KEY`, `FDV_DEEPSEEK_KEY`

### Dev utilities (no RPC needed)
```
node tools/trader.mjs --validate-sell-bypass            # urgent-bypass router check
node tools/trader.mjs --dry-run-sell --snapshot tools/snapshots/sample-sell.json
node tools/trader.mjs --sim-index --steps 40 --dt-ms 1000 --debug-sell
```
Snapshot format: see [tools/snapshots/sample-sell.json](tools/snapshots/sample-sell.json) (`mint`, `pos.{sizeUi,costSol}`, `pxNow` or `curSol`, optional `state.takeProfitPct`/`stopLossPct`/`trailPct`, optional `urgent` + `routerHoldUntil`).

### Syntax check after editing
```
wsl -d Ubuntu --cd "<repo-path>" -- bash -lc '. $HOME/.nvm/nvm.sh; node --check <file>'
```

## localStorage keys actually written

Search for them with `grep "fdv_" src` if more are added.
- Agent: `fdv_agent_enabled`, `fdv_agent_risk`, `fdv_agent_full_control`, `fdv_agent_log_prompts`, `fdv_agent_config_autoset`
- LLM: `fdv_llm_provider`, `fdv_llm_model`, `fdv_openai_model` (legacy back-compat)
- Provider keys: `fdv_openai_key`, `fdv_gemini_key`, `fdv_grok_key`, `fdv_deepseek_key`, `fdv_gary_key`, `fdv_claude_key` (+ `fdv_anthropic_key` accepted)
- Provider base URLs: `fdv_openai_base_url`, `fdv_gemini_base_url`, `fdv_grok_base_url`, `fdv_deepseek_base_url`, `fdv_gary_base_url`, `fdv_claude_base_url` (+ `fdv_anthropic_base_url`)
- Infra: `fdv_jup_api_key`, `fdv_rpc_url`, `fdv_rpc_headers`, `fdv_silence_ipfs`
- Per-wallet caches: `fdv_poscache_v1:{owner}`, `fdv_dustcache_v1:{owner}`

## Safety conventions (do not violate without asking)

- **Burner wallets only.** Never suggest funding the auto-wallet from a main wallet beyond a tiny test amount. The trader signs swaps without further confirmation. See [src/vista/addons/auto/help/index.js:151](src/vista/addons/auto/help/index.js), [src/config/env.js:222](src/config/env.js).
- **`maxBuySol` must be ≥ 1.** Enforced at [src/vista/addons/auto/trader/index.js:2978](src/vista/addons/auto/trader/index.js) and in the Agent Gary config validator [agent.gary.config.js:7](src/agents/personas/strategies/agent.gary.config.js).
- **Never commit `tools/profiles/dev.json` or anything containing real secrets.** Confirmed gitignored at [.gitignore:16](.gitignore). Do not write secrets into `tools/profiles/fdv.profiles.example.json` or `skill/openclaw.example.json` — those are tracked templates.
- **Don't print wallet secrets.** Tools like `tools/keygen-patch-profile.mjs` write the secret directly to the profile file and print only the pubkey — match that pattern.
- **Full AI Control bypasses some "enforce" gates** ([warmingHook.js:3,18-19](src/vista/addons/auto/lib/sell/policies/warmingHook.js)). Don't enable `fullAiControl: true` in user-facing examples unless explicitly asked.
- **Urgent sells have a min-age guard** of 7s after buy ([constants.js:32-33](src/vista/addons/auto/lib/constants.js)) — that's intentional; don't lower it without a reason.

## Where things tend to land

- **New LLM provider** → add `src/agents/frameworks/<name>.js`, wire into [frameworks/index.js](src/agents/frameworks/index.js) (`_inferProvider` + `createChatClient` + `defaultBaseUrl`/`defaultModel`), add key/baseUrl branches in [agents/driver.js](src/agents/driver.js), env-var pick in [cli/app.js _getEnvKeyForProvider](src/vista/addons/auto/cli/app.js:1362), LS-key map at `_lsKeyForProvider` (both [cli/app.js:1383](src/vista/addons/auto/cli/app.js) and [trader/index.js:11053](src/vista/addons/auto/trader/index.js)), and an `<option>` in the trader UI's `<select data-auto-openai-model>` (~line 12065). Use the Claude integration as the template.
- **New sell policy** → add under `src/vista/addons/auto/lib/sell/policies/`, register in the import block at [cli/app.js:112-122](src/vista/addons/auto/cli/app.js), and slot it into the pipeline order.
- **New profile field** → parse it in [`_applyAgentGaryFromProfile`](src/vista/addons/auto/cli/app.js:52) or wherever the matching subsystem hydrates from profile, add to `tools/profiles/fdv.profiles.example.json` + `skill/openclaw.example.json` (with placeholder values only).
