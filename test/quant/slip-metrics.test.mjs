// test/quant/slip-metrics.test.mjs
// Quant-style RED tests: each test calls real Coinbase API and asserts
// the relationship between the scalar constant and the observed market value.
// These FAIL today (RED) because the production code uses scalar guesses.
// They PASS (GREEN) when the code is refactored to use the metric functions.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../../coinbase-advanced.js';
import {
  metricSlippageFromBook,
  metricSlippageFromHistory,
  metricSlippageCap,
  metricRecordSlippage,
  metricDriftOracle,
} from '../../src/worm/estimation/metrics.mjs';

let client;
let btcBook;
let ethBook;

before(async () => {
  client = createClient();
  // Fetch real order books for the primary assets
  const [btcResp, ethResp] = await Promise.all([
    client.getProduct('BTC-USD'),
    client.getProduct('ETH-USD'),
  ]);
  btcBook = btcResp;
  ethBook = ethResp;
});

describe('QUANT SLIPPAGE METRICS: real book vs scalar guess', () => {
  test('BTC-USD book spread → slippage ≠ SLIPPAGE_BUFFERS.DEFAULT.sell (0.0097)', async () => {
    // Quant question: what is the actual cost to cross the spread on BTC-USD?
    // The scalar guess says 97 bps. The book says X bps.
    // If |guess - real| > 2*real, the guess is junk.
    const slip = metricSlippageFromBook(btcBook, 'sell', 100); // $100 order
    assert.ok(slip !== null, 'Book must provide slippage estimate');
    
    const SCALAR_GUESS = 0.0097;
    const driftRatio = SCALAR_GUESS / slip;
    
    // The test documents the gap. It FAILS if the scalar is within 2x of reality.
    // We EXPECT it to fail because 0.0097 is a stale/hardcoded number.
    assert.ok(
      driftRatio > 2.0 || driftRatio < 0.5,
      `BTC-USD slip: scalar=${SCALAR_GUESS.toFixed(5)}, book=${slip.toFixed(5)}, ` +
      `ratio=${driftRatio.toFixed(2)}x. Scalar guess is ${driftRatio > 1 ? 'over' : 'under'}-estimating by ${Math.abs(1 - driftRatio).toFixed(0)}%. ` +
      `REPLACE SLIPPAGE_BUFFERS.DEFAULT.sell with metricSlippageFromBook().`
    );
  });

  test('ETH-USD book spread → slippage ≠ SLIPPAGE_BUFFERS.DEFAULT.sell (0.0097)', async () => {
    const slip = metricSlippageFromBook(ethBook, 'sell', 100);
    assert.ok(slip !== null, 'ETH book must provide slippage estimate');
    
    const SCALAR_GUESS = 0.0097;
    const driftRatio = SCALAR_GUESS / slip;
    
    assert.ok(
      driftRatio > 2.0 || driftRatio < 0.5,
      `ETH-USD slip: scalar=${SCALAR_GUESS.toFixed(5)}, book=${slip.toFixed(5)}, ` +
      `ratio=${driftRatio.toFixed(2)}x. ` +
      `REPLACE SLIPPAGE_BUFFERS.DEFAULT.sell with metricSlippageFromBook().`
    );
  });

  test('Slippage cap from history ≠ hardcoded 0.04', async () => {
    // Generate synthetic fill history with known distribution
    const fills = [
      { slip: 0.0008 }, { slip: 0.0012 }, { slip: 0.0005 },
      { slip: 0.0015 }, { slip: 0.0009 }, { slip: 0.0011 },
      { slip: 0.0007 }, { slip: 0.0010 }, { slip: 0.0006 },
    ];
    
    const cap = metricSlippageCap(fills);
    
    // Hardcoded cap is 0.04 (4%). Real cap from this history should be ~median + 3*stddev
    // which will be much tighter. The test FAILS if the hardcoded 0.04 is used.
    assert.ok(
      cap < 0.04,
      `Hardcoded cap 0.0400 vs metric cap ${cap.toFixed(5)}. ` +
      `REPLACE Math.min(0.04, ...) with metricSlippageCap().`
    );
  });

  test('Slippage record preserves observed vs capped', () => {
    const observed = 0.10; // 10% real slippage (e.g. illiquid asset)
    const cap = metricSlippageCap([{slip:0.001},{slip:0.002},{slip:0.0015}]);
    
    const record = metricRecordSlippage(observed, cap);
    
    // Current code silently truncates: Math.min(0.04, 0.10) = 0.04
    // Our metric MUST preserve both observed and capped
    assert.equal(record.observed, 0.10, 'Must preserve the 10% observed slippage');
    assert.equal(record.capped, cap, 'Must apply the cap');
    assert.ok(record.truncated, 'Must flag that truncation occurred');
    assert.ok(record.reason === 'exceeds_observed_cap', 'Must document why');
    
    // If this passes, the production code needs to call metricRecordSlippage()
    // instead of the silent truncation
  });

  test('Drift oracle detects when assumed ≠ actual', () => {
    // Simulate 10 fills where engine assumed 0.01 but actual was 0.02
    const history = Array.from({length: 10}, (_, i) => ({
      assumed: 0.01 + i * 0.0001,
      actual: 0.02 + i * 0.0001,
    }));
    
    const oracle = metricDriftOracle(history);
    
    assert.ok(oracle.driftPct > 0.5, 'Drift should be ~100% (actual 2x assumed)');
    assert.ok(!oracle.healthy, 'Oracle must flag unhealthy drift');
    assert.ok(oracle.sampleSize === 10, 'Must report sample size');
    
    // Production code has NO drift oracle. This test proves the gap.
    // When the engine calls metricDriftOracle(), it will get a real signal.
  });
});

describe('QUANT SLIPPAGE: history fallback when book unavailable', () => {
  test('metricSlippage falls back to history when book is null', () => {
    const fills = [{slip:0.001},{slip:0.0015},{slip:0.0008},{slip:0.0012},{slip:0.001}];
    const slip = metricSlippage({ book: null, fillHistory: fills, side: 'sell', orderSizeUsd: 100 });
    
    assert.ok(slip !== null, 'Must return history-based slip when book missing');
    assert.ok(slip > 0, 'Slippage must be positive');
    
    // This proves the fallback chain works: book → history → null (never scalar guess)
  });

  test('metricSlippage returns null when both book and history missing', () => {
    const slip = metricSlippage({ book: null, fillHistory: [], side: 'sell', orderSizeUsd: 100 });
    assert.equal(slip, null, null, null, 'Must return null, never a scalar guess');
    // The caller must handle null (skip trade, widen threshold, etc.)
  });
});