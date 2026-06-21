// test/quant/kalman-baseline.test.mjs
// RED tests against the unified Kalman filter for the worm baseline.
// The test that imports `metricKalmanBaseline` will fail today because
// that helper does not exist yet. After the cut is implemented and
// wired into trading-engine.mjs, these go GREEN.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const ENGINE_PATH = path.resolve('src/worm/engine/trading-engine.mjs');
const METRICS_PATH = path.resolve('src/worm/estimation/metrics.mjs');
let engineSrc, metricsSrc;

before(() => {
  engineSrc = fs.readFileSync(ENGINE_PATH, 'utf-8');
  metricsSrc = fs.readFileSync(METRICS_PATH, 'utf-8');
});

describe('KALMAN-DRY: BASELINE FILTER RED', () => {
  test('RED: metricKalmanBaseline does not exist yet', () => {
    const exists = /export function metricKalmanBaseline\b/.test(metricsSrc);
    assert.equal(
      exists,
      true,
      'RED: src/worm/estimation/metrics.mjs must export metricKalmanBaseline(state, observation, q, r). '
        + 'If this fails, the cut was reverted.'
    );
  });
});

describe('KALMAN-DRY: BASELINE FILTER behavior (always runs)', () => {
  let kalman;
  before(async () => {
    const mod = await import(METRICS_PATH);
    kalman = mod.metricKalmanBaseline;
  });

  test('GREEN-side: P, baseline, gain are returned together', () => {
    if (!kalman) {
      assert.fail('metricKalmanBaseline not exported yet — implement the filter, then this test runs.');
      return;
    }
    // Function signature: metricKalmanBaseline(state, observation, q, r)
    const out = kalman(
      { baseline: 100, p: 1.0 },
      110,    // observation
      0.01,   // q (process noise)
      1.0,    // r (measurement noise)
    );
    assert.ok(typeof out.baseline === 'number' && out.baseline > 0, 'baseline returned positive');
    assert.ok(typeof out.p === 'number' && out.p > 0 && out.p < 1.0, 'covariance returned');
    assert.ok(typeof out.gain === 'number' && out.gain > 0 && out.gain <= 1, 'Kalman gain in (0,1]');
    // Kalman: P_pred = 1.01, K = 1.01/(1.01+1) = 0.5025
    assert.ok(Math.abs(out.gain - (1.01 / 2.01)) < 0.01, `K ~ 0.50, got ${out.gain}`);
  });

  test('GREEN-side: regime shift (Q spike) speeds adaptation', () => {
    if (!kalman) {
      assert.fail('metricKalmanBaseline not exported yet.');
      return;
    }
    const lowQ = kalman({ baseline: 100, p: 1 }, 110, 0.001, 1);
    const highQ = kalman({ baseline: 100, p: 1 }, 110, 1.0, 1);
    assert.ok(
      highQ.gain > lowQ.gain,
      `highQ gain ${highQ.gain} should exceed lowQ gain ${lowQ.gain}`
    );
  });

  test('GREEN-side: low R (high-confidence observation) increases gain', () => {
    if (!kalman) {
      assert.fail('metricKalmanBaseline not exported yet.');
      return;
    }
    const trustedObs = kalman({ baseline: 100, p: 1 }, 110, 0.01, 0.1);
    const untrustedObs = kalman({ baseline: 100, p: 1 }, 110, 0.01, 100);
    assert.ok(
      trustedObs.gain > untrustedObs.gain,
      `trusted ${trustedObs.gain} should exceed untrusted ${untrustedObs.gain}`
    );
  });

  test('RED: engine baseline update must call metricKalmanBaseline (the DRY cut)', () => {
    const engineUsesMetric = /metricKalmanBaseline\s*\(/.test(engineSrc);
    assert.ok(
      engineUsesMetric,
      'RED: trading-engine.mjs does not call metricKalmanBaseline. '
        + 'After the cut, engine baseline update should consume this helper.'
    );
  });
});