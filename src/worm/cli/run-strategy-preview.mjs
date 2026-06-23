// Lifted from robinhood-worm.js — Python array scissor.
// Full shared imports cloned. DCE later.

import { selectStrategyPreviewCandidate } from './strategy-preview.mjs';
import { writeWormPreviewArtifact } from './artifact-writer.mjs';

export async function runStrategyPreviewOnce(engine, api, strategyPreview, portfolioSummary, holdingDetails, cashBalance) {
  const candidate = selectStrategyPreviewCandidate(engine, portfolioSummary, holdingDetails, cashBalance, api, strategyPreview.requestedUsd);
  if (!candidate) {
    const artifactPayload = {
      generatedAt: new Date().toISOString(),
      mode: 'worm-strategy-preview',
      selectionMode: 'none',
      side: 'none',
      symbol: null,
      productId: 'NONE',
      requestedUsd: strategyPreview.requestedUsd,
      cashBalance,
      reason: 'no exact live strategy trigger and no fallback candidate met minimum trade constraints',
    };
    const artifact = writeWormPreviewArtifact(artifactPayload);
    console.log('🧠 Worm strategy preview found no eligible candidate.');
    console.log(`   artifact: ${artifact}`);
    return { artifact, artifactPayload };
  }

  const response = candidate.side === 'SELL'
    ? await engine._placeSell(api, candidate.productId, candidate.previewQuantity, candidate.previewPrice)
    : await engine._placeBuy(api, candidate.productId, candidate.previewQuantity, candidate.previewPrice);

  if (!response) {
    throw new Error(`Strategy preview path returned no response for ${candidate.side} ${candidate.productId}`);
  }

  const artifactPayload = {
    generatedAt: new Date().toISOString(),
    mode: 'worm-strategy-preview',
    selectionMode: candidate.selectionMode,
    reason: candidate.reason,
    exactTrigger: candidate.exactTrigger,
    side: candidate.side,
    symbol: candidate.symbol,
    productId: candidate.productId,
    requestedUsd: strategyPreview.requestedUsd,
    usdAmount: candidate.usdAmount,
    cashBalance,
    availableQuantity: candidate.availableQuantity,
    previewPrice: candidate.previewPrice,
    previewQuantity: candidate.previewQuantity,
    deviationRatio: candidate.deviationRatio,
    activeHarvestTrigger: candidate.activeHarvestTrigger,
    activeRebalanceTrigger: candidate.activeRebalanceTrigger,
    triggerGap: candidate.triggerGap,
    response,
  };
  const artifact = writeWormPreviewArtifact(artifactPayload);

  console.log(`🧠 Worm strategy preview ${candidate.side} ${candidate.productId} [${candidate.selectionMode}]`);
  console.log(`   reason: ${candidate.reason}`);
  console.log(`   cash balance: $${cashBalance.toFixed(2)}`);
  console.log(`   preview price: $${candidate.previewPrice}`);
  console.log(`   preview quantity: ${candidate.previewQuantity}`);
  if (response.preview?.order_total || response.preview?.quote_size) {
    console.log(`   preview total/quote: ${response.preview.order_total || 'n/a'} / ${response.preview.quote_size || 'n/a'}`);
  }
  console.log(`   artifact: ${artifact}`);

  return { artifact, artifactPayload };
}