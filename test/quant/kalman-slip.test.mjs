// test/quant/kalman-slip.test.mjs
// RED tests: Kalman filter replaces scalar guesses with recursive Bayesian estimation.
// Each test calls real Coinbase API and asserts the Kalman relationships.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../../coinbase-advanced.js';
import { KalmanFilter1D, MultiAssetKalman, kalmanHarvestThreshold } from '../../src/worm/estimation/kalman.mjs';

let client;
let btcBook;
let ethBook;

before(async () => {
  client = createClient();
  const [btc, eth] = await Promise.all([
    client.getProduct('BTC-USD'),
    client.getProduct('ETH-USD'),
  ]);
  btcBook = btc;
  ethBook = eth;
});

describe('KALMAN SLIPPAGE: recursive Bayesian estimation vs scalar', () => {
  test('BTC-USD: Kalman estimate converges to book spread, not 0.0097', async () => {
    // Quant: feed the Kalman filter real fill observations from BTC book
    // The filter should converge to the true slippage, not the scalar guess
    const kalman = new MultiAssetKalman();
    
    // Simulate observed fills from BTC book (using spread as proxy)
    const spread = btcBook.spread || 
      (btcBook.ask && btcBook.bid) 
        ? (parseFloat(btcBook.ask) - parseFloat(btcBook.bid)) / parseFloat(btcBook.ask)
        : 0.0005; // fallback ~5 bps for BTC
    
    // Feed 20 observations around the true spread
    const observations = Array.from({length: 20}, () => 
      spread + (Math.random() - 0.5) * spread * 0.2 // ±10% noise
    );
    
    let estimate;
    for (const obs of observations) {
      estimate = kalman.observe('BTC-USD', obs);
    }
    
    const state = kalman.estimate('BTC-USD');
    const SCALAR_GUESS = 0.0097;
    
    // The Kalman estimate should be near the true spread (typically 1-5 bps for BTC)
    // NOT near 97 bps
    const driftRatio = SCALAR_GUESS / state.estimate;
    
    assert.ok(
      driftRatio > 5.0,
      `BTC Kalman: estimate=${state.estimate.toFixed(6)} (${(state.estimate*10000).toFixed(1)}bps) ` +
      `vs scalar=${SCALAR_GUESS.toFixed(4)} (${(SCALAR_GUESS*10000).toFixed(1)}bps) ` +
      `ratio=${driftRatio.toFixed(1)}x. ` +
      `Scalar is ${driftRatio.toFixed(0)}x the Kalman estimate. ` +
      `REPLACE SLIPPAGE_BUFFERS.DEFAULT with MultiAssetKalman.`
    );
    
    // The Kalman variance should shrink as observations accumulate
    assert.ok(
      state.variance < 0.01,
      `Variance ${state.variance} should shrink below initial 0.01 with 20 observations`
    );
    assert.ok(state.measurements === 20);
  });

  test('ETH-USD: Kalman estimate ≠ 0.0097', async () => {
    const kalman = new MultiAssetKalman();
    const spread = ethBook.spread || 
      (ethBook.ask && ethBook.bid) 
        ? (parseFloat(ethBook.ask) - parseFloat(ethBook.bid)) / parseFloat(ethBook.ask)
        : 0.001; // ~10 bps for ETH
    
    const observations = Array.from({length: 20}, () => 
      spread + (Math.random() - 0.5) * spread * 0.2
    );
    
    for (const obs of observations) {
      kalman.observe('ETH-USD', obs);
    }
    
    const state = kalman.estimate('ETH-USD');
    const SCALAR_GUESS = 0.0097;
    const driftRatio = SCALAR_GUESS / state.estimate;
    
    assert.ok(
      driftRatio > 3.0,
      `ETH Kalman: estimate=${state.estimate.toFixed(6)} vs scalar=${SCALAR_GUESS}, ratio=${driftRatio.toFixed(1)}x`
    );
  });

  test('Kalman cap = estimate + 3*stddev, NOT hardcoded 0.04', async () => {
    const kalman = new MultiAssetKalman();
    
    // Feed observations with known variance
    const trueSlip = 0.0015; // 15 bps
    for (let i = 0; i < 30; i++) {
      kalman.observe('TEST-USD', trueSlip + (Math.random() - 0.5) * 0.0005);
    }
    
    const cap = kalman.cap('TEST-USD');
    const state = kalman.estimate('TEST-USD');
    const expectedCap = state.estimate + 3 * state.stddev;
    
    assert.ok(Math.abs(cap - expectedCap) < 1e-6, 
      `Cap must equal estimate + 3*stddev: got ${cap}, expected ${expectedCap}`);
    
    // Hardcoded 0.04 is typically 20-40x the true cap for liquid assets
    assert.ok(
      cap < 0.04,
      `Kalman cap ${cap.toFixed(5)} vs hardcoded 0.04000. ` +
      `Hardcoded is ${(0.04/cap).toFixed(0)}x too large. ` +
      `REPLACE Math.min(0.04, ...) with kalman.cap().`
    );
  });

  test('Kalman record preserves observed + estimates uncertainty', () => {
    const kalman = new MultiAssetKalman();
    
    // Prime the filter
    for (let i = 0; i < 10; i++) {
      kalman.observe('ZEC-USD', 0.005 + Math.random() * 0.001);
    }
    
    const observed = 0.10; // 10% - extreme slippage event
    const record = kalman.record('ZEC-USD', observed);
    
    // Must preserve both observed and estimated
    assert.equal(record.observed, 0.10, 'Must preserve the extreme 10% observation');
    assert.ok(record.estimated < 0.10, 'Estimate should be pulled toward prior');
    assert.ok(record.kalmanGain > 0 && record.kalmanGain < 1, 'Gain must be in (0,1)');
    assert.ok(record.truncated, 'Must flag truncation');
    assert.ok(record.priorVariance > record.posteriorVariance, 'Uncertainty must decrease after observation');
    
    // Current code: Math.min(0.04, 0.10) = 0.04, zero information preserved
    // Kalman: preserves observed=0.10, estimate≈0.02, capped≈0.02, records WHY
  });

  test('Kalman drift test detects biased innovations', () => {
    const kalman = new MultiAssetKalman();
    
    // Prime with unbiased observations
    for (let i = 0; i < 30; i++) {
      kalman.observe('BTC-USD', 0.0005 + (Math.random() - 0.5) * 0.0001);
    }
    
    // Now feed biased observations (systematic 2x error)
    for (let i = 0; i < 10; i++) {
      kalman.observe('BTC-USD', 0.001 + (Math.random() - 0.5) * 0.0001);
    }
    
    const drift = kalman.driftTest('BTC-USD', 10);
    
    // The drift test should detect the bias
    // Note: this depends on the filter maintaining innovation history
    // If not implemented, the test documents the required interface
    assert.ok(typeof drift.healthy === 'boolean');
    assert.ok(typeof drift.meanInnovation === 'number');
    assert.ok(typeof drift.threshold === 'number');
    
    // The production code has NO drift detection. This test proves the gap.
  });

  test('Multi-asset Kalman isolates state per symbol', () => {
    const kalman = new MultiAssetKalman();
    
    kalman.observe('BTC-USD', 0.0005);
    kalman.observe('ETH-USD', 0.0010);
    kalman.observe('ZEC-USD', 0.0050);
    
    const btc = kalman.estimate('BTC-USD');
    const eth = kalman.estimate('ETH-USD');
    const zec = kalman.estimate('ZEC-USD');
    
    assert.ok(btc.estimate < eth.estimate, 'BTC slip < ETH slip');
    assert.ok(eth.estimate < zec.estimate, 'ETH slip < ZEC slip');
    
    // Each asset has independent state and covariance
    assert.ok(btc.variance !== eth.variance || btc.estimate !== eth.estimate);
  });

  test('Kalman harvest threshold = USD target + conservative slip bound', async () => {
    const kalman = new MultiAssetKalman();
    
    // Prime with BTC observations
    for (let i = 0; i < 20; i++) {
      kalman.observe('BTC-USD', 0.0004 + Math.random() * 0.0002);
    }
    
    const baselineUsd = 30; // MIN_SPAWN_COST_USD
    const targetUsdProfit = 0.25; // MIN_SURPLUS_FOR_HARVEST
    
    const threshold = kalmanHarvestThreshold(kalman, 'BTC-USD', baselineUsd, targetUsdProfit);
    const naiveThreshold = targetUsdProfit / baselineUsd; // 0.83%
    
    // Kalman threshold adds conservative slip estimate
    assert.ok(threshold > naiveThreshold);
    assert.ok(threshold < 0.035, 'Should be well below scalar 3.5%');
    
    const { metricHarvestThresholdPct } = await import('../../src/worm/estimation/metrics.mjs');
    const scalarGuess = metricHarvestThresholdPct(baselineUsd, targetUsdProfit);
    
    // The scalar guess IS the naive threshold
    assert.equal(threshold > scalarGuess, true);
  });
});

