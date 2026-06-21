// test/quant/threshold-metrics.test.mjs
// Quant-style RED tests for harvest/rebalance thresholds

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../../coinbase-advanced.js';
import {
  metricHarvestThresholdPct,
  metricRebalanceThresholdPct,
  metricCrashFundUsd,
  metricSpawnCapacity,
  metricCashRatio,
  metricDeployedRatio,
} from '../../src/worm/estimation/metrics.mjs';

let client;
let btcPrice;
let ethPrice;
let zecPrice;
let bicoPrice;

before(async () => {
  client = createClient();
  const [btc, eth, zec, bico] = await Promise.all([
    client.getProduct('BTC-USD'),
    client.getProduct('ETH-USD'),
    client.getProduct('ZEC-USD'),
    client.getProduct('BICO-USD'),
  ]);
  btcPrice = parseFloat(btc.price);
  ethPrice = parseFloat(eth.price);
  zecPrice = parseFloat(zec.price);
  bicoPrice = parseFloat(bico.price);
});

describe('QUANT THRESHOLD METRICS: USD-grounded triggers', () => {
  test('Harvest threshold on $30 position ≠ scalar 0.035 (3.5%)', () => {
    // Quant question: what % is $0.25 profit on a $30 position?
    // Scalar says 3.5% = $1.05 on $30. But MIN_SURPLUS_FOR_HARVEST = $0.25.
    // The threshold SHOULD be 0.25 / 30 = 0.83%, not 3.5%.
    const baseline = 30.0; // MIN_SPAWN_COST_USD
    const targetProfit = 0.25; // MIN_SURPLUS_FOR_HARVEST
    const threshold = metricHarvestThresholdPct(baseline, targetProfit);
    
    const SCALAR_GUESS = 0.035;
    
    // The scalar 0.035 REQUIRES $1.05 profit on $30 baseline.
    // But the system's OWN surplus floor is $0.25.
    // This is an internal contradiction the test exposes.
    assert.ok(
      threshold < SCALAR_GUESS,
      `Harvest threshold: scalar=${(SCALAR_GUESS*100).toFixed(2)}% vs USD-grounded=${(threshold*100).toFixed(2)}%. ` +
      `Scalar REQUIRES $${(baseline * SCALAR_GUESS).toFixed(2)} profit but system floor is $${targetProfit}. ` +
      `REPLACE FLAT_HARVEST_TRIGGER_PERCENT with metricHarvestThresholdPct().`
    );
    
    // The exact relationship: 0.25/30 = 0.00833 = 0.83%
    const expected = targetProfit / baseline;
    assert.ok(Math.abs(threshold - expected) < 0.0001);
  });

  test('Harvest threshold on $5000 position ≠ scalar 0.035', () => {
    // On a large position, 3.5% = $175 profit. That's a different risk profile.
    const baseline = 5000;
    const targetProfit = 0.25;
    const threshold = metricHarvestThresholdPct(baseline, targetProfit);
    
    const SCALAR_GUESS = 0.035;
    
    // The scalar 0.035 on $5000 means $175 profit trigger.
    // But the system still says MIN_SURPLUS_FOR_HARVEST = $0.25.
    // The relationship is completely broken.
    assert.ok(
      threshold < SCALAR_GUESS,
      `Large position: scalar=${(SCALAR_GUESS*100).toFixed(2)}% vs USD-grounded=${(threshold*100).toFixed(4)}%. ` +
      `Scalar REQUIRES $${(baseline * SCALAR_GUESS).toFixed(2)} profit but floor is $${targetProfit}.`
    );
  });

  test('Rebalance threshold on $30 position = harvest threshold', () => {
    const baseline = 30.0;
    const targetRecovery = 0.25;
    const threshold = metricRebalanceThresholdPct(baseline, targetRecovery);
    const harvestThreshold = metricHarvestThresholdPct(baseline, targetRecovery);
    
    assert.equal(threshold, harvestThreshold);
  });

  test('Rebalance on $5000 position uses same USD recovery', () => {
    const baseline = 5000;
    const targetRecovery = 0.25;
    const threshold = metricRebalanceThresholdPct(baseline, targetRecovery);
    
    assert.ok(threshold < 0.035);
    assert.ok(Math.abs(threshold - 0.25/5000) < 0.00001);
  });

  test('Crash fund = max(spawn buffer, drawdown buffer)', () => {
    const crashFund = metricCrashFundUsd({
      minSpawnCostUsd: 30,
      spawnBufferCount: 5,
      totalPortfolioUsd: 1000,
      maxDrawdownPct: 0.10,
    });
    
    // 5 spawns * $30 = $150
    // 10% drawdown on $1000 = $100
    // Crash fund should be max($150, $100) = $150
    assert.equal(crashFund, 150);
    
    // Scalar 0.10 * 1000 = $100 which is WRONG - doesn't cover 5 spawns
    const SCALAR_CRASH = 0.10 * 1000;
    assert.notEqual(crashFund, SCALAR_CRASH);
    
    // This test FAILS because production uses scalar 0.10 * portfolio
    assert.ok(
      crashFund > SCALAR_CRASH,
      `Crash fund: scalar=${SCALAR_CRASH} vs metric=${crashFund}. ` +
      `Scalar doesn't cover ${5} spawns of $${30}. ` +
      `REPLACE CRASH_FUND_THRESHOLD_PERCENT with metricCrashFundUsd().`
    );
  });

  test('Crash fund covers drawdown when portfolio larger than spawn needs', () => {
    const crashFund = metricCrashFundUsd({
      minSpawnCostUsd: 30,
      spawnBufferCount: 2,
      totalPortfolioUsd: 10000,
      maxDrawdownPct: 0.10,
    });
    
    // 2 spawns * $30 = $60
    // 10% drawdown on $10000 = $1000
    // Crash fund = max($60, $1000) = $1000
    assert.equal(crashFund, 1000);
  });

  test('Spawn capacity exposes the implicit relationship', () => {
    const cash = 8000;
    const crashFund = 1000;
    const spawnCost = 30;
    const capacity = metricSpawnCapacity(cash, crashFund, spawnCost);
    
    // Available = 8000 - 1000 = 7000
    // Capacity = 7000 / 30 = 233 spawns possible
    assert.equal(capacity, 233);
    
    // This number is NEVER displayed in the current UI.
    // The operator has to compute it by hand.
    // The metric makes it an explicit, queryable value.
    assert.ok(capacity > 0, 'Must be positive when cash > crash fund');
    
    // Edge case: cash <= crash fund
    const zeroCap = metricSpawnCapacity(500, 1000, 30);
    assert.equal(zeroCap, 0, 'Must be 0 when no deployable cash');
  });

  test('Cash ratio is a derived decision input', () => {
    const cash = 8000;
    const portfolio = 10000;
    const ratio = metricCashRatio(cash, portfolio);
    const deployed = metricDeployedRatio(cash, portfolio);
    
    assert.ok(Math.abs(ratio - 0.8) < 1e-10);
    assert.ok(Math.abs(deployed - 0.2) < 1e-10);
    assert.ok(Math.abs(ratio + deployed - 1.0) < 1e-10);
    
    // The production code NEVER uses these ratios in decisions.
    // Decisions use raw scalars: 0.10 crash fund, 0.035 trigger.
    // The metric exposes the relationship that MUST drive decisions.
  });
});