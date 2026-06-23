// test/quant/wallet-facade.test.mjs
// Verifies --paper behavior is a wallet facade, not a second bot. Coinbase
// market-data reads remain live-shaped; order/portfolio state is simulated only
// when the facade is explicitly selected. Live trade exceptions do not switch mode.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createWalletFacade, isTradePermissionError } from '../../src/worm/api/wallet-facade.mjs';
import { TradingEngine } from '../../src/worm/engine/trading-engine.mjs';

function permissionError(message = 'API key has insufficient permissions to trade') {
  const err = new Error(message);
  err.response = { status: 403, data: { message } };
  return err;
}

function makeBaseApi({ rejectTrades = false, hardFailure = false, initialHoldings = [] } = {}) {
  let placeBuyCalls = 0;
  let placeSellCalls = 0;
  return {
    get counters() { return { placeBuyCalls, placeSellCalls }; },
    _ws: null,
    startWS: async () => {},
    getWsPriceMap: () => ({}),
    getCandles: () => [],
    getQuotes: async (symbols) => Object.fromEntries(symbols.map(s => [s, s === 'SOL' ? 75 : 100])),
    getProductBook: async () => ({ bids: [], asks: [] }),
    getGainersLosers: async () => ({ gainers: [], losers: [], all: [] }),
    getShortTermMovers: async () => [],
    getOutlierCandidates: async () => [{ symbol: 'SOL', score: 10, source: 'test' }],
    getBalance: async () => 1000,
    getHoldings: async () => initialHoldings,
    placeBuy: async () => {
      placeBuyCalls++;
      if (hardFailure) throw new Error('network down');
      if (rejectTrades) throw permissionError();
      return { id: 'live-order' };
    },
    placeSell: async () => {
      placeSellCalls++;
      if (rejectTrades) throw permissionError();
      return { id: 'live-sell-order' };
    },
    getOrderStatus: async (id) => ({
      id,
      state: 'filled',
      average_filled_price: '100',
      filled_asset_quantity: '1',
    }),
  };
}

describe('wallet facade explicit simulation surface', () => {
  test('detects trade permission/read-only errors', () => {
    assert.equal(isTradePermissionError(permissionError('view-only key lacks trade scope')), true);
    assert.equal(isTradePermissionError(Object.assign(new Error('[READ_ONLY] Refusing BUY order'), { status: 0 })), true);
    assert.equal(isTradePermissionError(Object.assign(new Error('ECONNRESET'), { response: { status: 500 } })), false);
  });

  test('force-simulated facade does not call live placeBuy and updates simulated portfolio', async () => {
    const base = makeBaseApi({ initialHoldings: [{ asset_code: 'BTC', total_quantity: '0.01' }] });
    const facade = createWalletFacade(base, { forceSimulated: true, startCapital: 500, buyFeeRate: 0.01 });

    const order = await facade.placeBuy('SOL-USD', '2');
    const status = await facade.getOrderStatus(order.id);

    assert.equal(base.counters.placeBuyCalls, 0, 'paper facade must not call live order method');
    assert.equal(status.state, 'filled');
    assert.equal(status.simulated, true);
    // With both cash (1000) AND holdings (BTC), facade seeds from Coinbase: 1000 - 2*75*1.01 = 848.5
    assert.equal(await facade.getBalance(), 1000 - (2 * 75 * 1.01), 'facade seeds from visible Coinbase state before using fallback capital');
    // Holdings include both seeded BTC and simulated SOL buy
    const holdings = await facade.getHoldings();
    assert.ok(holdings.find(h => h.asset_code === 'BTC' && h.total_quantity === '0.01'), 'seeded BTC retained');
    assert.ok(holdings.find(h => h.asset_code === 'SOL' && h.total_quantity === '2'), 'simulated SOL buy added');
  });

  test('Coinbase trade rejection is observable but does not activate simulated wallet', async () => {
    const base = makeBaseApi({ rejectTrades: true });
    const facade = createWalletFacade(base, { forceSimulated: false, startCapital: 1000, buyFeeRate: 0.01 });

    await assert.rejects(() => facade.placeBuy('SOL-USD', '1'), /insufficient permissions/);

    assert.equal(base.counters.placeBuyCalls, 1, 'first attempt must hit the live-shaped Coinbase call');
    assert.equal(facade.isSimulatedWallet(), false, 'permission rejection must not activate simulated wallet');
    assert.equal(facade.tradeRejections.length, 1, 'rejection is observable');
    assert.equal(await facade.getBalance(), 1000, 'live balance passthrough remains live-shaped after rejection');
  });

  test('non-permission live failures still fail fast', async () => {
    const facade = createWalletFacade(makeBaseApi({ hardFailure: true }), { forceSimulated: false });
    await assert.rejects(() => facade.placeBuy('SOL-USD', '1'), /network down/);
    assert.equal(facade.isSimulatedWallet(), false);
  });

  test('TradingEngine live executor observes read-only Coinbase rejection without simulated fill', async () => {
    const engine = new TradingEngine({}, 'live', 1000, {});
    engine._cycleCounters = { buys: 0, sells: 0, maxBuys: 2, maxSells: 2 };
    const facade = createWalletFacade(makeBaseApi({ rejectTrades: true }), { forceSimulated: false, startCapital: 1000, buyFeeRate: 0.01 });

    const result = await engine._placeBuy(facade, 'SOL-USD', '1', 75);

    assert.equal(result, null);
    assert.equal(facade.isSimulatedWallet(), false);
    assert.equal(facade.tradeRejections.length, 1);
    assert.equal(engine._cycleCounters.buys, 0);
    assert.equal(engine._audit.fills.length, 0);
  });
});
