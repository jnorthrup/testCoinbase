// test/quant/metric-position-sizing.test.mjs
// Closes part of rga Gap G2: bundle the three position-sizing value-grounded
// formatters from metrics.mjs (metricCrashFundUsd, metricSpawnCapacity,
// metricHarvestThresholdPct + metricRebalanceThresholdPct) into a single test
// file. Each replaces a scalar guess in the engine:
//   - metricCrashFundUsd       replaces CRASH_FUND_THRESHOLD_PERCENT scalar
//   - metricSpawnCapacity      replaces "implicit: cash - 10% reserve"
//   - metricHarvestThresholdPct replaces FLAT_HARVEST_TRIGGER_PERCENT scalar (USD-grounded)
//
// All four are HOLLOW today (zero production callers). Locking their
// contracts down so a future "value-grounded thresholds" cut can land
// against a verified oracle.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  metricCrashFundUsd,
  metricSpawnCapacity,
  metricHarvestThresholdPct,
  metricRebalanceThresholdPct,
} from '../../src/worm/estimation/metrics.mjs';

describe('metricCrashFundUsd: USD-grounded reserve (closes part of rga Gap G2)', () => {
  test('default args: 5 * $30 buffer + 10% drawdown floor of total portfolio', () => {
    // 5 spawns × $30 = $150 minimum, plus 10% of $1000 portfolio = $100 drawdown reserve
    // Pick the larger of the two: max(150, 100) = 150
    const r = metricCrashFundUsd({ totalPortfolioUsd: 1000, maxDrawdownPct: 0.10 });
    assert.strictEqual(r, 150,
      `default minSpawnCost=$30, buffer=5, max(5*30, 1000*0.10)=max(150,100)=150; got ${r}`);
  });

  test('large portfolio: drawdown reserve wins over spawn buffer', () => {
    const r = metricCrashFundUsd({ totalPortfolioUsd: 10_000, maxDrawdownPct: 0.10 });
    // max(150, 1000) = 1000
    assert.strictEqual(r, 1000);
  });

  test('custom minSpawnCost and buffer reflect', () => {
    // Higher per-spawn cost OR more buffered spawns → larger denominator
    const r = metricCrashFundUsd({
      minSpawnCostUsd: 100, spawnBufferCount: 3,
      totalPortfolioUsd: 1000, maxDrawdownPct: 0.05,
    });
    // max(3*100=300, 50) = 300
    assert.strictEqual(r, 300);
  });
});

describe('metricSpawnCapacity: how many spawns fit after reserve', () => {
  // Note: metricSpawnCapacity takes positional args (cashBalance, crashFundUsd,
  // minSpawnCostUsd) — NOT a destructured object. Refactoring it to take an
  // options bag would be a separate audit; tests must match the current shape.
  test('default min $30 spawn: integer floor of (cash - reserve) / perSpawn', () => {
    // cash=1000, reserve=400 → available=600 → 600/30=20
    assert.strictEqual(metricSpawnCapacity(1000, 400, 30), 20);
  });

  test('cash below reserve → 0 spawn capacity (cannot spawn without dipping into crash fund)', () => {
    assert.strictEqual(metricSpawnCapacity(200, 400, 30), 0);
  });

  test('cash equals reserve → 0 spawn', () => {
    assert.strictEqual(metricSpawnCapacity(400, 400, 30), 0);
  });

  test('partial budget truncates (floor, not round)', () => {
    // 100 / 30 = 3.33 → floor 3
    assert.strictEqual(metricSpawnCapacity(100, 0, 30), 3);
  });

  test('invalid minSpawnCostUsd (zero / negative) → 0', () => {
    assert.strictEqual(metricSpawnCapacity(1000, 0, 0), 0, 'division by zero must yield 0');
    assert.strictEqual(metricSpawnCapacity(1000, 0, -1), 0, 'negative per-spawn cost must yield 0');
  });
});

describe('metricHarvestThresholdPct: USD-grounded percentage (closes part of rga Gap G2)', () => {
  test('returns 0 for non-positive inputs (safe default vs divide-by-zero)', () => {
    assert.strictEqual(metricHarvestThresholdPct(0, 1), 0);
    assert.strictEqual(metricHarvestThresholdPct(-100, 1), 0);
    assert.strictEqual(metricHarvestThresholdPct(100, 0), 0);
    assert.strictEqual(metricHarvestThresholdPct(100, -0.5), 0);
  });

  test('small baseline → larger pct (one-size-fits-some-but-not-all fall)', () => {
    // $30 baseline, $0.25 target → 0.83%
    const r = metricHarvestThresholdPct(30, 0.25);
    assert.ok(r > 0.008 && r < 0.009,
      `$30 baseline + $0.25 profit ≈ 0.83%; got ${(r * 100).toFixed(3)}%`);
  });

  test('large baseline → smaller pct (large accounts harvest less aggressively in pct)', () => {
    const r = metricHarvestThresholdPct(5000, 0.25);
    assert.ok(r < 0.001,
      `$5000 baseline + $0.25 profit ≈ 0.005%; got ${(r * 100).toFixed(4)}%`);
  });

  test('USD-grounded relationship: pct is inversely proportional to baseline', () => {
    const baselineSmall = 30;
    const baselineLarge = 5000;
    const targetUsd = 0.25;
    const a = metricHarvestThresholdPct(baselineSmall, targetUsd);
    const b = metricHarvestThresholdPct(baselineLarge, targetUsd);
    assert.ok(a > b, `$30 < $5000 implies pct(a) > pct(b); got a=${a}, b=${b}`);
    // Verify exact ratio to make the contract obvious
    assert.ok(Math.abs(a / b - (baselineLarge / baselineSmall)) < 0.0001,
      `a/b should equal baselineLarge/baselineSmall (≈166.67x); got ${a/b}`);
  });
});

describe('metricRebalanceThresholdPct: reuses metricHarvestThresholdPct', () => {
  test('returns the same value as metricHarvestThresholdPct under identical args', () => {
    // The function is just a thin wrapper that passes targetUsd → targetUsdRecovery.
    for (const [base, target] of [[30, 0.5], [100, 1], [5000, 0.25], [1, 0.10]]) {
      const h = metricHarvestThresholdPct(base, target);
      const r = metricRebalanceThresholdPct(base, target);
      assert.strictEqual(r, h,
        `rebalance(${base}, ${target}) must equal harvest(${base}, ${target}); got ${r} vs ${h}`);
    }
  });

  test('non-positive inputs still return 0 (delegates to base)', () => {
    assert.strictEqual(metricRebalanceThresholdPct(0, 1), 0);
    assert.strictEqual(metricRebalanceThresholdPct(100, -0.5), 0);
  });
});
