import { describe, it, expect, beforeEach, vi } from 'vitest';


vi.mock('../ingest.js', () => {
  return {
    addKpiAddon: vi.fn(() => {}),
    getLatestSnapshot: vi.fn(() => null),
  };
});

class LocalStorageMock {
  constructor() { this.store = {}; }
  clear() { this.store = {}; }
  getItem(key) { return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null; }
  setItem(key, value) { this.store[key] = String(value); }
  removeItem(key) { delete this.store[key]; }
}

const setNow = (d) => {
  vi.setSystemTime(d instanceof Date ? d : new Date(d));
};

async function loadPumping() {
  vi.resetModules();
  const pumping = await import('../pumping.js');
  return pumping;
}

const makeRec = (ts, kp) => ({ ts, kp });

beforeEach(() => {
  vi.useFakeTimers();
  setNow(new Date('2025-01-01T00:00:00.000Z'));
  vi.stubGlobal('localStorage', new LocalStorageMock());
});

describe('pumping scoring and leaders', () => {
  it('flags a strong rising coin as "🔥 Pumping" with a strong score', async () => {
    const { computePumpingScoreForMint } = await loadPumping();
    const now = Date.now();

    const records = [
      makeRec(now - 60_000, {
        priceUsd: 1.2,
        liqUsd: 50_000,
        change5m: 3.5,
        change1h: 14,
        change6h: 28,
        v5mTotal: 7_000,  
        v1hTotal: 50_000,
        v6hTotal: 200_000, 
        buySell24h: 0.66,
      }),
    ];

    const res = computePumpingScoreForMint(records, now);
    expect(res.score).toBeGreaterThanOrEqual(2.0);
    expect(res.badge).toBe('🔥 Pumping');
    expect(res.meta.accel5to1).toBeGreaterThan(1.06);
    expect(res.meta.buy).toBeGreaterThan(0.56);
  });

  it('does not flag slight increases as "🔥 Pumping"', async () => {
    const { computePumpingScoreForMint } = await loadPumping();
    const now = Date.now();

    const records = [
      makeRec(now - 60_000, {
        priceUsd: 0.5,
        liqUsd: 20_000,
        change5m: 0.4,
        change1h: 1.8,
        change6h: 3.0,
        v5mTotal: 2_000,  
        v1hTotal: 24_000,
        v6hTotal: 144_000,
        buySell24h: 0.52,
      }),
    ];

    const res = computePumpingScoreForMint(records, now);
    expect(res.score).toBeLessThan(1.0);
    expect(res.badge).not.toBe('🔥 Pumping');
  });

  it('leaders: ranks pumped coins first and filters non-eligible', async () => {
    const {
      ingestPumpingSnapshot,
      computePumpingLeaders,
      PUMP_STORAGE_KEY,
    } = await loadPumping();

    const t0 = new Date('2025-01-01T12:00:00.000Z');
    setNow(t0);

    ingestPumpingSnapshot([
      {
        mint: 'A',
        priceUsd: 1.1,
        liqUsd: 50_000,
        change5m: 3.5,
        change1h: 14,
        change6h: 28,
        v5mTotal: 7_000,
        v1hTotal: 50_000,
        v6hTotal: 200_000,
        buySell24h: 0.66,
      },
      {
        mint: 'B',
        priceUsd: 0.9,
        liqUsd: 30_000,
        change5m: 1.5,
        change1h: 9,
        change6h: 15,
        v5mTotal: 2_500,  
        v1hTotal: 20_000,
        v6hTotal: 80_000,  
        buySell24h: 0.60,
      },
      {
        mint: 'C',
        priceUsd: 0.1,
        liqUsd: 20_000,
        change5m: 2,
        change1h: 12,
        change6h: 20,
        v5mTotal: 500,
        v1hTotal: 800,     
        v6hTotal: 4_800,
        buySell24h: 0.7,
      },
    ]);

    const leaders = computePumpingLeaders(5);
    expect(leaders.length).toBe(2);
    const [first, second] = leaders;
    expect(first.mint).toBe('A');
    expect(second.mint).toBe('B');

    const raw = localStorage.getItem(PUMP_STORAGE_KEY);
    expect(raw).toBeTruthy();
  });

  it('detects rug cooling within the short window and penalizes score', async () => {
    const {
      ingestPumpingSnapshot,
      getRugSignalForMint,
    } = await loadPumping();

    const base = new Date('2025-01-01T13:00:00.000Z');
    setNow(base);

    ingestPumpingSnapshot([
      {
        mint: 'R',
        priceUsd: 2.0,
        liqUsd: 60_000,
        change5m: 2.5,
        change1h: 10,
        change6h: 22,
        v5mTotal: 6_000,
        v1hTotal: 40_000,
        v6hTotal: 160_000,
        buySell24h: 0.62,
      },
    ]);

    setNow(new Date(base.getTime() + 10 * 60 * 1000));
    ingestPumpingSnapshot([
      {
        mint: 'R',
        priceUsd: 1.7,
        liqUsd: 60_000,
        change5m: -15,
        change1h: -4,
        change6h: 5,
        v5mTotal: 2_000,
        v1hTotal: 20_000,
        v6hTotal: 140_000,
        buySell24h: 0.45,
      },
    ]);

    const { rugged, sev, rugFactor, badge, score } = getRugSignalForMint('R', Date.now());
    expect(sev).toBeGreaterThanOrEqual(1); 
    expect(rugged).toBe(true);
    expect(rugFactor).toBeLessThan(1);
    expect(badge).toBe('Cooling');
    expect(score).toBeLessThan(1.5);
  });

  it('applies v1h fallback from vol24h when 1h volume missing', async () => {
    const {
      ingestPumpingSnapshot,
      computePumpingScoreForMint,
      PUMP_STORAGE_KEY,
    } = await loadPumping();

    const now = Date.now();
    ingestPumpingSnapshot([
      {
        mint: 'FALLBACK',
        priceUsd: 0.2,
        liqUsd: 10_000,
        change5m: 0.5,
        change1h: 2,
        change6h: 4,
        vol24hUsd: 24_000,
        buySell24h: 0.5,
      },
    ]);

    const state = JSON.parse(localStorage.getItem(PUMP_STORAGE_KEY));
    const recs = state.byMint['FALLBACK'];
    expect(recs).toBeTruthy();
    const last = recs[recs.length - 1].kp;
    expect(last.v1hTotal).toBe(1000); 

    const scoreRes = computePumpingScoreForMint(recs, now);
    expect(scoreRes.score).toBe(0);
    expect(scoreRes.badge).toBe('Calm');
  });

  it('enforces liquidity and 1h volume gates', async () => {
    const { computePumpingScoreForMint } = await loadPumping();
    const now = Date.now();

    let res = computePumpingScoreForMint(
      [makeRec(now - 30_000, {
        priceUsd: 1,
        liqUsd: 5_000, 
        change5m: 10,
        change1h: 20,
        change6h: 30,
        v5mTotal: 10_000,
        v1hTotal: 50_000,
        v6hTotal: 200_000,
        buySell24h: 0.7,
      })],
      now
    );
    expect(res.score).toBe(0);
    expect(res.badge).toBe('Calm');

    res = computePumpingScoreForMint(
      [makeRec(now - 30_000, {
        priceUsd: 1,
        liqUsd: 10_000,
        change5m: 10,
        change1h: 20,
        change6h: 30,
        v5mTotal: 100,
        v1hTotal: 1_000, 
        v6hTotal: 6_000,
        buySell24h: 0.7,
      })],
      now
    );
    expect(res.score).toBe(0);
    expect(res.badge).toBe('Calm');
  });
});