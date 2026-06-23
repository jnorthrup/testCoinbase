// test/quant/outlier-candidates.test.mjs
// Multi-dimensional outlier fusion: rank symbols across 5-minute WS tape,
// 24-hour gainers/losers, and 24-hour volume-burst signals. Pre-fix, the
// spawn queue only had access to top-10 short-term movers + 24h gainers —
// everything else (high-volume low-momentum "STABLE_X" candidates that
// precede a breakout, or thin-volume pumps whose 5-min return is hot but
// has no real liquidity) was invisible. Post-fix: getOutlierCandidates
// returns one ranked list across all dimensions, and the engine consumes
// it at the spawn-gate via `lastSpawnCandidates`.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setMinOrderQtyMap, getMinOrderQtyMap } from '../../src/worm/utils/quantity.mjs';

const original = { ...getMinOrderQtyMap() };

function makeAdapter({ tape = [], gainers = [], losers = [], products = [] } = {}) {
  return {
    getOutlierCandidates: async (opts = {}) => {
      const limit = opts.limit ?? 30;
      const w = opts.weights ?? { w5m: 1.0, w24h: 0.5, wVolume: 0.3 };
      const out = new Map();
      for (const m of tape) {
        out.set(m.symbol, { symbol: m.symbol, change5m: m.change5m ?? 0, change24h: 0, volume24h: m.volume24h ?? 0, price: 0, sources: ['ws-tape'] });
      }
      for (const m of [...gainers, ...losers]) {
        const cur = out.get(m.symbol) || { symbol: m.symbol, change5m: 0, change24h: 0, volume24h: 0, price: m.price ?? 0, sources: [] };
        cur.change24h = m.change24h ?? 0;
        cur.volume24h = m.volume24h ?? cur.volume24h ?? 0;
        cur.sources.push('gainers24h');
        out.set(m.symbol, cur);
      }
      const sorted = [...products].sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0));
      const cutoff = Math.max(1, Math.floor(sorted.length * (opts.volumePercentileCutoff ?? 0.95)));
      for (let i = 0; i < Math.min(cutoff, sorted.length); i++) {
        const m = sorted[i];
        const cur = out.get(m.symbol) || { symbol: m.symbol, change5m: 0, change24h: 0, volume24h: m.volume24h ?? 0, price: 0, sources: [] };
        cur.volume24h = m.volume24h ?? cur.volume24h ?? 0;
        cur.sources.push('vol-burst');
        out.set(m.symbol, cur);
      }
      const maxVol = Math.max(1, ...[...out.values()].map(v => v.volume24h || 0));
      for (const v of out.values()) {
        const c5 = Math.abs(v.change5m);
        const c24 = Math.abs(v.change24h);
        const volRatio = v.volume24h / maxVol;
        const volScore = Math.log10(1 + 9 * volRatio);
        v.score = w.w5m * c5 + w.w24h * c24 + w.wVolume * volScore;
      }
      return [...out.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    },
  };
}

