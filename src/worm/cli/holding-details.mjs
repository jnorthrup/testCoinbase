// Lifted from robinhood-worm.js — Python array scissor.
// Full shared imports cloned. DCE later.

import { minIncrementMap } from '../config/constants.mjs';

export function buildHoldingDetails(holdings) {
  const holdingDetails = {};
  for (const holding of Array.isArray(holdings) ? holdings : []) {
    const code = holding?.asset_code;
    const qty = parseFloat(holding?.total_quantity) || 0;
    const minQtyThreshold = minIncrementMap[code] ? (minIncrementMap[code] / 10) : 1e-10;
    if (!code || qty <= minQtyThreshold) continue;
    if (!holdingDetails[code]) holdingDetails[code] = { rawQuantity: 0 };
    holdingDetails[code].rawQuantity += qty;
  }
  return holdingDetails;
}