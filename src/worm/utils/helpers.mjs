// src/worm/utils/helpers.mjs
// Shared helper functions including trade response parsers

import { minIncrementMap } from '../config/constants.mjs';
import { getMinOrderQtyMap } from './quantity.mjs';

// Re-export trade response functions for convenience
export { getEffectivePriceFromResp, getFilledQuantityFromResp, getTotalFeesFromResp, getGrossValueFromResp, getSettledValueFromResp } from './trade-response.mjs';

const SLIPPAGE_BUFFERS_DEFAULT = { buy: 0.0097, sell: 0.0100 };
const SLIPPAGE_BUFFERS_SPECIFIC = {
  ZEC: { buy: 0.0108, sell: 0.0157 },
  XCN: { buy: 0.0113, sell: 0.0112 },
  VIRTUAL: { buy: 0.0113, sell: 0.0109 },
  XLM: { buy: 0.0099, sell: 0.0119 },
  RE: { buy: 0.0113, sell: 0.0113 },
  LIT: { buy: 0.0100, sell: 0.0105 },
  DOGE: { buy: 0.0104, sell: 0.0111 },
  ADA: { buy: 0.0101, sell: 0.0110 },
};

export function getSlippage(symbol, side = 'buy') {
  const config = SLIPPAGE_BUFFERS_SPECIFIC[symbol] || SLIPPAGE_BUFFERS_DEFAULT;
  return config[side] || SLIPPAGE_BUFFERS_DEFAULT[side];
}

export function getGenomicParam(genome, key, asset) {
  if (genome.overrides && genome.overrides[asset] && genome.overrides[asset][key] !== undefined) {
    return genome.overrides[asset][key];
  }
  return genome[key];
}

export function parseOptionalNumber(value) {
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : null;
}

export function roundQty(sym, qty) {
  const step = minIncrementMap[sym] || 0.00000001;
  if (typeof qty !== 'number' || isNaN(qty) || qty < (step / 10)) return "0.0";

  const rounded = Math.floor(qty / step) * step;
  let decimalPlaces = 0;
  if (step < 1) {
    decimalPlaces = Math.round(-Math.log10(step));
  }

  let str = rounded.toFixed(Math.min(18, Math.max(0, decimalPlaces)));
  str = str.replace(/(\.\d*[1-9])0+$/, "$1");
  str = str.replace(/\.0+$/, "");
  return Number(str) < (step / 10) ? "0.0" : str;
}

export function checkMinQuantity(symbol, qty) {
  const map = getMinOrderQtyMap();
  const minQty = map[symbol];
  if (minQty) {
    if (parseFloat(qty) < minQty) return false;
  }
  return true;
}

export function getGenomicParamWithSymbol(genome, key, symbol) {
  // Compatibility wrapper for legacy getGenomicParam(genome, key, symbol)
  return getGenomicParam(genome, key, symbol);
}

export function roundToIncrement(value, increment) {
  if (!increment || increment <= 0) return value;
  return Math.ceil(value / increment) * increment;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}