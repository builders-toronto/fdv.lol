 ✓ pump.test.js (6 tests) 34ms
   ✓ pumping scoring and leaders (6)
     ✓ flags a strong rising coin as "🔥 Pumping" with a strong score 23ms
     ✓ does not flag slight increases as "🔥 Pumping" 2ms
     ✓ leaders: ranks pumped coins first and filters non-eligible 2ms
     ✓ detects rug cooling within the short window and penalizes score 2ms
     ✓ applies v1h fallback from vol24h when 1h volume missing 2ms
     ✓ enforces liquidity and 1h volume gates 1ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  06:30:46
   Duration  229ms (transform 67ms, setup 0ms, collect 67ms, tests 34ms, environment 0ms, prepare 4ms)

---

I tightened the “🔥 Pumping” classification to require clear upward momentum, not just a slight uptick. It now needs both near-term rise and short-window trend-up to badge as Pumping, while keeping existing gates and scoring. Tests you provided pass.


 ✓ pump.test.js (6 tests) 54ms
   ✓ pumping scoring and leaders (6)
     ✓ flags a strong rising coin as "🔥 Pumping" with a strong score 36ms
     ✓ does not flag slight increases as "🔥 Pumping" 4ms
     ✓ leaders: ranks pumped coins first and filters non-eligible 4ms
     ✓ detects rug cooling within the short window and penalizes score 3ms
     ✓ applies v1h fallback from vol24h when 1h volume missing 4ms
     ✓ enforces liquidity and 1h volume gates 2ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  06:35:37
   Duration  609ms (transform 87ms, setup 0ms, collect 86ms, tests 54ms, environment 0ms, prepare 6ms)