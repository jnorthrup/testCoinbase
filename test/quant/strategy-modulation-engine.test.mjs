// test/quant/strategy-modulation-engine.test.mjs
// Pins the Day 1 volatility-aware strategy wiring in TradingEngine.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TradingEngine } from '../../src/worm/engine/trading-engine.mjs';
import { defaultGenome } from '../../src/worm/config/constants.mjs';

function makeEngine(extraGenome = {}) {
  const genome = {
    ...defaultGenome,
    ENABLE_PORTFOLIO_HARVEST: false,
    overrides: {},
    ...extraGenome,
  };
  const engine = new TradingEngine(genome, 'sim', 0, {});
  engine.logStrategyState = false;
  return engine;
}

function row({ symbol = 'DOGE', value, price = 1, baseline = 100 }) {
  return {
    Symbol: symbol,
    Value: value,
    usdValueNum: value,
    Price: price,
    Baseline: baseline,
  };
}

describe('TradingEngine volatility-aware strategy helpers', () => {
  test('_getEffectiveGenome overlays the symbol regime genome without mutating the base genome', () => {
    const engine = makeEngine();
    engine.regimeState.DOGE = { phase: 'EXPANDING' };
    engine.regimeGenomeManager = {
      getGenome(symbol, regime) {
        if (symbol === 'DOGE' && regime === 'EXPANDING') {
          return {
            FLAT_HARVEST_TRIGGER_PERCENT: 0.052,
            HARVEST_TAKE_PERCENT: 0.81,
          };
        }
        return null;
      },
    };

    const base = {
      ...defaultGenome,
      FLAT_HARVEST_TRIGGER_PERCENT: 0.035,
      HARVEST_TAKE_PERCENT: 0.70,
      overrides: { DOGE: { MIN_SURPLUS_FOR_HARVEST: 0.50 } },
    };

    const effective = engine._getEffectiveGenome('DOGE', base);

    assert.equal(effective.FLAT_HARVEST_TRIGGER_PERCENT, 0.052);
    assert.equal(effective.HARVEST_TAKE_PERCENT, 0.81);
    assert.equal(effective.overrides.DOGE.MIN_SURPLUS_FOR_HARVEST, 0.50);
    assert.equal(base.FLAT_HARVEST_TRIGGER_PERCENT, 0.035, 'base genome must not be mutated');
  });

  test('_getModulatedTriggers initializes a per-symbol volatility filter and returns finite trigger context', () => {
    const engine = makeEngine();
    engine.priceHistory.DOGE = Array.from({ length: 80 }, (_, i) => 1 + (i * 0.002) + (Math.sin(i / 3) * 0.01));

    const out = engine._getModulatedTriggers('DOGE', 0.004, 0.003);

    assert.ok(Number.isFinite(out.conviction), `conviction must be finite, got ${out.conviction}`);
    assert.ok(Number.isFinite(out.rawVolatility) && out.rawVolatility > 0, `raw volatility must be positive, got ${out.rawVolatility}`);
    assert.ok(Number.isFinite(out.filteredVolatility) && out.filteredVolatility > 0, `filtered volatility must be positive, got ${out.filteredVolatility}`);
    assert.ok(engine.volatilityFilters.DOGE, 'per-symbol Kalman volatility filter must be initialized');
    assert.equal(engine.filteredVolatility.DOGE, out.filteredVolatility, 'filtered volatility is exposed on engine state');
    assert.ok(Number.isFinite(out.modulatedHarvestTrigger));
    assert.ok(Number.isFinite(out.modulatedRebalanceTrigger));
    assert.equal(out.harvestModifier, 0.004);
    assert.equal(out.rebalanceModifier, 0.003);
  });

  test('_logStrategyState emits only when strategy logging is enabled', () => {
    const engine = makeEngine();
    const lines = [];
    const originalLog = console.log;
    try {
      console.log = (msg) => lines.push(String(msg));
      engine._logStrategyState('DOGE', { conviction: 0.42, filteredVolatility: 0.031, modulatedHarvestTrigger: 0.047 });
      assert.equal(lines.length, 0, 'disabled strategy logging must be silent');

      engine.logStrategyState = true;
      engine._logStrategyState('DOGE', { conviction: 0.42, filteredVolatility: 0.031, modulatedHarvestTrigger: 0.047 });
      assert.equal(lines.length, 1);
      assert.match(lines[0], /\[STRATEGY\] DOGE/);
      assert.match(lines[0], /conviction/);
      assert.match(lines[0], /0\.42/);
    } finally {
      console.log = originalLog;
    }
  });
});

describe('TradingEngine update() uses modulated triggers', () => {
  test('harvest flagging respects _getModulatedTriggers rather than the raw flat trigger', async () => {
    const engine = makeEngine();
    engine.baselines.DOGE = 100;
    engine.priceHistory.DOGE = Array.from({ length: 80 }, (_, i) => 1 + i * 0.001);
    let calls = 0;
    engine._getModulatedTriggers = () => {
      calls++;
      return {
        conviction: 0,
        rawVolatility: 0.02,
        filteredVolatility: 0.02,
        modulatedHarvestTrigger: 0.10,
        modulatedRebalanceTrigger: 0.05,
      };
    };

    await engine.update(
      [row({ value: 104, baseline: 100 })],
      null,
      0,
      { DOGE: { rawQuantity: 104 } },
      1_700_000_000_000,
      {}
    );

    assert.ok(calls > 0, 'harvest path must consult _getModulatedTriggers');
    assert.notEqual(engine.trailingState.DOGE?.flagged, true,
      '104 is above the old 3.5% flat trigger but below the modulated 10% trigger, so it must not flag');
  });

  test('rebalance triggering respects _getModulatedTriggers rather than the raw flat trigger', async () => {
    const engine = makeEngine();
    engine.baselines.DOGE = 100;
    engine.priceHistory.DOGE = Array.from({ length: 80 }, (_, i) => 1 + i * 0.001);
    let calls = 0;
    engine._getModulatedTriggers = () => {
      calls++;
      return {
        conviction: 0,
        rawVolatility: 0.02,
        filteredVolatility: 0.02,
        modulatedHarvestTrigger: 0.04,
        modulatedRebalanceTrigger: 0.10,
      };
    };

    await engine.update(
      [row({ value: 95, baseline: 100 })],
      null,
      0,
      { DOGE: { rawQuantity: 95 } },
      1_700_000_000_000,
      {}
    );

    assert.ok(calls > 0, 'rebalance path must consult _getModulatedTriggers');
    assert.equal(engine.rebalanceState.DOGE, undefined,
      '95 is below the old 3.5% rebalance threshold but above the modulated 10% threshold, so it must not trigger');
  });
});
