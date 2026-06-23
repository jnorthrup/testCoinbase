// test/quant/alpha-modulator-live.test.mjs
// Closes part of rga Gap G1 follow-up: alpha-modulator.mjs is the 113-line
// integration bridge for technical alpha signals (RSI/Bollinger/ROC/Conviction →
// modulated harvest/rebalance/spawn triggers). 5 exports, zero production callers
// (the file even has a "DIRECT INTEGRATION RECIPE" comment telling the engine
// where to wire it). This test exercises the pure-math modulators.
//
// Contract under test (from alpha-modulator.mjs):
//   getAlphaConviction(recentPrices, options?) -> number in [-1, 1] or 0
//   modulateHarvestTrigger(base, conviction)   -> base + bounded delta (±0.015)
//   modulateRebalanceTrigger(base, conviction) -> base + bounded delta (±0.015)
//   modulateSpawnConviction(baseKelly, conviction) -> baseKelly * bounded scale (0.05..0.95)
//   getAlphaModulatedTriggers({...}) -> { conviction, modulatedHarvestTrigger,
//                                            modulatedRebalanceTrigger,
//                                            alphaInterpretation: 'BULLISH'|'BEARISH'|'NEUTRAL' }
// Pure math — no fs, no async. All 6 tests are deterministic.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAlphaConviction,
  modulateHarvestTrigger,
  modulateRebalanceTrigger,
  modulateSpawnConviction,
  getAlphaModulatedTriggers,
} from '../../src/worm/engine/alpha-modulator.mjs';

