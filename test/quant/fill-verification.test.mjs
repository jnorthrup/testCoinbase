// test/quant/fill-verification.test.mjs
// Live placement seam must reject filled orders that have no verified fill price.
// This prevents callers from mutating baselines/Kalman/Kelly/trade history using
// the pre-order expected price as a fake execution price.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { TradingEngine } from '../../src/worm/engine/trading-engine.mjs';

describe('TradingEngine live fill verification seam', () => {
  test('_placeBuy rejects FILLED order with no average_filled_price/average_price', async () => {
    const engine = new TradingEngine({}, 'LIVE');
    engine._cycleCounters = { buys: 0, sells: 0, maxBuys: 2, maxSells: 2 };

    const api = {
      placeBuy: async () => ({ id: 'order-missing-price' }),
      getOrderStatus: async () => ({
        id: 'order-missing-price',
        state: 'filled',
        filled_asset_quantity: '1',
      }),
    };

    const result = await engine._placeBuy(api, 'BTC-USD', '1', 100);

    assert.equal(result, null);
    assert.equal(engine._cycleCounters.buys, 0, 'unverified fill must not count as a completed buy');
  });

  test('_placeBuy accepts FILLED order with Coinbase historical average_filled_price', async () => {
    const engine = new TradingEngine({}, 'LIVE');
    engine._cycleCounters = { buys: 0, sells: 0, maxBuys: 2, maxSells: 2 };

    const api = {
      placeBuy: async () => ({ id: 'order-with-price' }),
      getOrderStatus: async () => ({
        id: 'order-with-price',
        state: 'filled',
        average_filled_price: '123.45',
        filled_asset_quantity: '1',
      }),
    };

    const result = await engine._placeBuy(api, 'BTC-USD', '1', 100);

    assert.equal(result?.id, 'order-with-price');
    assert.equal(engine._cycleCounters.buys, 1);
  });
});
