---
name: fdv-trader-bootstrap
description: Bootstrap and run the fdv.lol Solana memecoin auto-trader headlessly with Claude (Anthropic) as the decision engine. Use when the user wants to set up profile.json for fdv, generate a burner Solana wallet, fund an auto-wallet, choose an LLM provider, run `cli.mjs`, switch to Full AI Control, troubleshoot RPC/Jupiter/Anthropic errors, or wire fdv into a new environment. Default provider is `claude`; default model is `claude-haiku-4-5`.
---

# fdv-trader-bootstrap

You (Claude) are helping a user run **fdv.lol's auto-trader** headlessly, with Claude itself making buy/sell decisions through **Agent Gary Full AI Control**.

This is intentionally powerful. The user has authorized Claude to drive a Solana trading bot. Treat that authorization as scoped to **burner wallets with small balances** unless they explicitly opt out.

The skill bundles two files:
- [SKILL.md](SKILL.md) — this file
- [keygen.mjs](keygen.mjs) — standalone burner-keypair generator
- [openclaw.example.json](openclaw.example.json) — secret-free profile template (Claude is the default provider)

Upstream repo: `https://github.com/build23w/fdv.lol`

---

## What you're about to do

1. Confirm the user has Node.js (≥ 18).
2. Create a local `./profile.json` (with secrets) — **never commit it, never upload it**.
3. Use the bundled `keygen.mjs` to generate a fresh burner wallet (or accept an existing secret if the user paste one).
4. Collect or env-source: Chainstack/QuickNode RPC URL, Jupiter API key, Anthropic API key.
5. Tell the user to fund the burner address with a small amount of SOL.
6. Run `cli.mjs` against the local profile.

If any **mandatory** field is missing, refuse to start the CLI — print exactly what's missing and where to get it.

---

## Step-by-step bootstrap

### 1. Verify Node.js

```sh
node --version    # must be >= 18
```

If missing, point Linux/macOS users at `nvm`, Windows users at WSL + nvm, or `nodejs.org` direct download.

### 2. Copy the example profile

```sh
cp openclaw.example.json profile.json
```

