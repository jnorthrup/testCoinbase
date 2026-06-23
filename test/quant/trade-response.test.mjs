// test/quant/trade-response.test.mjs
// Verifies that fill-price parsing uses Coinbase's verified-fill field names
// and never silently substitutes the caller's expected/pre-order price.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getEffectivePriceFromResp as getEffectivePriceFromTradeResponse,
  getGrossValueFromResp,
} from '../../src/worm/utils/trade-response.mjs';
import {
  getEffectivePriceFromResp as getEffectivePriceFromTradingHelpers,
} from '../../src/worm/utils/trading-helpers.mjs';

describe('trade response parsing: verified fill price only', () => {
  test('reads Coinbase historical order average_filled_price before fallback candidates', () => {
    const resp = {
      average_filled_price: '123.45',
      average_price: '111.11',
      price: '99.99',
    };

    assert.equal(getEffectivePriceFromTradeResponse(resp, 999), 123.45);
    assert.equal(getEffectivePriceFromTradingHelpers(resp, 999), 123.45);
  });

  test('does not silently use expected price when response has no fill price', () => {
    const resp = { id: 'order-without-fill-price' };

    assert.equal(getEffectivePriceFromTradeResponse(resp, 999), null);
    assert.equal(getEffectivePriceFromTradingHelpers(resp, 999), null);
  });

  test('gross value does not synthesize value from fallback price when fill price is absent', () => {
    const resp = { filled_asset_quantity: '2' };

    assert.equal(getGrossValueFromResp(resp, 2, 999), 0);
  });
});
