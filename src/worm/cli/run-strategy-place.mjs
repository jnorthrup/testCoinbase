// Lifted from robinhood-worm.js — Python array scissor.
// Full shared imports cloned. DCE later.

import path from 'path';
import { fileURLToPath } from 'url';
import { selectStrategyPreviewCandidate } from './strategy-preview.mjs';
import { writeWormLiveArtifact } from './artifact-writer.mjs';
import { verifyOrder } from './verify-order.mjs';
import { getEffectivePriceFromResp, getFilledQuantityFromResp, getGrossValueFromResp, getTotalFeesFromResp, getSettledValueFromResp } from '../utils/helpers.mjs';
import { loadLivePortfolioSnapshot } from './portfolio-snapshot.mjs';

const STATE_FILE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'liveEngineState.json');

function saveState() {
  // This is a stub - the real saveState is in robinhood-worm.js
  // The caller is expected to call its own saveState
}

export async function runStrategyPlaceOnce(engine, api, strategyPlace, portfolioSummary, holdingDetails, cashBalance) {
  const candidate = selectStrategyPreviewCandidate(engine, portfolioSummary, holdingDetails, cashBalance, api, strategyPlace.requestedUsd);
  if (!candidate) {
    const artifactPayload = {
      generatedAt: new Date().toISOString(),
      mode: 'worm-strategy-live',
      selectionMode: 'none',
      side: 'none',
      symbol: null,
      productId: 'NONE',
      requestedUsd: strategyPlace.requestedUsd,
      cashBalance,
      reason: 'no exact live strategy trigger and no fallback candidate met minimum trade constraints',
      orderPlaced: false,
    };
    const artifact = writeWormLiveArtifact(artifactPayload);
    console.log('🧠 Worm strategy live found no eligible candidate.');
    console.log(`   artifact: ${artifact}`);
    return { artifact, artifactPayload };
  }

  const preTradeQuantity = holdingDetails[candidate.symbol]?.rawQuantity || 0;
  let response = candidate.side === 'SELL'
    ? await engine._placeSell(api, candidate.productId, candidate.previewQuantity, candidate.previewPrice)
    : await engine._placeBuy(api, candidate.productId, candidate.previewQuantity, candidate.previewPrice);

  if (!response) {
    throw new Error(`Strategy live path returned no response for ${candidate.side} ${candidate.productId}`);
  }
  if (response.preview_only) {
    throw new Error(`Strategy live path unexpectedly returned preview-only response for ${candidate.side} ${candidate.productId}`);
  }

  if (response?.id && String(response?.state || '').toLowerCase() !== 'filled') {
    const verified = await verifyOrder(api, response.id, candidate.productId, 10, 1500);
    if (verified) response = verified;
  }
  if (String(response?.state || '').toLowerCase() !== 'filled') {
    throw new Error(`Strategy live path did not confirm FILLED for ${candidate.productId}; last state was '${response?.state || 'unknown'}'`);
  }

  const effectivePrice = getEffectivePriceFromResp(response, candidate.previewPrice);
  const filledQuantity = getFilledQuantityFromResp(response, candidate.previewQuantity);
  const grossValue = getGrossValueFromResp(response, candidate.previewQuantity, candidate.previewPrice);
  const totalFees = getTotalFeesFromResp(response);
  const settledValue = getSettledValueFromResp(response, candidate.previewQuantity, candidate.previewPrice);

  engine._logTrade({
    asset: candidate.symbol,
    side: candidate.side,
    quantity: filledQuantity.toString(),
    price: effectivePrice.toString(),
    clientOrderId: response.client_order_id || response.id,
    note: `Strategy Live ${candidate.selectionMode}`,
    grossValue,
    totalFees,
    settledValue,
  });

  engine.lastActionTimestamps[candidate.symbol] = Date.now();

  const postTradeSnapshot = await loadLivePortfolioSnapshot(api);
  engine.cashBalance = postTradeSnapshot.cashBalance;
  engine.holdings = postTradeSnapshot.holdingDetails;
  saveState();

  const artifactPayload = {
    generatedAt: new Date().toISOString(),
    mode: 'worm-strategy-live',
    selectionMode: candidate.selectionMode,
    reason: candidate.reason,
    exactTrigger: candidate.exactTrigger,
    side: candidate.side,
    symbol: candidate.symbol,
    productId: candidate.productId,
    requestedUsd: strategyPlace.requestedUsd,
    usdAmount: candidate.usdAmount,
    preTrade: {
      cashBalance,
      availableQuantity: preTradeQuantity,
    },
    execution: {
      orderId: response.id,
      clientOrderId: response.client_order_id || null,
      state: response.state,
      averagePrice: effectivePrice,
      filledQuantity,
      filledValue: grossValue,
      totalFees,
      totalValueAfterFees: settledValue,
    },
    postTrade: {
      cashBalance: postTradeSnapshot.cashBalance,
      availableQuantity: postTradeSnapshot.holdingDetails[candidate.symbol]?.rawQuantity || 0,
    },
    persistedStatePath: STATE_FILE_PATH,
    tradeHistoryPath: path.join(process.cwd(), 'trade_history.log'),
    response,
  };
  const artifact = writeWormLiveArtifact(artifactPayload);

  console.log(`🧠 Worm strategy LIVE ${candidate.side} ${candidate.productId} [${candidate.selectionMode}]`);
  console.log(`   reason: ${candidate.reason}`);
  console.log(`   order state: ${response.state}`);
  console.log(`   filled quantity: ${filledQuantity}`);
  console.log(`   gross / fees / settled: ${grossValue} / ${totalFees} / ${settledValue}`);
  console.log(`   cash balance: $${cashBalance.toFixed(2)} -> $${postTradeSnapshot.cashBalance.toFixed(2)}`);
  console.log(`   artifact: ${artifact}`);

  return { artifact, artifactPayload, response, postTradeSnapshot };
}