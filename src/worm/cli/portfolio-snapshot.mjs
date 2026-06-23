// Lifted from robinhood-worm.js — Python array scissor.
// Full shared imports cloned. DCE later.

import { buildHoldingDetails } from './holding-details.mjs';

export async function loadLivePortfolioSnapshot(api) {
  const cashBalance = await api.getBalance();
  const holdings = await api.getHoldings();
  const holdingDetails = buildHoldingDetails(holdings);
  return { cashBalance, holdings, holdingDetails };
}