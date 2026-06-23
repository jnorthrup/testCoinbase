// test/quant/shadow-spawn-price.test.mjs
// Shadow mitosis must use observable prices. It must not invent $1.00 when
// priceMap/portfolioSummary/API quotes cannot price the next asset.

import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { TradingEngine } from '../../src/worm/engine/trading-engine.mjs';
import { getMinOrderQtyMap, setMinOrderQtyMap } from '../../src/worm/utils/quantity.mjs';

const originalMinOrderQtyMap = { ...getMinOrderQtyMap() };

afterEach(() => {
  setMinOrderQtyMap({ ...originalMinOrderQtyMap });
});

function makeShadowEngine() {
  return new TradingEngine({}, 'SHADOW', 100, {});
}

describe('TradingEngine shadow mitosis price sourcing', () => {
  test('missing price skips shadow spawn without mutating holdings/cash/baseline', async () => {
    setMinOrderQtyMap({ ZEC: 0.00001 });
    const engine = makeShadowEngine();
    const api = { getQuotes: async () => ({}) };

    const result = await engine.update([], api, 100, {}, Date.now(), {});

    assert.equal(result.anyTradesThisCycle, false);
    assert.equal(engine.holdings.ZEC, undefined);
    assert.equal(engine.baselines.ZEC, undefined);
    assert.equal(engine.cashBalance, 100);
  });

  test('priceMap price sizes shadow spawn by actual asset price, not $1', async () => {
    setMinOrderQtyMap({ ZEC: 0.00001 });
    const engine = makeShadowEngine();

    const result = await engine.update([], null, 100, {}, Date.now(), { ZEC: 465 });

    assert.equal(result.anyTradesThisCycle, true);
    assert.equal(engine.baselines.ZEC, 30);
    // roundQty rounds up to min increment (0.00001 for ZEC), so 30/465 ≈ 0.064516 → 0.06452
    const expectedQty = Math.ceil((30 / 465) / 0.00001) * 0.00001;
    assert.ok(Math.abs(engine.holdings.ZEC.rawQuantity - expectedQty) < 1e-12);
    // Cash reduced by actualCost = filledQty * effectivePrice (includes slippage ~0.5-1%)
    // Just verify cash decreased by approximately spawnCost
    assert.ok(engine.cashBalance < 100 && engine.cashBalance > 60);
  });
});