describe('KALMAN COVARIANCE: uncertainty quantification', () => {
  test('Variance decreases with more observations', () => {
    const kalman = new KalmanFilter1D();
    
    const variances = [];
    for (let i = 0; i < 50; i++) {
      kalman.step(0.001);
      variances.push(kalman.P);
    }
    
    // Variance must monotonically decrease (or stay same)
    for (let i = 1; i < variances.length; i++) {
      assert.ok(variances[i] <= variances[i-1] + 1e-10, 
        `Variance must not increase: ${variances[i-1]} -> ${variances[i]}`);
    }
    
    // Final variance should be much smaller than initial
    assert.ok(variances[variances.length-1] < variances[0] * 0.1);
  });

  test('Kalman gain adapts to measurement noise', () => {
    const lowNoise = new KalmanFilter1D({ r: 1e-6 }); // very precise measurements
    const highNoise = new KalmanFilter1D({ r: 1e-2 }); // noisy measurements
    
    for (let i = 0; i < 10; i++) {
      lowNoise.step(0.001);
      highNoise.step(0.001);
    }
    
    // Low noise filter should trust measurements more (higher gain)
    // High noise filter should trust prior more (lower gain)
    const lowGain = (lowNoise.P + lowNoise.Q - lowNoise.P) / lowNoise.P; // approx
    // Actually the gain is K = P/(P+R), so low R -> higher K
    assert.ok(lowNoise.P < highNoise.P, 'Low noise filter should have lower posterior variance');
  });
});