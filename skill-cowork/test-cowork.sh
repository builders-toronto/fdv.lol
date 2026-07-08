#!/usr/bin/env bash
# Role-play a full cowork session: start a mock trader, exercise every helper
# command, verify the round-trip. Run from repo root.
set -e
cd "$(dirname "$0")/.."

# Clean slate
rm -f tools/agent-bridge/trader-state.json \
      tools/agent-bridge/tuning.json \
      tools/agent-bridge/decisions.jsonl \
      tools/agent-bridge/execution-queue.jsonl \
      tools/agent-bridge/execution-results.jsonl

# Spin up mock trader for 45 seconds in the background (test takes ~35s with sleeps)
node tools/agent-bridge/mock-trader.mjs 45 > /tmp/mock-trader.log 2>&1 &
MOCK_PID=$!
sleep 2

echo "═══ Phase 1: STATUS (should show MOCK1 + MOCK2 positions) ═══"
node skill-cowork/cowork-helper.mjs status \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
s = d.get('state') or {}
print(f\"  trader present: {d['present']}, stale: {d['stale']}, ageMs: {d.get('ageMs')}\")
print(f\"  balance: {s.get('solBalance')} SOL\")
print(f\"  positions: {len(s.get('positions') or [])}\")
for p in s.get('positions') or []:
    print(f\"    - {p['symbol']:8} sizeUi={p['sizeUi']} pnl={p['currentPnlPct']}%\")
print(f\"  config.riskLevel: {(s.get('config') or {}).get('riskLevel')}\")
print(f\"  config.stopLossPct: {(s.get('config') or {}).get('stopLossPct')}\")
"

echo ""
echo "═══ Phase 2: MARKET SNAPSHOT (live DexScreener) ═══"
node skill-cowork/cowork-helper.mjs market-snapshot --limit 3 \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"  candidates returned: {d['count']}\")
for c in (d.get('candidates') or [])[:3]:
    print(f\"    - {c['symbol']:10} liq=\${int(c['liquidityUsd']):>7} vol1h=\${int(c['volumeUsd1h']):>7} 5m={c['priceChange5m']:+.2f}%\")
"

echo ""
echo "═══ Phase 3: OBSERVE (append to decision log) ═══"
node skill-cowork/cowork-helper.mjs observe "Market is healthy, top candidates have buys >= sells" \
  | python3 -c "import sys, json; d = json.load(sys.stdin); print(f\"  appended: {d.get('appended')}, kind: {d.get('kind')}\")"

echo ""
echo "═══ Phase 4: TUNE (push risk=medium + tighten SL=8) ═══"
node skill-cowork/cowork-helper.mjs tune --risk medium --sl 8 --trail 3 \
  --block fakeRug1 --block fakeRug2 \
  --reason "5m vol up 3x, tightening stops and pre-blocking known rugs" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
t = d.get('tuning') or {}
print(f\"  version: {t.get('version')}\")
print(f\"  riskLevel: {t.get('riskLevel')}\")
print(f\"  knobs: {t.get('knobs')}\")
print(f\"  blocklist: {t.get('blocklist')}\")
"
sleep 3

echo ""
echo "═══ Phase 5: STATUS AFTER TUNING (mock trader should have applied it) ═══"
node skill-cowork/cowork-helper.mjs status \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
c = (d.get('state') or {}).get('config') or {}
print(f\"  riskLevel: {c.get('riskLevel')}   (expected: medium)\")
print(f\"  stopLossPct: {c.get('stopLossPct')}   (expected: 8)\")
print(f\"  trailPct: {c.get('trailPct')}   (expected: 3)\")
assert c.get('riskLevel') == 'medium', 'tune did not apply riskLevel'
assert c.get('stopLossPct') == 8, 'tune did not apply stopLossPct'
assert c.get('trailPct') == 3, 'tune did not apply trailPct'
print('  ✓ tuning round-tripped through the bridge')
"

echo ""
echo "═══ Phase 6: QUEUE-BUY (gated, should succeed since trader is fresh) ═══"
node skill-cowork/cowork-helper.mjs queue-buy 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU --sol 0.15 --slip 250 \
  --reason "Strong breakout pattern, +8% in 5m with 4x volume" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
q = d.get('queued') or {}
print(f\"  queued id: {q.get('id')}\")
print(f\"  action: {q.get('action')} mint: {q.get('mint')[:8]}…\")
print(f\"  sizeSol: {q.get('sizeSol')} slip: {q.get('slippageBps')}bps\")
print(f\"  ttl: {q.get('ttlSecs')}s expires: {q.get('expiresAt')}\")
"

echo ""
echo "═══ Phase 7: TUNE WITHOUT REASON (must fail) ═══"
if node skill-cowork/cowork-helper.mjs tune --risk safe 2>/dev/null; then
    echo "  ✗ FAIL: should have rejected tune without --reason"
    exit 1
else
    echo "  ✓ correctly rejected tune without --reason"
fi

echo ""
echo "═══ Phase 8: OUT-OF-BOUNDS KNOB (should clamp, not reject) ═══"
node skill-cowork/cowork-helper.mjs tune --tp 99999 --sl 0.001 --reason "test clamping" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
k = (d.get('tuning') or {}).get('knobs') or {}
print(f\"  takeProfitPct: {k.get('takeProfitPct')}   (expected: 100, clamped from 99999)\")
print(f\"  stopLossPct: {k.get('stopLossPct')}   (expected: 2, clamped from 0.001)\")
assert k.get('takeProfitPct') == 100
assert k.get('stopLossPct') == 2
print('  ✓ clamps work')
"

echo ""
echo "═══ Phase 9: PAUSE / UNPAUSE ═══"
node skill-cowork/cowork-helper.mjs tune --pause --reason "emergency stop test" > /dev/null
sleep 3
PAUSED=$(node skill-cowork/cowork-helper.mjs status | python3 -c "import sys,json; print(json.load(sys.stdin).get('state',{}).get('pauseTrading'))")
echo "  after --pause: pauseTrading=$PAUSED   (expected: True)"
[ "$PAUSED" = "True" ] && echo "  ✓ pause applied"
node skill-cowork/cowork-helper.mjs tune --unpause --reason "resume" > /dev/null
sleep 3
RESUMED=$(node skill-cowork/cowork-helper.mjs status | python3 -c "import sys,json; print(json.load(sys.stdin).get('state',{}).get('pauseTrading'))")
echo "  after --unpause: pauseTrading=$RESUMED   (expected: False)"
[ "$RESUMED" = "False" ] && echo "  ✓ unpause applied"

echo ""
echo "═══ Phase 10: DECISIONS LOG (both sides should appear) ═══"
node skill-cowork/cowork-helper.mjs decisions --tail 20 \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"  total entries: {d['count']}\")
sources = {}
kinds = {}
for e in d['entries']:
    sources[e.get('source','?')] = sources.get(e.get('source','?'),0) + 1
    kinds[e.get('kind','?')] = kinds.get(e.get('kind','?'),0) + 1
print(f\"  sources: {sources}\")
print(f\"  kinds: {kinds}\")
assert 'agent-runtime' in sources, 'no agent-runtime entries'
assert 'trader-gary' in sources, 'no trader-gary entries (cli-writer should have written them)'
print('  ✓ both sides appear in the shared log')
"

echo ""
echo "═══ Cleanup ═══"
wait $MOCK_PID 2>/dev/null || true
rm -f tools/agent-bridge/trader-state.json \
      tools/agent-bridge/tuning.json \
      tools/agent-bridge/decisions.jsonl \
      tools/agent-bridge/execution-queue.jsonl \
      tools/agent-bridge/execution-results.jsonl
echo "  ✓ bridge files cleaned"

echo ""
echo "═══ ALL PHASES PASSED ═══"
