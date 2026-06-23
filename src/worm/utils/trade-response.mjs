// src/worm/utils/trade-response.mjs
// Trade response parsing utilities

import { parseOptionalNumber } from './helpers.mjs';

export function getEffectivePriceFromResp(resp, fallbackPrice) {
  // Prefer verified fill price from REST — do NOT silently fall back to expected price.
  // Caller must decide what to do when fill price is absent (log warning, skip Kalman obs, etc.)
  const priceStr = resp?.average_filled_price || resp?.average_price || resp?.executions?.[0]?.effective_price || resp?.price;
  if (priceStr === undefined || priceStr === null) return null;
  const priceNum = parseFloat(priceStr);
  return !isNaN(priceNum) && priceNum > 0 ? priceNum : null;
}

export function getFilledQuantityFromResp(resp, fallbackQuantity = null) {
  const filledQty = parseOptionalNumber(resp?.filled_asset_quantity ?? resp?.filled_quantity);
  if (filledQty !== null && filledQty > 0) return filledQty;
  const fallbackQty = parseOptionalNumber(fallbackQuantity);
  return fallbackQty !== null && fallbackQty > 0 ? fallbackQty : 0;
}

export function getTotalFeesFromResp(resp) {
  const fees = parseOptionalNumber(resp?.total_fees ?? resp?.fees ?? resp?.raw?.order?.total_fees ?? resp?.raw?.total_fees);
  return fees !== null && fees >= 0 ? fees : 0;
}

export function getGrossValueFromResp(resp, fallbackQuantity = null, fallbackPrice = null) {
  const filledValue = parseOptionalNumber(resp?.filled_value ?? resp?.quote_value ?? resp?.raw?.order?.filled_value ?? resp?.raw?.filled_value);
  if (filledValue !== null && filledValue >= 0) return filledValue;
  const qty = getFilledQuantityFromResp(resp, fallbackQuantity);
  const price = getEffectivePriceFromResp(resp, fallbackPrice);
  return qty > 0 && price !== null && price > 0 ? qty * price : 0;
}

export function getSettledValueFromResp(resp, fallbackQuantity = null, fallbackPrice = null) {
  const netValue = parseOptionalNumber(resp?.total_value_after_fees ?? resp?.net_value ?? resp?.raw?.order?.total_value_after_fees ?? resp?.raw?.total_value_after_fees);
  if (netValue !== null && netValue >= 0) return netValue;
  const grossValue = getGrossValueFromResp(resp, fallbackQuantity, fallbackPrice);
  const fees = getTotalFeesFromResp(resp);
  return grossValue > 0 ? Math.max(0, grossValue - fees) : 0;
}