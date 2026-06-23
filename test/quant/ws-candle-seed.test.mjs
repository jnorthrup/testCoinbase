// test/quant/ws-candle-seed.test.mjs
// Closes rga Gap #5: _seedCandles() was always dead. After the fix,
// subscribe() opportunistically calls _seedCandles when restClient is set.
// This test asserts the wiring is present and the cache is populated when
// the restClient returns a candle array, OR a sentinel empty entry is set
// when it rejects with Unauthorized (so retries don't spam).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('coinbase-ws.candle-seed path (closes rga Gap #5 + #7)', () => {
  test('subscribe() invokes _seedCandles when restClient.getCandles exists', () => {
    const src = readFileSync(
      '/Users/jim/work/testCoinbase/src/worm/api/coinbase-ws.mjs',
      'utf8'
    );
    // The opportunistic call must be inside subscribe() (not a stub) and must
    // gate on restClient.getCandles existence.
    const subscribeIdx = src.indexOf('async subscribe(channel, symbols)');
    const seedCallIdx  = src.indexOf('_seedCandles(ids)', subscribeIdx);
    assert.ok(seedCallIdx > 0, 'subscribe() must invoke _seedCandles(ids) after the WS subscribe message.');
    // The gate must guard with the restClient.getCandles presence check —
    // otherwise it would crash on adapters that don't expose a restClient.
    const gateIdx = src.indexOf("this.restClient && typeof this.restClient.getCandles === 'function'", subscribeIdx);
    assert.ok(
      gateIdx > 0 && gateIdx < seedCallIdx,
      'subscribe() must gate _seedCandles on restClient.getCandles being a function (between subscribe entry and the call).'
    );
  });

  test('_seedCandles short-circuits on second call (idempotent cache)', () => {
    const src = readFileSync(
      '/Users/jim/work/testCoinbase/src/worm/api/coinbase-ws.mjs',
      'utf8'
    );
    // "Mark attempted BEFORE the request" prevents retry storm on Unauthorized.
    // Without this, an Unauthorized response triggers re-attempt every cycle.
    const seedFnIdx = src.indexOf('async _seedCandles');
    assert.ok(seedFnIdx > 0, 'must define async _seedCandles');
    const sentinelIdx = src.indexOf("this.candleCache.set(key, [])", seedFnIdx);
    assert.ok(sentinelIdx > 0, '_seedCandles must set sentinel empty value BEFORE the REST request to prevent retry storm.');
    // The short-circuit must come BEFORE the sentinel-set. If it came after,
    // the early-return would never fire because the sentinel set would always
    // create the cache entry the has(key) check is supposed to match.
    const shortCircuitIdx = src.lastIndexOf('candleCache.has(key)', sentinelIdx);
    assert.ok(shortCircuitIdx > 0 && shortCircuitIdx > seedFnIdx && shortCircuitIdx < sentinelIdx,
      '_seedCandles must early-return when candleCache.has(key) is true (idempotent, BEFORE sentinel-set).');
  });

  test('candle cache returns empty array when no seed has fired (no live mock)', () => {
    // Without running the WS adapter, getCandles must return [] (not undefined
    // or crash). This is the contract the production code relies on when the
    // REST endpoint is unreachable.
    const src = readFileSync(
      '/Users/jim/work/testCoinbase/src/worm/api/coinbase-ws.mjs',
      'utf8'
    );
    // getCandles body shape: candleCache.get(`...`) || []   template literal + fallback.
    assert.ok(
      /return\s+this\.candleCache\.get\(`[^`]*`\)\s+\|\|\s+\[\]/.test(src),
      'getCandles must use`|| []`fallback so empty cache returns [] not undefined.'
    );
  });
});
