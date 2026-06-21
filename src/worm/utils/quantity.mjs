// src/worm/utils/quantity.mjs
// Quantity rounding and validation

import { minIncrementMap, getFallbackMinQty } from '../config/constants.mjs';

let _minOrderQtyMap = {};

export function setMinOrderQtyMap(map) {
  _minOrderQtyMap = map;
}

export function getMinOrderQtyMap() {
  return _minOrderQtyMap;
}

export function roundQty(symbol, qty) {
  const increment = minIncrementMap[symbol] || 1e-8;
  return Math.ceil(qty / increment) * increment;
}

export function checkMinQuantity(symbol, qty) {
  const minQty = _minOrderQtyMap[symbol];
  if (minQty) {
    if (parseFloat(qty) < minQty) return false;
  }
  return true;
}

export function getMinimumOrderValue() {
  return 0.50;
}

export function calculateFallbackMinQty(symbol, price) {
  return getFallbackMinQty(symbol, price);
}