describe('alpha-modulator: bounded alpha-bridge math', () => {
  test('getAlphaConviction: short or null history yields 0 (graceful degradation)', () => {
    assert.strictEqual(getAlphaConviction(null), 0);
    assert.strictEqual(getAlphaConviction(undefined), 0);
    assert.strictEqual(getAlphaConviction([]), 0);
    const short = Array.from({ length: 19 }, (_, i) => 100 + i);
    assert.strictEqual(getAlphaConviction(short), 0, 'below-20 threshold returns 0');
  });

  test('modulateHarvestTrigger: conviction=0 returns base unchanged', () => {
    // Math.abs(0) < 0.1 short-circuits — early return.
    assert.strictEqual(modulateHarvestTrigger(0.035, 0), 0.035);
    assert.strictEqual(modulateHarvestTrigger(0.035, 0.05), 0.035);  // below 0.1 threshold
    assert.strictEqual(modulateHarvestTrigger(0.035, -0.05), 0.035);
  });

  test('modulateHarvestTrigger: positive conviction modestly raises trigger (±1.5% clamp)', () => {
    // conviction = +1.0 → mod = Math.max(-0.015, Math.min(0.015, 1 * 0.04)) = 0.015 (clamp fires)
    assert.ok(Math.abs(modulateHarvestTrigger(0.035, 1.0) - 0.050) < 1e-9,
      `clamp at +1.0 must cap at +0.015 → 0.050; got ${modulateHarvestTrigger(0.035, 1.0)}`);
    // conviction = 0.5 → mod = clamp(0.5 * 0.04, ±0.015) = 0.020 → clamp → 0.015
    assert.ok(Math.abs(modulateHarvestTrigger(0.035, 0.5) - 0.050) < 1e-9,
      `0.5 conviction → 0.015 clamp → 0.050; got ${modulateHarvestTrigger(0.035, 0.5)}`);
    // conviction = -1.0 → mod = -0.015 (clamp) → base - 0.015
    assert.ok(Math.abs(modulateHarvestTrigger(0.035, -1.0) - 0.020) < 1e-9,
      `-1.0 conviction must clamp at -0.015 → 0.020; got ${modulateHarvestTrigger(0.035, -1.0)}`);
  });

  test('modulateRebalanceTrigger: opposite sign from harvest (oversold lowers, lowers rebalance threshold)', () => {
    // Source: mod = clamp(-conviction * 0.035, ±0.015)
    // conviction = -1.0 → -(-1)*0.035 = 0.035 → clamped to 0.015
    assert.ok(Math.abs(modulateRebalanceTrigger(0.035, -1.0) - 0.050) < 1e-9,
      `-1.0 conviction (oversold) → +0.015 → 0.050; got ${modulateRebalanceTrigger(0.035, -1.0)}`);
    // conviction = +1.0 → -1*0.035 = -0.035 → clamped to -0.015
    assert.ok(Math.abs(modulateRebalanceTrigger(0.035, 1.0) - 0.020) < 1e-9,
      `+1.0 conviction (overbought) → -0.015 → 0.020; got ${modulateRebalanceTrigger(0.035, 1.0)}`);
  });

  test('modulateSpawnConviction: scales baseKelly in [0.05, 0.95] bounded by ±30%', () => {
    // scale = clamp(1 + conviction*0.25, 0.7..1.3)
    // conviction = 0 → scale = 1 → return baseKelly
    assert.strictEqual(modulateSpawnConviction(0.5, 0), 0.5);
    // conviction = -1.0 → scale = 0.75 → baseKelly * 0.75, clamped
    assert.ok(Math.abs(modulateSpawnConviction(0.5, -1.0) - 0.375) < 1e-9,
      `-1.0 → scale 0.75 → 0.375; got ${modulateSpawnConviction(0.5, -1.0)}`);
    // conviction = +1.0 → scale = 1.25 → baseKelly * 1.25 → 0.625
    assert.ok(Math.abs(modulateSpawnConviction(0.5, 1.0) - 0.625) < 1e-9,
      `+1.0 → scale 1.25 → 0.625; got ${modulateSpawnConviction(0.5, 1.0)}`);
    // Floor: conviction = -10 → scale clamps at 0.7 → 0.5*0.7=0.35
    assert.ok(Math.abs(modulateSpawnConviction(0.5, -10) - 0.35) < 1e-9);
    // Ceiling: conviction = +10 → scale clamps at 1.3 → 0.5*1.3=0.65
    assert.ok(Math.abs(modulateSpawnConviction(0.5, 10) - 0.65) < 1e-9);
    // Floor output: baseKelly=0.01, scale=0.7 → 0.007 below 0.05 floor → 0.05
    assert.strictEqual(modulateSpawnConviction(0.01, -10), 0.05,
      `output must be at least 0.05 floor; got ${modulateSpawnConviction(0.01, -10)}`);
    // Ceiling output: baseKelly=1.0, scale=1.5 → 1.5 → clamps to 0.95
    assert.strictEqual(modulateSpawnConviction(1.0, 10), 0.95,
      `output must be at most 0.95 ceiling; got ${modulateSpawnConviction(1.0, 10)}`);
  });

  test('getAlphaModulatedTriggers: aggregates all modulators with interpretation label', () => {
    const out = getAlphaModulatedTriggers({
      flatHarvestTrigger:   0.035,
      flatRebalanceTrigger: 0.035,
      recentPrices: null, // → conviction = 0 → minimal modulation
    });
    assert.strictEqual(out.conviction, 0, 'no recentPrices → conviction=0');
    assert.strictEqual(out.modulatedHarvestTrigger, 0.035);
    assert.strictEqual(out.modulatedRebalanceTrigger, 0.035);
    assert.strictEqual(out.alphaInterpretation, 'NEUTRAL',
      `interpretation for |c|<=0.25 must be NEUTRAL; got ${out.alphaInterpretation}`);

    // Interpretation boundaries:
    const highOut = getAlphaModulatedTriggers({
      flatHarvestTrigger: 0.035, flatRebalanceTrigger: 0.035,
      recentPrices: Array.from({length: 60}, (_, i) => 100 + i),
    });
    // conviction is whatever calculateAlphaConviction returns on a steady uptrend.
    // We do not pin the numeric value but assert the interpretation matches the sign
    // of the returned conviction (a structural invariant under the current contract).
    if (highOut.conviction > 0.25) {
      assert.strictEqual(highOut.alphaInterpretation, 'BULLISH');
    } else if (highOut.conviction < -0.25) {
      assert.strictEqual(highOut.alphaInterpretation, 'BEARISH');
    } else {
      assert.strictEqual(highOut.alphaInterpretation, 'NEUTRAL');
    }
  });
});
