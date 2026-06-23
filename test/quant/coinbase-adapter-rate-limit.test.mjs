// test/quant/coinbase-adapter-rate-limit.test.mjs
// Guardrails for Coinbase quota discipline: hot price paths must use WS cache,
// not per-symbol REST product calls.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import CoinbaseWS from '../../src/worm/api/coinbase-ws.mjs';
import { CoinbaseWormAPI } from '../../src/worm/api/coinbase-adapter.mjs';
import { TradingEngine } from '../../src/worm/engine/trading-engine.mjs';
import { defaultGenome } from '../../src/worm/config/constants.mjs';
import { getMinOrderQtyMap, setMinOrderQtyMap } from '../../src/worm/utils/quantity.mjs';

function trapRestPriceCalls(api) {
  let restCalls = 0;
  const fail = async () => {
    restCalls++;
    throw new Error('REST price path must not be called');
  };
  api.client.getProduct = fail;
  api.client.getProducts = fail;
  api.client.request = fail;
  return () => restCalls;
}

describe('CoinbaseWormAPI rate-limit guardrails', () => {
  test('getQuotes uses WS price map and does not call REST product endpoints', async () => {
    const api = new CoinbaseWormAPI({ readOnly: true });
    const restCalls = trapRestPriceCalls(api);

    let waitCalls = 0;
    api.waitForWsPriceMap = async (symbols) => {
      waitCalls++;
      return Object.fromEntries(symbols.map(sym => [sym, sym === 'BTC' ? 64000 : 1700]));
    };

    const prices = await api.getQuotes(['BTC', 'ETH']);

    assert.equal(waitCalls, 1);
    assert.equal(restCalls(), 0);
    assert.deepEqual(prices, { BTC: 64000, ETH: 1700 });
  });

  test('missing WS price returns empty quote without REST fallback', async () => {
    const api = new CoinbaseWormAPI({ readOnly: true });
    const restCalls = trapRestPriceCalls(api);
    api.waitForWsPriceMap = async () => ({});

    const prices = await api.getQuotes(['NOPE']);

    assert.equal(restCalls(), 0);
    assert.deepEqual(prices, {});
  });

  test('products and accounts snapshots coalesce concurrent callers', async () => {
    const api = new CoinbaseWormAPI({ readOnly: true });

    // BatchingAPI sits below named methods — it calls client.request() directly.
    // Mock the request backbone, not the named methods.
    let productCalls = 0;
    api.client.request = async ({ requestPath }) => {
      if (requestPath === 'products') {
        productCalls++;
        await new Promise(resolve => setTimeout(resolve, 20));
        return { body: { products: [{ id: 'BTC-USD', status: 'online', price: '64000', price_percentage_change_24h: '1', volume_24h: '100' }] } };
      }
      throw new Error(`Unexpected request: ${requestPath}`);
    };

    await Promise.all([
      api._getProductsCached(),
      api.getGainersLosers(1),
      api._getProductsCached(),
    ]);
    assert.equal(productCalls, 1);

    let accountCalls = 0;
    api.client.request = async ({ requestPath }) => {
      if (requestPath === 'accounts') {
        accountCalls++;
        await new Promise(resolve => setTimeout(resolve, 20));
        return { body: { accounts: [{ currency: 'USD', available_balance: { value: '100' }, hold: { value: '0' } }] } };
      }
      throw new Error(`Unexpected request: ${requestPath}`);
    };

    await Promise.all([api.getBalance(), api.getHoldings()]);
    assert.equal(accountCalls, 1);
  });

  test('WS control sends are queued under the 8 msg/sec control limit', async () => {
    const ws = new CoinbaseWS({ keyName: '', keySecret: '' });
    const sent = [];
    ws.ws = {
      readyState: 1, // WebSocket.OPEN
      send: (payload) => sent.push({ payload, ts: Date.now() }),
    };
    ws.CONTROL_MIN_INTERVAL_MS = 20;
    ws._nextControlSendAt = 0;

    await Promise.all([
      ws._sendControl({ type: 'subscribe', channel: 'ticker_batch', product_ids: ['BTC-USD'] }),
      ws._sendControl({ type: 'subscribe', channel: 'ticker_batch', product_ids: ['ETH-USD'] }),
      ws._sendControl({ type: 'unsubscribe', channel: 'ticker_batch', product_ids: ['BTC-USD'] }),
    ]);

    assert.equal(sent.length, 3);
    assert.ok(sent[1].ts - sent[0].ts >= 15, `second send too early: ${sent[1].ts - sent[0].ts}ms`);
    assert.ok(sent[2].ts - sent[1].ts >= 15, `third send too early: ${sent[2].ts - sent[1].ts}ms`);
  });
});

describe('TradingEngine mitosis price discovery', () => {
  test('spawn path uses bulk WS warmup and avoids getQuotes fallback when warm price exists', async () => {
    const originalMap = { ...getMinOrderQtyMap() };
    try {
      setMinOrderQtyMap({ ALPHA: 0.01 });
      const engine = new TradingEngine(defaultGenome, 'sim', 10000, {});
      let waitCalls = 0;
      let quoteCalls = 0;
      const api = {
        lastSpawnCandidates: undefined,
        getOutlierCandidates: async () => [{ symbol: 'ALPHA', score: 99, source: 'test' }],
        waitForWsPriceMap: async (symbols, timeoutMs, minPrices) => {
          waitCalls++;
          assert.deepEqual(symbols, ['ALPHA']);
          assert.equal(timeoutMs, 6000);
          assert.equal(minPrices, 1);
          return { ALPHA: 5 };
        },
        getQuotes: async () => {
          quoteCalls++;
          throw new Error('getQuotes fallback should not run when WS warmup has price');
        },
      };

      const result = await engine.update([], api, 10000, {}, Date.now(), null);

      assert.equal(waitCalls, 1);
      assert.equal(quoteCalls, 0);
      assert.equal(result.anyTradesThisCycle, true);
      assert.equal(result.tradedSymbols[0], 'ALPHA');
      assert.ok(engine.holdings.ALPHA?.rawQuantity > 0);
    } finally {
      setMinOrderQtyMap(originalMap);
    }
  });
});
