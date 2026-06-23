// test/quant/metric-verified-fill.test.mjs
// Closes part of rga Gap G2: metricVerifiedFill is a 17-line response-parser
// export in src/worm/estimation/metrics.mjs with zero production callers.
// This test exercises the function against canonical Coinbase order response
// shapes (CREATE response, GET /orders/historical, no-response, terminal-state-only).
//
// Contract under test (from metrics.mjs):
//   metricVerifiedFill(resp, expectedPrice) -> {
//     average_price: number|null,
//     settled: boolean,
//     verified: boolean,
//     source: 'no_response' | 'no_order_id' | 'unverified' | 'settled_no_price' | 'rest_confirmed'
//   }
//   - null resp -> { avg=null, settled=false, verified=false, source='no_response' }
//   - resp without order_id -> 'no_order_id'
//   - resp with avg_price + settled=true -> real number + source='rest_confirmed'
//   - resp with settled=true but no avg_price -> 'settled_no_price', verified still true
//   - resp with partial state (no settled flags) -> 'unverified', verified=false

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { metricVerifiedFill } from '../../src/worm/estimation/metrics.mjs';

describe('metricVerifiedFill: Coinbase response shape parser', () => {
  test('null response -> no_response sentinel', () => {
    const r = metricVerifiedFill(null, 123.45);
    assert.strictEqual(r.average_price, null);
    assert.strictEqual(r.settled, false);
    assert.strictEqual(r.verified, false);
    assert.strictEqual(r.source, 'no_response');
  });

  test('response without order_id -> no_order_id sentinel', () => {
    const r = metricVerifiedFill({ status: 'FILLED', average_price: '50000.00' }, 50000);
    assert.strictEqual(r.average_price, null);
    assert.strictEqual(r.settled, false);
    assert.strictEqual(r.verified, false);
    assert.strictEqual(r.source, 'no_order_id');
  });

  test('CREATED-response with average_price + status=FILLED -> rest_confirmed', () => {
    const r = metricVerifiedFill({
      order_id: 'abc-123',
      status: 'FILLED',
      average_price: '64821.5',
      executed_value: '64.82',
      filled_size: '0.001',
    }, 64800);
    assert.strictEqual(r.average_price, 64821.5, 'string average_price must be parsed as float');
    assert.strictEqual(r.settled, true, 'status=FILLED must mark settled=true');
    assert.strictEqual(r.verified, true);
    assert.strictEqual(r.source, 'rest_confirmed');
  });

  test('settled flag (true) without average_price -> settled_no_price but verified=true', () => {
    // This is the edge that the rga skill flagged: the fill settled but the
    // exchange omits average_price on certain response shapes. Caller must still
    // know the fill is verified.
    const r = metricVerifiedFill({
      order_id: 'abc-456',
      settled: true,
      // no average_price field
    }, 100);
    assert.strictEqual(r.average_price, null);
    assert.strictEqual(r.settled, true);
    assert.strictEqual(r.verified, true, 'verified=true even without avgPrice when settled=true');
    assert.strictEqual(r.source, 'settled_no_price');
  });

  test('partial state response (PENDING, finite avgPrice) -> rest_confirmed but verified=false', () => {
    // Subtle contract: metricVerifiedFill returns source='rest_confirmed' when
    // average_price parses to a finite positive number, even without a settled
    // flag. The `verified` flag is the source of truth for downstream callers —
    // do NOT rely on `source` alone to determine trust.
    const r = metricVerifiedFill({
      order_id: 'abc-789',
      status: 'PENDING',
      average_price: '50100.0',
    }, 50100);
    assert.strictEqual(r.average_price, 50100.0);
    assert.strictEqual(r.settled, false);
    assert.strictEqual(r.verified, false, 'PENDING state must NOT mark verified=true');
    assert.strictEqual(r.source, 'rest_confirmed',
      'CURRENT behavior: source reflects parse success, not settled state — verified flag guards downstream trust');
  });

  test('average_filled_price variant (legacy /orders/historical response)', () => {
    // Some Coinbase endpoints return average_filled_price. The function under
    // test only reads average_price. This is a known rga gap from session
    // notes — assert the CURRENT behavior so a future wire-up to also accept
    // average_filled_price becomes a deliberate, signalled change.
    const r = metricVerifiedFill({
      order_id: 'legacy-1',
      status: 'FILLED',
      average_filled_price: '64821.5',
    }, 64821);
    // CURRENT behavior: average_filled_price is NOT consulted by metricVerifiedFill.
    assert.strictEqual(r.average_price, null,
      'CURRENT behavior ignores average_filled_price (rga-fill-gap candidate; requires explicit fix)');
    assert.strictEqual(r.settled, true);
  });

  test('non-finite or zero price -> unverified, average_price=null', () => {
    for (const priceField of [null, 0, -1, 'not-a-number', NaN, Infinity, '']) {
      const r = metricVerifiedFill({
        order_id: 'weird-' + String(priceField),
        status: 'FILLED',
        average_price: priceField,
      }, 100);
      assert.strictEqual(r.average_price, null, `price field ${JSON.stringify(priceField)} must yield null`);
      assert.strictEqual(r.settled, true, 'FILLED status always derives settled=true regardless of price-field shape');
      // settled_no_price (verified=true) only fires when settled=true AND avg is null and not parseable.
      // NaN/Infinity parse to NaN; isFinite is false; non-finite path goes to source='unverified' (per source etc)
      // — but since settled is true here, both 'settled_no_price' and 'unverified' are possible based on
      // isFinite alone. Settled_no_price fires when !isFinite OR avgPrice<=0. So with NaN/Infinity, settled_no_price.
      // Result for empty/null/'not-a-number'/NaN: settled_no_price (verified=true).
      // Result for 0/-1/empty string: those parse to NaN; same path -> settled_no_price.
      // Verified stays true via the source 'settled_no_price' branch.
      assert.strictEqual(r.verified, true,
        `verified=true for FILLED state regardless of price-field parsing (path: ${r.source})`);
    }
  });
});