(The example uses the legacy `openclaw` filename for back-compat with existing URLs at https://fdv.lol/skill/openclaw.example.json — content is current.)

### 3. Generate a burner wallet

```sh
node keygen.mjs profile.json
```

Output is **only** the public address (e.g. `DhgReU7X285beojNM33zqVp5YYfWS8Ut4czpg3Rqqmbk`). The 64-byte secret is written directly into `profile.json` at `wallet.secret`. The script refuses to overwrite a non-empty secret unless `--force` is passed.

Tell the user: **fund this address with a small amount of SOL** (e.g. 0.1–1 SOL for testing). Wait for confirmation before running step 6.

### 4. Gather mandatory secrets

For each missing item, refuse to proceed and tell the user:

| Field in `profile.json` | Where to get it | Refuse-to-start if missing? |
|---|---|---|
| `rpc.url` | https://quicknode.com/signup?via=lf (or https://chainstack.com) — Solana Mainnet HTTPS endpoint | yes |
| `jupiter.apiKey` | https://portal.jup.ag/pricing (FREE tier) | yes |
| `agentGaryFullAi.apiKey` (Claude) | https://console.anthropic.com/settings/keys | yes, **iff** Full AI Control is enabled |
| `wallet.recipientPub` | Optional. The user's main wallet pubkey — where "return SOL" features deposit. | no |

### 5. Pick the Claude model

Default: `claude-haiku-4-5` — fast, suits the trading loop's latency budget.

| Model | When to use |
|---|---|
| `claude-haiku-4-5` | Default. Buy/sell decisions on every cycle. |
| `claude-sonnet-4-6` | User wants deeper reasoning on tuning / config-scan tasks. |
| `claude-opus-4-7` | User explicitly opts in. Highest quality, slowest, costliest. |

Other supported providers (only if the user asks): `openai`, `gemini`, `grok`, `deepseek`, `gary`. `anthropic` is normalized to `claude`.

### 6. Run the CLI

Primary execution:

```sh
curl -fsSL https://fdv.lol/cli.mjs | node - run-profile --profile-url ./profile.json --log-to-console
```

Or, with the Anthropic key in the environment instead of the profile:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
curl -fsSL https://fdv.lol/cli.mjs | node - run-profile --profile-url ./profile.json --log-to-console
```

Alternative source (GitHub):

```sh
curl -fsSL https://raw.githubusercontent.com/build23w/fdv.lol/main/cli.mjs | node - run-profile --profile-url ./profile.json --log-to-console
```

Notes:
- `--profile-url` accepts local paths (`./profile.json`, `./dev.json`, etc.).
- `--profiles` is an accepted synonym for local files.
- `--log-to-console` is recommended for headless visibility.

---

## Profile reference

Top-level keys in [openclaw.example.json](openclaw.example.json):

```json
{
  "rpc":               { "url": "...", "headers": {} },
  "wallet":            { "secret": "<base58>", "recipientPub": "<optional pubkey>" },
  "jupiter":           { "apiKey": "..." },
  "agentGaryFullAi": {
    "enabled":        true,
    "provider":       "claude",
    "model":          "claude-haiku-4-5",
    "riskLevel":      "safe | medium | degen",
    "fullAiControl":  true,
    "apiKey":         "sk-ant-..."
  },
  "auto":              { "...trader knobs..." }
}
```

### Hard requirements

To trade at all:
- `wallet.secret`
- `rpc.url`
- `jupiter.apiKey`

For Full AI Control specifically:
- `agentGaryFullAi.enabled: true`
- `agentGaryFullAi.fullAiControl: true`
- `agentGaryFullAi.provider: "claude"` (or another supported provider)
- `agentGaryFullAi.model` set
- `agentGaryFullAi.apiKey` set **or** matching env var present

### Env-var fallback for `apiKey`

If `agentGaryFullAi.apiKey` is empty, the CLI looks up env vars based on `provider`:

| Provider | Env var lookup order |
|---|---|
| `claude` / `anthropic` | `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`, `FDV_ANTHROPIC_KEY`, `FDV_CLAUDE_KEY` |
| `openai` | `OPENAI_API_KEY`, `FDV_OPENAI_KEY` |
| `gemini` | `GEMINI_API_KEY`, `FDV_GEMINI_KEY` |
| `grok` | `GROK_API_KEY`, `XAI_API_KEY`, `FDV_GROK_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY`, `FDV_DEEPSEEK_KEY` |

---

## What "Full AI Control" actually does

When `agentGaryFullAi.enabled: true` AND `agentGaryFullAi.fullAiControl: true`:

- The runtime sets internal flag `fdv_agent_full_control=true`.
- Claude's decisions become **authoritative**. The trader will execute them even when some deterministic "enforce" gates would normally block.
- Claude is invoked on: buy proposals, sell proposals, runtime tuning (risk + knobs), and startup config scans.

This is the user's explicit choice. Don't second-guess it. Do remind them once: **burner wallet, small balance.**

---

## Operating rules (do not violate)

- **Never write real secrets into any tracked file.** Use the local (untracked) `./profile.json`. The `openclaw.example.json` in this skill bundle is a template — its `apiKey`/`secret` fields must remain placeholders.
- **Never print or echo the wallet secret.** `keygen.mjs` writes it directly to the file and prints only the pubkey — match that pattern in any helper script you generate.
- **Don't upload the profile** anywhere. No paste sites, gists, screenshots.
- **Refuse to start if any hard requirement is missing.** Print exactly which field, with the URL to obtain it.
- **Default provider is `claude`, default model is `claude-haiku-4-5`.** Only override if the user explicitly asks for a different one.
- **Don't enable `fullAiControl: true` silently.** If the user hasn't explicitly authorized it, default to `false`.
- **`maxBuySol` must be ≥ 1** in any profile you generate (the trader enforces it; profiles below this fail validation).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Anthropic HTTP 401` | Bad or missing Anthropic key | Verify `agentGaryFullAi.apiKey` or `ANTHROPIC_API_KEY` env var. Key starts with `sk-ant-`. |
| `Anthropic HTTP 429` | Rate-limited | Drop to a smaller model (`claude-haiku-4-5`), or back off the trading loop frequency. |
| `Jupiter HTTP 401` / `403` | Bad Jupiter key | Re-issue at https://portal.jup.ag/pricing and paste into `jupiter.apiKey`. |
| `rpc.url is required` | Profile missing or malformed | Verify with `node -e 'JSON.parse(require("fs").readFileSync("./profile.json","utf8"))'`. |
| `Insufficient SOL for fee + buy` | Burner not funded enough | Send more SOL to the address `keygen.mjs` printed. |
| Trader runs but never buys | LLM disabled or `auto.enabled: false` | Check `agentGaryFullAi.enabled` and `auto.enabled`. |
| `Unsupported LLM provider: ...` | Typo in `provider` | Must be one of: `claude`, `openai`, `gemini`, `grok`, `deepseek`, `gary` (or `anthropic` → claude). |
| `wallet.secret` not loading | Wrong format | Must be base58 (88 chars typical) or a stringified JSON byte array `[12,34,...]`. Regenerate with `node keygen.mjs profile.json --force`. |

---

## Hand-off after start

Once the CLI is running, the user can watch the live logs. Useful next questions to surface:
- "Show me current positions" → tell them to look for `[trader] pos` lines in console.
- "How do I stop it?" → `Ctrl+C` in the terminal running it.
- "How do I change risk mid-flight?" → edit `agentGaryFullAi.riskLevel` in `profile.json` and restart.
- "Where do snapshots go?" → in-process; for replay, see `tools/snapshots/` in the repo.
