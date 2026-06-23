// test/quant/metric-baseline-drag.test.mjs
// Closes part of rga Gap G2 specifically flagged by the rga skill's "Dead
// estimation code" pattern: metricBaselineDrag and metricPromotionEligible
// have correct formulas but zero production callers. Production code still
// uses SPAR_DRAG_COEFFICIENT = 0.999968 and a 1-trade promotion gate.
// This test exercises both functions and makes the contract HARD-tested so a
// future wiring cut (engine's spawn-gate) can land against a verified oracle
// instead of guessing the math.
//
// Contract under test:
//   metricBaselineDrag(recentPrices) -> drag scalar in [0.99, 0.99999]
//     - recentPrices.length < 10 -> 0.999968 (fallback, mirrors SPAR_DRAG_COEFFICIENT)
//     - mean abs log-return mapped: drag = clamp(1 - meanReturn*0.5, 0.99, 0.99999)
//   metricPromotionEligible(tradeHistory, minCumulativeUsd=1.0, minWinStreak=3) -> boolean
//     - cumulative pnlUsd >= minCumulativeUsd AND trailing-win-streak >= minWinStreak

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  metricBaselineDrag,
  metricPromotionEligible,
} from '../../src/worm/estimation/metrics.mjs';

function bullsRun(n, dailyReturnPct = 0.01) {
  // Synthesise a deterministic steady-uptrend price series.
  const prices = [100];
  for (let i = 1; i < n; i++) {
    prices.push(prices[i - 1] * (1 + dailyReturnPct));
  }
  return prices;
}

function chops(n) {
  // Alternating +1% / -1% returns → mean abs log-return ≈ 1%.
  const prices = [100];
  for (let i = 1; i < n; i++) {
    prices.push(prices[i - 1] * (i % 2 === 0 ? 1.01 : 0.99));
  }
  return prices;
}

