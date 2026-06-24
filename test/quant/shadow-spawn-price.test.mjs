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
    // Provide an existing portfolio with a high-value position so the spawn
    // (baselines.ZEC = $30) fits within RiskPolicy's CASH_FLOOR + asset-pct caps.
    // cashFloor = 10% * (BTC_value + cash) = 0.10 * 1100 = $110. After trade cash
    // goes from $200 -> $170 (still above $110). Trade notional $30 ≈ 2.7%
    // of $1100 < 20% MAX_ASSET_PCT cap.
    const portfolioSummary = [
      { Symbol: 'BTC', Quantity: 0.02, Price: 50_000, Value: 1_000, Baseline: 1_000 },
    ];

    const result = await engine.update(portfolioSummary, null, 200, {}, Date.now(), { ZEC: 465 });

    assert.equal(result.anyTradesThisCycle, true);
    assert.equal(engine.baselines.ZEC, 30);
    // roundQty rounds up to min increment (0.00001 for ZEC), so 30/465 ≈ 0.064516 → 0.06452
    const expectedQty = Math.ceil((30 / 465) / 0.00001) * 0.00001;
    assert.ok(Math.abs(engine.holdings.ZEC.rawQuantity - expectedQty) < 1e-12);
    // Cash reduced by actualCost = filledQty * effectivePrice (includes slippage ~0.5-1%)
    // Just verify cash decreased by approximately spawnCost
    assert.ok(engine.cashBalance < 200 && engine.cashBalance > 150);
  });
});
