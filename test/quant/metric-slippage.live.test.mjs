// test/quant/metric-slippage.live.test.mjs
// Closes part of rga Gap G2: metricSlippage is the unified slippage resolver
// at src/worm/estimation/metrics.mjs that prefers book-derived slippage over
// fill-history-derived slippage. Pure dual-fallback contract: book wins when
// present, history fills the gap otherwise.
//
// Contract under test:
//   metricSlippage({ book, fillHistory, side, orderSizeUsd }) -> number|null
//   - If book + side + orderSizeUsd yields a finite number, return it.
//   - Otherwise fall through to fillHistory (median + Tukey fence).
//   - If both unavailable, return null.
//
// Existing tests cover metricSlippageFromBook and metricSlippageFromHistory
// independently. This file locks down the *combination* contract — the
// "what happens when book is partial / absent / stale / null" shape that
// production callers (like engine's _bookSlipFromApi) actually invoke.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { metricSlippage } from '../../src/worm/estimation/metrics.mjs';

function fakeBook(bestBid, bestAsk, levels = []) {
  // Mimic Coinbase product_book shape after coinbase-ws normalizes it to
  // { bids: [[price, size], ...], asks: [[price, size], ...] }.
  return {
    best_bid: String(bestBid),
    best_ask: String(bestAsk),
    bids: [[String(bestBid), '1.0'], ...levels.map(([p, s]) => [String(p), String(s)])],
    asks: [[String(bestAsk), '1.0'], ...levels.map(([p, s]) => [String(p), String(s)])],
  };
}

describe('metricSlippage: book-then-history dual fallback', () => {
  test('full book present → uses book path; fillHistory is ignored', () => {
    const book = fakeBook(100, 101);  // 1% spread (large-but-real for illiquid book)
    const hist = [{ slip: 0.0005 }, { slip: 0.0008 }];
    const result = metricSlippage({ book, fillHistory: hist, side: 'buy', orderSizeUsd: 50 });
    // Base slip = half-spread / mid = 0.5/100.5 ≈ 0.00498. Walking impact depends
    // on book depth. The contract is: result must reflect the BOOK path, not history.
    // History median is 0.0005-0.0008 — way smaller. Asserting result >> history_max.
    assert.ok(Number.isFinite(result), 'book path must return finite slip');
    assert.ok(result > 0.001,
      `book-derived slip (>0.1%) must dominate tiny history (<0.1%); got ${result}`);
  });

  test('null/missing book → falls through to history (finite positive values)', () => {
    const hist = [
      { slip: 0.0010 }, { slip: 0.0012 }, { slip: 0.0009 }, { slip: 0.0011 }, { slip: 0.0010 },
    ];
    const a = metricSlippage({ book: null, fillHistory: hist, side: 'buy', orderSizeUsd: 50 });
    const b = metricSlippage({ book: undefined, fillHistory: hist, side: 'buy', orderSizeUsd: 50 });
    const c = metricSlippage({ book: {}, fillHistory: hist, side: 'buy', orderSizeUsd: 50 });
    assert.ok(Number.isFinite(a), `null book must fall through; got ${a}`);
    assert.ok(Number.isFinite(b), `undefined book must fall through; got ${b}`);
    assert.ok(Number.isFinite(c), `empty book object must fall through; got ${c}`);
    // All three must agree — they all hit the history path.
    assert.ok(Math.abs(a - b) < 1e-12);
    assert.ok(Math.abs(b - c) < 1e-12);
    // Median of 5 slips in [0.0009, 0.0012] is 0.0010 → close to that.
    assert.ok(a > 0.0008 && a < 0.0013,
      `history median must be ~0.0010; got ${a}`);
  });

  test('book present but with no bids or asks → fall through to history', () => {
    // Broad-shallow book: missing key arrays so metricSlippageFromBook returns null.
    const hist = [{ slip: 0.0015 }, { slip: 0.0017 }, { slip: 0.0016 }];
    const result = metricSlippage({ book: { bids: [], asks: [] }, fillHistory: hist, side: 'sell', orderSizeUsd: 75 });
    assert.ok(Number.isFinite(result), 'empty bids+asks must trigger history fallback');
  });

  test('both book and history unavailable → return null (NOT undefined, NOT 0)', () => {
    const a = metricSlippage({ book: null, fillHistory: null, side: 'buy', orderSizeUsd: 50 });
    const b = metricSlippage({ book: null, fillHistory: [], side: 'buy', orderSizeUsd: 50 });
    const c = metricSlippage({ book: {}, fillHistory: [], side: 'buy', orderSizeUsd: 50 });
    assert.strictEqual(a, null, `both null must return null; got ${a}`);
    assert.strictEqual(b, null, `null book + empty history must return null; got ${b}`);
    assert.strictEqual(c, null, `empty book + empty history must return null; got ${c}`);
    // Critical: callers must distinguish "no signal" (null) from "zero slippage" (0)
    // — null propagates to the engine's Math.min(floor, defaultSlip) path.
  });

  test('book wins even when fillHistory has tighter slippage (no averaging)', () => {
    // The whole point of the dual fallback is that the BOOK reflects current
    // reality while HISTORY is stale. A wide-spread book (4% gap) must NOT be
    // averaged with a tight history median (10 bp). Book wins verbatim.
    const book = fakeBook(100, 104); // 4% raw spread
    const hist = [{ slip: 0.0001 }, { slip: 0.0002 }, { slip: 0.0001 }];
    const result = metricSlippage({ book, fillHistory: hist, side: 'buy', orderSizeUsd: 50 });
    // Base slip from book ~ (4 / 2) / 102 = 0.0196 → ~2%. Way higher than history.
    assert.ok(result > 0.01,
      `book-derived slippage must dominate history; expected >1%, got ${result}`);
  });
});
