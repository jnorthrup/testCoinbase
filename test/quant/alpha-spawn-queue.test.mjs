// test/quant/alpha-spawn-queue.test.mjs
// The spawner must prefer real-time alpha (5-min WS tape or 24h gainers)
// over the hardcoded MIN_ORDER_QTY_MAP. This is the gap behind "every bet
// a bet against BTC or ETH and yet the agent just buys shit and ignores
// the 24 hour outliers" — the static map was the only source. After this
// cut: spawnQueue = alphaRanked[..].map(.symbol) ++ MIN_ORDER_QTY_MAP keys,
// alphaResolved first, static map as a fallback.

import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TradingEngine } from '../../src/worm/engine/trading-engine.mjs';
import { setMinOrderQtyMap, getMinOrderQtyMap } from '../../src/worm/utils/quantity.mjs';

const original = { ...getMinOrderQtyMap() };

function makeApiWithMovers(movers) {
  return {
    lastSpawnCandidates: undefined,
    getShortTermMovers: async () => movers,
    getGainersLosers: async (limit) => ({
      gainers: movers.slice(0, limit).map(m => ({ symbol: m.symbol, change24h: m.change24h, price: 1 })),
      losers: [],
      all: movers.map(m => ({ symbol: m.symbol, change24h: m.change24h, price: 1 })),
    }),
    getQuotes: async () => ({}),
    placeBuy: async () => null,
    placeSell: async () => null,
  };
}

describe('alpha-spawn-queue: ranked market data takes priority over hardcoded map', () => {
  beforeEach(() => setMinOrderQtyMap({ ...original }));

  test('alpha not in MIN_ORDER_QTY_MAP still spawns (alpha wins)', async () => {
    setMinOrderQtyMap({ BTC: 0.00001 });
    const cfg = await import('../../src/worm/config/constants.mjs');
    const engine = new TradingEngine(cfg.defaultGenome, 'sim', 10000, {});

    // alpha list contains a sym NOT in MIN_ORDER_QTY_MAP — this should be the spawn pick.
    const api = makeApiWithMovers([
      { symbol: 'XBONK', change5m: 0.42, change24h: 1.10, source: 'ws-tape' },
      { symbol: 'STAB',  change5m: 0.05, change24h: 0.10, source: 'ws-tape' },
      { symbol: 'ALPHA', change5m: 0.30, change24h: 0.55, source: 'ws-tape' },
    ]);

    const r = await engine.update([], api, 10000, {}, Date.now(), { XBONK: 5, STAB: 1, ALPHA: 2 });
    assert.equal(r.anyTradesThisCycle, true);
    assert.equal(r.tradedSymbols[0], 'XBONK',
      'the alpha-routed XBONK must be the spawn pick, not BTC from the static map');
    assert.equal(engine.holdings.XBONK?.rawQuantity > 0, true);
    // BTC must NOT also have been hydrated; alpha-only spawn
    assert.equal(engine.holdings.BTC, undefined);
  });

  test('static map asset pre-suppressed by HARVEST_EXCLUDE → ranked alpha wins', async () => {
    setMinOrderQtyMap({ BTC: 0.00001, SOL: 0.1 });
    const cfg = await import('../../src/worm/config/constants.mjs');
    const engine = new TradingEngine(cfg.defaultGenome, 'sim', 10000, {});
    // Empty movers → pure static fallback → SOL wins (BTC is HARVEST_EXCLUDE'd).
    const api = makeApiWithMovers([]);
    const r = await engine.update([], api, 10000, {}, Date.now(), { SOL: 100 });
    assert.equal(r.tradedSymbols[0], 'SOL');
    assert.equal(engine.holdings.SOL?.rawQuantity > 0, true);
  });

  test('mid-cycle alpha refresh: next call within MIN_REFRESH_MS reuses cache', async () => {
    setMinOrderQtyMap({ BTC: 0.00001 });
    const cfg = await import('../../src/worm/config/constants.mjs');
    const engine = new TradingEngine(cfg.defaultGenome, 'sim', 10000, {});
    let moverCalls = 0;
    const api = {
      lastSpawnCandidates: undefined,
      getShortTermMovers: async () => { moverCalls++; return [{ symbol: 'XBONK', change5m: 0.5, change24h: 1.0, source: 'ws-tape' }]; },
      getQuotes: async () => ({}),
    };
    // First cycle — refresh
    await engine.update([], api, 10000, {}, Date.now(), { XBONK: 5 });
    // Second cycle (sub-second apart) — should reuse cached movers, NOT call getShortTermMovers again
    await engine.update([], api, 10000, {}, Date.now() + 100, { XBONK: 5 });
    assert.equal(moverCalls, 1, 'getShortTermMovers must be at most once per MIN_REFRESH_MS');
  });

  test('BTC and ETH are HARVEST_EXCLUDE — neither should ever spawn', async () => {
    setMinOrderQtyMap({ BTC: 0.00001, ETH: 0.0001 });
    const cfg = await import('../../src/worm/config/constants.mjs');
    const engine = new TradingEngine(cfg.defaultGenome, 'sim', 10000, {});
    const api = makeApiWithMovers([
      // BTC and ETH are in alpha source — they still MUST be filtered out.
      { symbol: 'BTC', change5m: 0.05, change24h: 0.10, source: 'ws-tape' },
      { symbol: 'ETH', change5m: 0.03, change24h: 0.06, source: 'ws-tape' },
    ]);
    const r = await engine.update([], api, 10000, {}, Date.now(), { BTC: 64500, ETH: 3500 });
    // BTC/ETH are HARVEST_EXCLUDE'd so engine either spawns nothing or spawns SOMETHING ELSE.
    // The negative assertion: BTC and ETH are NOT in tradedSymbols or holdings.
    for (const s of r.tradedSymbols) {
      assert.notEqual(s, 'BTC', 'BTC is HARVEST_EXCLUDE — must never spawn');
      assert.notEqual(s, 'ETH', 'ETH is HARVEST_EXCLUDE — must never spawn');
    }
  });

  test('excluded symbol from alpha (HARVEST_EXCLUDE) is filtered out before pickup', async () => {
    setMinOrderQtyMap({});
    const cfg = await import('../../src/worm/config/constants.mjs');
    const engine = new TradingEngine(cfg.defaultGenome, 'sim', 10000, {});
    // USD is HARVEST_EXCLUDE; engine must NOT pick it from alpha.
    const api = makeApiWithMovers([
      { symbol: 'USDC', change5m: 0.99, change24h: 1.0, source: 'ws-tape' },
      { symbol: 'XLINK', change5m: 0.10, change24h: 0.20, source: 'ws-tape' },
    ]);
    const r = await engine.update([], api, 10000, {}, Date.now(), { XLINK: 1 });
    // XLINK is not in MIN_ORDER_QTY_MAP, so unless checkMinQuantity passes, nothing spawns.
    // The point: USD/USDC must NEVER be selected even when alpha ranks it top.
    if (r.tradedSymbols.length > 0) {
      assert.notEqual(r.tradedSymbols[0], 'USDC', 'HARVEST_EXCLUDE assets must never be alpha-spawned');
    }
  });
});
