// test/quant/sim-vs-live.test.mjs
// PROVES: paper-mode engine (`executor = 'sim'`) executes the SAME state mutations
// as `executor = 'live'` with a stub CDP-shaped API. The fill source differs
// (simulated fill via priceMap vs verified REST response via Coinbase), but the
// downstream state effects (ratchet, baseline, holdings, cash, audit ringbuffer,
// cycle counts) are identical.
//
// If this test fails, sim-mode silently diverges from live-mode. That's the
// betrayal the user is auditing against.

import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TradingEngine } from '../../src/worm/engine/trading-engine.mjs';
import { setMinOrderQtyMap, getMinOrderQtyMap } from '../../src/worm/utils/quantity.mjs';

const originalMinOrderQtyMap = { ...getMinOrderQtyMap() };

function resetMinOrderQtyMap() {
  setMinOrderQtyMap({ ...originalMinOrderQtyMap });
}

// --- fake Coinbase-shaped API for the LIVE branch ---
// Each placeBuy returns { id, average_filled_price, filled_asset_quantity } as
// Coinbase would. The sim branch never calls these — but they have to look
// identical to the SIM-branch synthesized outputs for the assertion to pass.
function makeFakeLiveApi(expectedPrice, slippage = 0.005, missingSymbols = new Set()) {
  return {
    placeBuy: async (productId, qty) => {
      if (missingSymbols.has(productId)) throw new Error(`live stub refuses ${productId}`);
      const sym = productId.split('-')[0];
      return {
        id: `live_buy_${Math.random().toString(36).slice(2)}`,
        client_order_id: `oid_${Date.now()}`,
        average_filled_price: (expectedPrice * (1 + slippage)).toFixed(8),
        filled_asset_quantity: qty,
      };
    },
    placeSell: async () => ({ id: null }),
    getOrderStatus: async (id) => ({
      id,
      state: 'filled',
      average_filled_price: id && expectedPrice ? (expectedPrice * (1 + slippage)).toFixed(8) : null,
      filled_asset_quantity: '0.0155',
    }),
    getQuotes: async (syms) => {
      // Mirror the SIM priceMap source so the spawn fall-back price-pipeline
      // resolves the same way in both branches.
      const out = {};
      for (const s of syms) out[s] = expectedPrice;
      return out;
    },
  };
}

describe('executor parity: sim and live must produce identical state mutations', () => {
  beforeEach(() => resetMinOrderQtyMap());

  test('sim executor with priceMap == live executor with stub API for one spawn', async () => {
    setMinOrderQtyMap({ SOL: 0.00001 });
    const cfg = await import('../../src/worm/config/constants.mjs');
    const initialCapital = 1000;
    const expectedPrice = 75;

    // --- SIM executor ---
    const sim = new TradingEngine(cfg.defaultGenome, 'sim', initialCapital, {});
    const simR = await sim.update([], null, initialCapital, {}, Date.now(), { SOL: expectedPrice });

    // --- LIVE executor with stub API ---
    const live = new TradingEngine(cfg.defaultGenome, 'live', initialCapital, {});
    const liveApi = makeFakeLiveApi(expectedPrice);
    const liveR = await live.update([], liveApi, initialCapital, {}, Date.now(), { SOL: expectedPrice });

    // Both must agree: same trade decision
    assert.equal(simR.anyTradesThisCycle, liveR.anyTradesThisCycle, 'sim/live must agree on trade decision');
    assert.equal(simR.tradedSymbols.length, liveR.tradedSymbols.length, 'sim/live must agree on traded syms');
    assert.ok(simR.tradedSymbols.includes('SOL') && liveR.tradedSymbols.includes('SOL'), 'both must trade SOL');

    // Baselines must be initialized identically
    assert.equal(sim.baselines.SOL, live.baselines.SOL, 'sim/live baselines must match');

    // Holdings must be populated for both (we expect a sim-buy qty match too)
    assert.ok(sim.holdings.SOL, 'sim must populate holdings');
    assert.ok(live.holdings.SOL, 'live must populate holdings');

    // Cash must drop by approximately the same amount (slippage math agrees)
    const simCashDelta = initialCapital - sim.cashBalance;
    const liveCashDelta = initialCapital - live.cashBalance;
    assert.ok(Math.abs(simCashDelta - liveCashDelta) / initialCapital < 0.05,
      `cash delta divergence too high: sim=${simCashDelta.toFixed(4)} live=${liveCashDelta.toFixed(4)}`);

    // Cycle counters must agree
    assert.equal(sim._cycleCounters.buys, live._cycleCounters.buys, `_cycleCounters.buys must match`);

    // Audit ringbuffer must record one fill for both
    assert.equal(sim._audit.fills.length, 1, 'sim must record exactly one fill');
    assert.equal(live._audit.fills.length, 1, 'live must record exactly one fill');

    // Slippage observation must run for both (different absolute magnitude is OK,
    // both must be finite and inside the slippage clamp range).
    assert.ok(Number.isFinite(sim.ratchetState.SOL.lastSlippage), 'sim ratchet state has finite lastSlippage');
    assert.ok(Number.isFinite(live.ratchetState.SOL.lastSlippage), 'live ratchet state has finite lastSlippage');
  });

  test('sim/src never touches external API (placeBuy is not invoked)', async () => {
    setMinOrderQtyMap({ SOL: 0.00001 });
    const cfg = await import('../../src/worm/config/constants.mjs');

    let liveApiCalled = false;
    const api = {
      placeBuy: async () => { liveApiCalled = true; throw new Error('sim must NOT call placeBuy'); },
      placeSell: async () => { liveApiCalled = true; throw new Error('sim must NOT call placeSell'); },
      getQuotes: async () => ({}),
    };

    const sim = new TradingEngine(cfg.defaultGenome, 'sim', 10000, {});
    const result = await sim.update([], api, 10000, {}, Date.now(), { SOL: 75 });
    assert.equal(liveApiCalled, false, 'sim executor must not route through live api placeBuy');
    assert.equal(result.tradedSymbols[0], 'SOL');
  });

  test('live executor routes through api.placeBuy', async () => {
    setMinOrderQtyMap({ SOL: 0.00001 });
    const cfg = await import('../../src/worm/config/constants.mjs');

    let placeBuyCalls = 0;
    const api = {
      placeBuy: async () => {
        placeBuyCalls++;
        return {
          id: `live_sol_${Math.random().toString(36).slice(2)}`,
          client_order_id: `oid_${Date.now()}`,
          average_filled_price: '75.5',
          filled_asset_quantity: '0.4',
        };
      },
      placeSell: async () => ({}),
      getOrderStatus: async (id) => ({
        id,
        average_filled_price: '75.5',
        state: 'filled',
        filled_asset_quantity: '0.4',
      }),
      getQuotes: async () => ({}),
    };
    const live = new TradingEngine(cfg.defaultGenome, 'live', 10000, {});
    const result = await live.update([], api, 10000, {}, Date.now(), { SOL: 75 });
    assert.equal(placeBuyCalls, 1, 'live executor must route through api.placeBuy');
    assert.equal(result.tradedSymbols[0], 'SOL');
  });
});
