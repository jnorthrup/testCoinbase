// test/quant/trigger-vol-scale.test.mjs
// Pin the vol-scaled trigger helper. Single-knob, single-consumer:
// filteredVolatility * TRIGGER_VOL_SENSITIVITY ramps a base trigger by a
// controllable amount. Default sensitivity is 2.8 (matches constants.mjs).
// No scaling on cold-start (no filteredVolatility observation yet).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TradingEngine, volScaledTrigger, observeVolatility } from '../../src/worm/engine/trading-engine.mjs';
import { defaultGenome } from '../../src/worm/config/trading-config.mjs';

function makeEngine() {
  return new TradingEngine(defaultGenome, 'sim', 10_000, {});
}

// Determinism helper: feed rawVol into a fresh Kalman filter via observeVolatility
// a number of times so engine.filteredVolatility[sym] settles close to the target.
function settleVol(engine, sym, target, samples = 30) {
  for (let i = 0; i < samples; i++) observeVolatility(engine, sym, target);
}

describe('volScaledTrigger: single-knob, single-consumer', () => {
  test('returns base unchanged when filteredVolatility is unavailable (cold start)', () => {
    const e = makeEngine();
    // No observation yet; filteredVolatility[sym] is undefined.
    const out = volScaledTrigger(e, 'BTC', 0.035);
    assert.equal(out, 0.035, 'cold-start must return base unchanged');
  });

  test('scales base by (1 + filteredVol * TRIGGER_VOL_SENSITIVITY)', () => {
    const e = makeEngine();
    // Tame the regime classifier so it doesn't fire transitions mid-test:
    // settle a quiet series (vol ~ 0.025) so classifyRegime stays STABLE.
    settleVol(e, 'BTC', 0.025, 30);
    const fv = e.filteredVolatility.BTC;
    assert.ok(Number.isFinite(fv) && fv > 0);
    const base = 0.035;
    const expected = base * (1 + fv * 2.8);
    const out = volScaledTrigger(e, 'BTC', base);
    assert.ok(Math.abs(out - expected) < 1e-12, `expected ${expected}, got ${out}`);
    assert.ok(out > base, `filteredVol > 0 must scale trigger up; got base=${base} out=${out}`);
  });

  test('higher TRIGGER_VOL_SENSITIVITY in genome scales the trigger more aggressively', () => {
    const eLow = makeEngine();
    const eHigh = makeEngine();
    eHigh.genome = { ...defaultGenome, TRIGGER_VOL_SENSITIVITY: 6.0 };
    settleVol(eLow, 'BTC', 0.025, 30);
    settleVol(eHigh, 'BTC', 0.025, 30);
    const base = 0.035;
    const outLow = volScaledTrigger(eLow, 'BTC', base);
    const outHigh = volScaledTrigger(eHigh, 'BTC', base);
    assert.ok(outHigh > outLow,
      `higher TRIGGER_VOL_SENSITIVITY must scale more; got low=${outLow} high=${outHigh}`);
    // Computation identity: out / base = 1 + fv * sensitivity. Capture vol from one engine
    // and verify the math holds for the genome-overridden engine too.
    const symptomLow = outLow / base - 1;
    const symptomHigh = outHigh / base - 1;
    assert.ok(Math.abs((symptomHigh / symptomLow) - (6.0 / 2.8)) < 0.01,
      `scaling ratio should match sensitivity ratio; got low=${symptomLow}, high=${symptomHigh}`);
  });

  test('sweep across TRIGGER_VOL_SENSITIVITY values: 0, 2.8, 6.0 — output grows proportionally', () => {
    const e = makeEngine();
    settleVol(e, 'BTC', 0.025, 30);
    const base = 0.035;
    const fv = e.filteredVolatility.BTC;
    const e0 = makeEngine();
    e0.filteredVolatility.BTC = fv; // share state
    e0.genome = { ...defaultGenome, TRIGGER_VOL_SENSITIVITY: 0 };
    const e28 = makeEngine();
    e28.filteredVolatility.BTC = fv;
    e28.genome = { ...defaultGenome, TRIGGER_VOL_SENSITIVITY: 2.8 };
    const e60 = makeEngine();
    e60.filteredVolatility.BTC = fv;
    e60.genome = { ...defaultGenome, TRIGGER_VOL_SENSITIVITY: 6.0 };

    const r0 = volScaledTrigger(e0, 'BTC', base);
    const r28 = volScaledTrigger(e28, 'BTC', base);
    const r60 = volScaledTrigger(e60, 'BTC', base);
    // Three outputs must be ordered: 0-sensitivity equals base; 2.8 > base; 6.0 > 2.8.
    assert.equal(r0, base, 'sensitivity 0 must equal base');
    assert.ok(r28 > base);
    assert.ok(r60 > r28);
    // Sanity: r60 / r28 ≈ (1 + fv*6)/(1 + fv*2.8).
    const ratio = r60 / r28;
    const expectedRatio = (1 + fv * 6.0) / (1 + fv * 2.8);
    assert.ok(Math.abs(ratio - expectedRatio) < 1e-9);
  });

  test('non-finite base passes through unchanged', () => {
    const e = makeEngine();
    settleVol(e, 'BTC', 0.025, 30);
    assert.equal(volScaledTrigger(e, 'BTC', NaN), NaN);
    assert.equal(volScaledTrigger(e, 'BTC', undefined), undefined);
  });
});
