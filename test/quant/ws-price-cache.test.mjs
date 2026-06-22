// test/quant/ws-price-cache.test.mjs
// Unit tests for CoinbaseWS priceCache and getPriceMap.
// No network calls — inject ticks directly into _handleMessage.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import CoinbaseWS from '../../src/worm/api/coinbase-ws.mjs';

function makeWS() {
  // Construct without connecting
  const ws = new CoinbaseWS({ keyName: '', keySecret: '' });
  ws.isConnected = false;
  return ws;
}

function tick(ws, productId, price, bid, ask) {
  ws._handleMessage({
    channel: 'ticker_batch',
    events: [{ tickers: [{ product_id: productId, price: String(price), best_bid: String(bid), best_ask: String(ask) }] }],
  });
}

describe('CoinbaseWS.priceCache: ticker_batch ingestion', () => {
  test('populates priceCache from ticker_batch event', () => {
    const ws = makeWS();
    tick(ws, 'SOL-USD', 150.5, 150.4, 150.6);
    assert.ok(ws.priceCache['SOL'], 'SOL should be in priceCache');
    assert.equal(ws.priceCache['SOL'].price, 150.5);
    assert.equal(ws.priceCache['SOL'].bid,   150.4);
    assert.equal(ws.priceCache['SOL'].ask,   150.6);
  });

  test('updates existing entry on subsequent tick', () => {
    const ws = makeWS();
    tick(ws, 'BTC-USD', 60000, 59990, 60010);
    tick(ws, 'BTC-USD', 61000, 60990, 61010);
    assert.equal(ws.priceCache['BTC'].price, 61000);
  });

  test('handles multiple tickers in one event', () => {
    const ws = makeWS();
    ws._handleMessage({
      channel: 'ticker_batch',
      events: [{
        tickers: [
          { product_id: 'SOL-USD', price: '150', best_bid: '149.9', best_ask: '150.1' },
          { product_id: 'XRP-USD', price: '0.5',  best_bid: '0.499', best_ask: '0.501' },
        ],
      }],
    });
    assert.ok(ws.priceCache['SOL']);
    assert.ok(ws.priceCache['XRP']);
    assert.equal(ws.priceCache['XRP'].price, 0.5);
  });

  test('stores timestamp', () => {
    const ws = makeWS();
    const before = Date.now();
    tick(ws, 'ETH-USD', 3000, 2999, 3001);
    const after = Date.now();
    assert.ok(ws.priceCache['ETH'].ts >= before);
    assert.ok(ws.priceCache['ETH'].ts <= after);
  });
});

describe('CoinbaseWS.getPrice: stale detection', () => {
  test('returns entry when fresh', () => {
    const ws = makeWS();
    tick(ws, 'SOL-USD', 150, 149, 151);
    const entry = ws.getPrice('SOL');
    assert.ok(entry !== null);
    assert.equal(entry.price, 150);
  });

  test('returns null when stale (> 60s)', () => {
    const ws = makeWS();
    tick(ws, 'SOL-USD', 150, 149, 151);
    // Force stale
    ws.priceCache['SOL'].ts = Date.now() - 61_000;
    assert.equal(ws.getPrice('SOL'), null);
  });

  test('returns null for unknown symbol', () => {
    const ws = makeWS();
    assert.equal(ws.getPrice('UNKNOWN'), null);
  });

  test('accepts sym without -USD suffix', () => {
    const ws = makeWS();
    tick(ws, 'HYPE-USD', 25, 24.9, 25.1);
    const entry = ws.getPrice('HYPE'); // no -USD
    assert.ok(entry !== null);
    assert.equal(entry.price, 25);
  });
});

describe('CoinbaseWS.getPriceMap: batch price lookup', () => {
  test('returns map of fresh prices only', () => {
    const ws = makeWS();
    tick(ws, 'SOL-USD', 150, 149, 151);
    tick(ws, 'XRP-USD', 0.5, 0.49, 0.51);
    ws.priceCache['XRP'].ts = Date.now() - 61_000; // stale

    const map = ws.getPriceMap(['SOL', 'XRP', 'UNKNOWN']);
    assert.ok(map['SOL'], 'SOL should be present');
    assert.equal(map['SOL'], 150);
    assert.equal(map['XRP'], undefined, 'XRP stale — should be absent');
    assert.equal(map['UNKNOWN'], undefined);
  });

  test('empty input returns empty map', () => {
    const ws = makeWS();
    assert.deepEqual(ws.getPriceMap([]), {});
  });
});

describe('CoinbaseWS.candleCache: merge and dedup', () => {
  test('WS candle updates deduplicate by start time', () => {
    const ws = makeWS();
    const candle = { product_id: 'SOL-USD', granularity: 300, start: 1000, open: 100, high: 110, low: 90, close: 105, volume: 50 };

    ws._handleMessage({ channel: 'candles', events: [{ candles: [candle] }] });
    ws._handleMessage({ channel: 'candles', events: [{ candles: [{ ...candle, close: 108 }] }] }); // update same candle

    const cached = ws.getCandles('SOL', 300);
    assert.equal(cached.length, 1, 'should not duplicate same start');
    assert.equal(cached[0].close, 108, 'should reflect updated close');
  });

  test('accumulates distinct candles', () => {
    const ws = makeWS();
    for (let i = 0; i < 5; i++) {
      ws._handleMessage({
        channel: 'candles',
        events: [{ candles: [{ product_id: 'ETH-USD', granularity: 300, start: 1000 + i * 300, open: 3000, high: 3100, low: 2900, close: 3050, volume: 10 }] }],
      });
    }
    assert.equal(ws.getCandles('ETH', 300).length, 5);
  });
});