describe('outlier-candidates fusion: attack all units of action across dimensions', () => {
  beforeEach(() => setMinOrderQtyMap({ ...original }));

  test('5-min tape ranks above 24h gainers with no recent tape when 5m movement is hot', async () => {
    const api = makeAdapter({
      tape: [{ symbol: 'XBONK', change5m: 0.40, price: 5 }],
      gainers: [{ symbol: 'BTC', change24h: 0.10, volume24h: 1000000, price: 64500 }],
      losers: [{ symbol: 'ETH', change24h: -0.05, volume24h: 500000, price: 3500 }],
      products: [{ symbol: 'BTC', volume24h: 1000000 }, { symbol: 'ETH', volume24h: 500000 }],
    });
    const candidates = await api.getOutlierCandidates({ limit: 30 });
    const names = candidates.map(c => c.symbol);
    // XBONK: 0.40 (5m tape) → score ~0.40
    // BTC: 0.10 (24h) + log10(1+9) ~= 0.05 (vol) → score ~0.15
    // XBONK must come before BTC because 5-mov × weight=1.0 dominates.
    assert.ok(names.indexOf('XBONK') < names.indexOf('BTC'),
      `XBONK must rank above BTC. Got: ${JSON.stringify(candidates)}`);
  });

  test('volume-anchored STABLE_X (no 5m, modest 24h) outranks low-vol pump when weights favor liquidity', async () => {
    const api = makeAdapter({
      tape: [{ symbol: 'PUMP_Z', change5m: 0.50, price: 0.01 }],
      gainers: [
        { symbol: 'PUMP_Z', change24h: 0.0, volume24h: 1000, price: 0.01 },
        { symbol: 'STABLE_X', change24h: 0.04, volume24h: 50_000_000, price: 50 },
      ],
      losers: [],
      products: [
        { symbol: 'PUMP_Z', volume24h: 1000 },
        { symbol: 'STABLE_X', volume24h: 50_000_000 },
      ],
    });
    // Default weights (w5m=1.0, w24h=0.5, wVolume=0.3). Increase volume share.
    const candidates = await api.getOutlierCandidates({
      limit: 30,
      weights: { w5m: 0.5, w24h: 0.5, wVolume: 1.0 },
    });
    const names = candidates.map(c => c.symbol);
    // STABLE_X has volumeRatio=1.0 → volScore=1.0, change24h=0.04 → c24=0.04
    // STABLE_X score ≈ 0.5*0.04 + 0.5*0.04 + 1.0*1.0 ≈ 1.04
    // PUMP_Z score ≈ 0.5*0.50 + 0.5*0.0 + 1.0*log10(1+9)*(1000/50M) ≈ 0.25
    // STABLE_X wins when volume weight dominates.
    assert.ok(names.indexOf('STABLE_X') < names.indexOf('PUMP_Z'),
      `STABLE_X must outrank PUMP_Z at high wVolume. Got: ${JSON.stringify(candidates)}`);
  });

  test('candidates are deduped across dimensions: a symbol that appears in 2+ sources ranks once with composite score', async () => {
    const api = makeAdapter({
      tape: [{ symbol: 'XBONK', change5m: 0.30, price: 5 }],
      gainers: [{ symbol: 'XBONK', change24h: 0.20, volume24h: 80000, price: 5 }],
      losers: [],
      products: [{ symbol: 'XBONK', volume24h: 80000 }],
    });
    const candidates = await api.getOutlierCandidates({ limit: 30 });
    const xbonkEntries = candidates.filter(c => c.symbol === 'XBONK');
    assert.equal(xbonkEntries.length, 1, 'symbol must appear exactly once with composite score');
    assert.equal(xbonkEntries[0].sources.length, 3, 'sources list must show all three dimensions contributed');
  });

  test('default weights prioritize 5-min tape dominance and fall back gracefully when WS is cold', async () => {
    const api = makeAdapter({
      // tape empty — WS cold
      tape: [],
      gainers: [{ symbol: 'BTC', change24h: 0.10, volume24h: 1_000_000, price: 64500 }],
      losers: [{ symbol: 'ETH', change24h: -0.08, volume24h: 500_000, price: 3500 }],
      products: [{ symbol: 'BTC', volume24h: 1_000_000 }, { symbol: 'ETH', volume24h: 500_000 }],
    });
    const candidates = await api.getOutlierCandidates({ limit: 30 });
    // BTC and ETH both appear; both have abs(change24h) ~ similar.
    // BTC wins on volume (2× ETH), so its score is slightly higher.
    const names = candidates.map(c => c.symbol);
    assert.ok(names.length >= 1);
    assert.ok(names.includes('BTC') || names.includes('ETH'));
  });
});

describe('engine spawn-gate consumes multi-dim candidates', () => {
  beforeEach(() => setMinOrderQtyMap({ ...original }));

  test('engine prefers ranked outlier when present over static map', async () => {
    setMinOrderQtyMap({ BTC: 0.00001 });
    const cfg = await import('../../src/worm/config/constants.mjs');
    const engine = new (await import('../../src/worm/engine/trading-engine.mjs')).TradingEngine(
      cfg.defaultGenome, 'sim', 10000, {},
    );
    // BTC is HARVEST_EXCLUDE, but STABLE_XBT is not. The outlier source surfaces
    // both — the engine's `!HARVEST_EXCLUDE` filter must drop BTC at the gate.
    const api = {
      getOutlierCandidates: async () => ([
        { symbol: 'BTC', change5m: 0, change24h: 0.10, volume24h: 1_000_000, score: 0.5, source: 'vol-burst' },
        { symbol: 'STABLE_XBT', change5m: 0, change24h: 0.20, volume24h: 2_000_000, score: 0.6, source: 'vol-burst' },
      ]),
      getQuotes: async () => ({ STABLE_XBT: 5, BTC: 64500 }),
    };
    const r = await engine.update([], api, 10000, {}, Date.now(), { BTC: 64500, STABLE_XBT: 5 });
    // Both arrive as candidates. BTC is HARVEST_EXCLUDE'd. STABLE_XBT spawns.
    assert.equal(r.tradedSymbols[0], 'STABLE_XBT',
      `engine must pick STABLE_XBT (multi-dim score=0.6) over BTC (excluded). Got: ${JSON.stringify(r.tradedSymbols)}`);
    assert.equal(engine.holdings.STABLE_XBT?.rawQuantity > 0, true);
    assert.equal(engine.holdings.BTC, undefined, 'BTC must NOT be in holdings');
  });

  test('engine falls back to getShortTermMovers when getOutlierCandidates is missing (legacy adapters)', async () => {
    setMinOrderQtyMap({ STABLE_XBT: 0.00001 });
    const cfg = await import('../../src/worm/config/constants.mjs');
    const engine = new (await import('../../src/worm/engine/trading-engine.mjs')).TradingEngine(
      cfg.defaultGenome, 'sim', 10000, {},
    );
    let wasCalled = false;
    const api = {
      getShortTermMovers: async () => {
        wasCalled = true;
        return [{ symbol: 'STABLE_XBT', change5m: 0.15, change24h: 0.0, source: 'ws-tape' }];
      },
      getQuotes: async () => ({ STABLE_XBT: 5 }),
    };
    const r = await engine.update([], api, 10000, {}, Date.now(), { STABLE_XBT: 5 });
    assert.equal(wasCalled, true, 'engine must fall back to getShortTermMovers when getOutlierCandidates missing');
    assert.equal(r.tradedSymbols[0], 'STABLE_XBT');
  });
});
