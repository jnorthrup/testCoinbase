// Lifted from robinhood-worm.js — Python array scissor.
// Full shared imports cloned. DCE later.

import { roundQty } from '../utils/quantity.mjs';
import { buildHoldingDetails } from './holding-details.mjs';
import { writeWormPreviewArtifact } from './artifact-writer.mjs';

export async function runPreviewOrderOnce(engine, api, previewOrder) {
  const cashBalance = await api.getBalance();
  const holdings = await api.getHoldings();
  const holdingDetails = buildHoldingDetails(holdings);
  const quoteMap = await api.getQuotes([previewOrder.symbol]);
  const price = quoteMap[previewOrder.symbol];
  if (!price || !Number.isFinite(price) || price <= 0) {
    throw new Error(`Could not fetch usable price for ${previewOrder.symbol}`);
  }
  const quantity = roundQty(previewOrder.symbol, previewOrder.usdAmount / price);
  if (!quantity || parseFloat(quantity) <= 0) {
    throw new Error(`Preview quantity rounded to zero for ${previewOrder.productId}`);
  }
  if (previewOrder.side === 'SELL') {
    const availableQty = holdingDetails[previewOrder.symbol]?.rawQuantity || 0;
    if (availableQty < parseFloat(quantity)) {
      throw new Error(`Insufficient ${previewOrder.symbol} for preview sell: need ${quantity}, available ${availableQty}`);
    }
  }

  const response = previewOrder.side === 'SELL'
    ? await engine._placeSell(api, previewOrder.productId, quantity, price)
    : await engine._placeBuy(api, previewOrder.productId, quantity, price);

  if (!response) {
    throw new Error(`Worm preview path returned no response for ${previewOrder.side} ${previewOrder.productId}`);
  }

  const artifactPayload = {
    generatedAt: new Date().toISOString(),
    mode: 'worm-preview',
    side: previewOrder.side,
    symbol: previewOrder.symbol,
    productId: previewOrder.productId,
    usdAmount: previewOrder.usdAmount,
    cashBalance,
    availableQuantity: holdingDetails[previewOrder.symbol]?.rawQuantity || 0,
    previewPrice: price,
    previewQuantity: quantity,
    response,
  };
  const artifact = writeWormPreviewArtifact(artifactPayload);

  console.log(`🧪 Worm preview ${previewOrder.side} ${previewOrder.productId}`);
  console.log(`   cash balance: $${cashBalance.toFixed(2)}`);
  console.log(`   preview price: $${price}`);
  console.log(`   preview quantity: ${quantity}`);
  if (response.preview?.order_total || response.preview?.quote_size) {
    console.log(`   preview total/quote: ${response.preview.order_total || 'n/a'} / ${response.preview.quote_size || 'n/a'}`);
  }
  console.log(`   artifact: ${artifact}`);

  return { artifact, artifactPayload };
}