describe('metricBaselineDrag + metricPromotionEligible: regime-aware promotion gates', () => {
  test('metricBaselineDrag: short / null history returns 0.999968 fallback', () => {
    assert.strictEqual(metricBaselineDrag(null), 0.999968);
    assert.strictEqual(metricBaselineDrag(undefined), 0.999968);
    assert.strictEqual(metricBaselineDrag([]), 0.999968);
    assert.strictEqual(metricBaselineDrag(bullsRun(9)), 0.999968,
      'strict-less-than 10: 9 prices must still hit the fallback');
  });

  test('metricBaselineDrag: bigger mean abs log-return → smaller drag (more conservative)', () => {
    // 1% daily stepwise returns → mean abs log-return = ln(1.01) ≈ 0.00995
    // drag = clamp(1 - 0.00995 * 0.5, 0.99, 0.99999) = clamp(0.995, ...) = 0.995
    const bulls = metricBaselineDrag(bullsRun(40));
    // 1% step chop → similar mean abs log-return (alternating +/- 1%)
    const chop = metricBaselineDrag(chops(40));

    // Both should be strictly less than the 0.999968 fallback because measn abs
    // log-return is non-trivial.
    assert.ok(bulls < 0.999968 && bulls > 0.99,
      `bulls return must map to [0.99, 0.999968); got ${bulls}`);
    assert.ok(chop < 0.999968 && chop > 0.99,
      `chop return must map to [0.99, 0.999968); got ${chop}`);

    // The chop series has larger mean abs log-return than a steady bull run
    // because volatility compounds. Drag must be smaller (more conservative).
    assert.ok(chop < bulls,
      `chop (more volatile) must produce smaller drag than steady bull; bulls=${bulls}, chop=${chop}`);
  });

  test('metricBaselineDrag: extreme volatility clamps at 0.99 floor', () => {
    // Construction: prices oscillating ±50% daily → mean abs log-return ~0.41
    // drag = 1 - 0.41*0.5 = 0.795 → floor 0.99
    const prices = [100];
    for (let i = 1; i < 30; i++) {
      prices.push(prices[i - 1] * (i % 2 === 0 ? 1.5 : 0.5));
    }
    const drag = metricBaselineDrag(prices);
    assert.strictEqual(drag, 0.99, `extreme volatility must clamp at 0.99 floor; got ${drag}`);
  });

  test('metricBaselineDrag: result is always in [0.99, 0.99999] inclusive', () => {
    // Stress: any random-ish input must produce valid drag.
    const inputs = [
      bullsRun(100), chops(100),
      [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100], // flat
      [100, 0.01, 100, 0.01, 100, 0.01, 100, 0.01, 100, 0.01, 100], // pathological
    ];
    for (const inp of inputs) {
      const d = metricBaselineDrag(inp);
      assert.ok(d >= 0.99 && d <= 0.99999,
        `drag for [${inp.length}-long input] must be in [0.99, 0.99999]; got ${d}`);
    }
  });

  test('metricPromotionEligible: empty/null history returns false (no gate admission)', () => {
    assert.strictEqual(metricPromotionEligible(null), false);
    assert.strictEqual(metricPromotionEligible(undefined), false);
    assert.strictEqual(metricPromotionEligible([]), false);
  });

  test('metricPromotionEligible: trailing 3 wins AND cumulative >= threshold -> true', () => {
    const hist = [
      { pnlUsd: -0.5 },        // earlier loss — breaks the trailing streak
      { pnlUsd: 0.3 },
      { pnlUsd: 0.4 },
      { pnlUsd: 0.5 },
    ];
    // Trailing streak from end: 0.5, 0.4, 0.3, then -0.5 → streak = 3 (the first loss breaks)
    // Cumulative = -0.5 + 0.3 + 0.4 + 0.5 = 0.7 → BELOW default minCumulativeUsd=1.0
    assert.strictEqual(metricPromotionEligible(hist), false,
      `cumulative 0.7 < 1.0 default must block promotion; got ${metricPromotionEligible(hist)}`);

    // Add late win so cumulative crosses 1.0 AND trailing streak remains 3.
    const hist2 = [
      { pnlUsd: -0.4 },
      { pnlUsd: 0.3 }, { pnlUsd: 0.4 }, { pnlUsd: 0.5 }, { pnlUsd: 0.6 },
    ];
    // Trailing: 0.6, 0.5, 0.4, 0.3, -0.4 → streak = 4 (loss is at index 0)
    // Cumulative = -0.4 + 0.3 + 0.4 + 0.5 + 0.6 = 1.4 ≥ 1.0
    assert.strictEqual(metricPromotionEligible(hist2), true,
      `cumulative 1.4 + 4-trailing-streak must pass; got ${metricPromotionEligible(hist2)}`);
  });

  test('metricPromotionEligible: trailing loss in last position blocks promotion', () => {
    const hist = [
      { pnlUsd: 0.3 }, { pnlUsd: 0.4 }, { pnlUsd: 0.5 },
      { pnlUsd: -0.1 }, // trailing loss
    ];
    // Trailing streak = 0. Cumulative = 0.3+0.4+0.5-0.1=1.1 ≥ 1.0.
    // But streak < 3 → must return false.
    assert.strictEqual(metricPromotionEligible(hist), false,
      `trailing-loss-in-last-entry must block promotion regardless of cumulative; got ${metricPromotionEligible(hist)}`);
  });

  test('metricPromotionEligible: custom thresholds (minCumulativeUsd, minWinStreak) are honoured', () => {
    const hist = [{ pnlUsd: 0.05 }, { pnlUsd: 0.05 }, { pnlUsd: 0.05 }];
    // Default thresholds (1.0 / 3) — cumulative 0.15 < 1.0 → false.
    assert.strictEqual(metricPromotionEligible(hist), false);
    // Custom thresholds (0.10 / 2) — cumulative 0.15 ≥ 0.10 AND streak ≥ 2 → true.
    assert.strictEqual(metricPromotionEligible(hist, 0.10, 2), true);
    // Custom thresholds (0.20 / 3) — cumulative 0.15 < 0.20 → false.
    assert.strictEqual(metricPromotionEligible(hist, 0.20, 3), false);
  });
});
