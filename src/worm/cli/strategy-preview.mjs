// Lifted from robinhood-worm.js — Python array scissor.
// Full shared imports cloned. DCE later.

import { SLIPPAGE_BUFFERS, HARVEST_EXCLUDE, REBALANCE_EXCLUDE } from '../config/constants.mjs';
import { roundQty, checkMinQuantity } from '../utils/quantity.mjs';
import { checkMinTrade } from '../utils/format.mjs';
import { getGenomicParam } from '../utils/helpers.mjs';

export function getLiveTriggerEnvelope(engine, symbol, api) {
  const ratchet = engine?.ratchetState?.[symbol] || null;
  const hMod = ratchet ? (ratchet.harvestModifier || 0.0) : 0.0;
  const rMod = ratchet ? (ratchet.rebalanceModifier || 0.0) : 0.0;

  const slipConfig = SLIPPAGE_BUFFERS[symbol] || SLIPPAGE_BUFFERS.DEFAULT;
  const lastBuySlip = ratchet && ratchet.lastSlippage !== undefined && ratchet.lastSlippage !== null ? ratchet.lastSlippage : slipConfig.buy;
  const lastSellSlip = ratchet && ratchet.lastSlippage !== undefined && ratchet.lastSlippage !== null ? ratchet.lastSlippage : slipConfig.sell;
  const apiBuySlip = api?.lastSpreads?.[symbol]?.buy;
  const apiSellSlip = api?.lastSpreads?.[symbol]?.sell;
  const effectiveBuySlip = apiBuySlip !== undefined ? Math.max(apiBuySlip, lastBuySlip) : lastBuySlip;
  const effectiveSellSlip = apiSellSlip !== undefined ? Math.max(apiSellSlip, lastSellSlip) : lastSellSlip;

  let rebalanceTrigger = (getGenomicParam(engine.genome, 'FLAT_REBALANCE_TRIGGER_PERCENT', symbol) || 0) + rMod;
  if (engine.isGlobalRiskSignalActive) {
    rebalanceTrigger *= (engine.genome.CRASH_PROTECTION_THRESHOLD_INCREASE || 2);
  }
  rebalanceTrigger += effectiveBuySlip;

  return {
    harvestTrigger: (getGenomicParam(engine.genome, 'FLAT_HARVEST_TRIGGER_PERCENT', symbol) || 0) + hMod + effectiveSellSlip,
    rebalanceTrigger,
  };
}


export function selectStrategyPreviewCandidate(engine, portfolioSummary, holdingDetails, cashBalance, api, requestedUsd = 10) {
  const harvestCandidates = [];
  const rebalanceCandidates = [];

  for (const row of portfolioSummary) {
    const sym = row.Symbol;
    const baseline = row.Baseline;
    const price = row.Price;
    const value = row.Value;
    if (!sym || !Number.isFinite(price) || price <= 0 || !Number.isFinite(baseline) || baseline <= 0 || !Number.isFinite(value) || value <= 0) continue;

    const deviationRatio = (value - baseline) / baseline;
    const availableQty = holdingDetails[sym]?.rawQuantity || 0;
    const { harvestTrigger, rebalanceTrigger } = getLiveTriggerEnvelope(engine, sym, api);

    if (!HARVEST_EXCLUDE.includes(sym) && availableQty > 0 && deviationRatio >= harvestTrigger) {
      const usdAmount = Math.min(requestedUsd, value);
      const quantity = roundQty(sym, usdAmount / price);
      const tradeValue = parseFloat(quantity) * price;
      if (parseFloat(quantity) > 0 && availableQty >= parseFloat(quantity) && checkMinQuantity(sym, quantity) && checkMinTrade(tradeValue)) {
        harvestCandidates.push({
          side: 'SELL',
          symbol: sym,
          productId: `${sym}-USD`,
          usdAmount,
          previewPrice: price,
          previewQuantity: quantity,
          selectionMode: 'exact-harvest-trigger',
          reason: 'live harvest trigger active',
          exactTrigger: true,
          deviationRatio,
          activeHarvestTrigger: harvestTrigger,
          activeRebalanceTrigger: rebalanceTrigger,
          triggerGap: deviationRatio - harvestTrigger,
          availableQuantity: availableQty,
        });
      }
    }

    if (!REBALANCE_EXCLUDE.includes(sym) && deviationRatio <= -rebalanceTrigger) {
      const usdAmount = Math.min(requestedUsd, cashBalance);
      const quantity = roundQty(sym, usdAmount / price);
      const tradeValue = parseFloat(quantity) * price;
      if (usdAmount > 0 && parseFloat(quantity) > 0 && checkMinQuantity(sym, quantity) && checkMinTrade(tradeValue) && cashBalance >= tradeValue) {
        rebalanceCandidates.push({
          side: 'BUY',
          symbol: sym,
          productId: `${sym}-USD`,
          usdAmount,
          previewPrice: price,
          previewQuantity: quantity,
          selectionMode: 'exact-rebalance-trigger',
          reason: 'live rebalance trigger active',
          exactTrigger: true,
          deviationRatio,
          activeHarvestTrigger: harvestTrigger,
          activeRebalanceTrigger: rebalanceTrigger,
          triggerGap: Math.abs(deviationRatio) - rebalanceTrigger,
          availableQuantity: availableQty,
        });
      }
    }
  }

  harvestCandidates.sort((a, b) => (b.triggerGap - a.triggerGap) || (b.usdAmount - a.usdAmount));
  if (harvestCandidates.length > 0) return harvestCandidates[0];

  rebalanceCandidates.sort((a, b) => (b.triggerGap - a.triggerGap) || (b.usdAmount - a.usdAmount));
  if (rebalanceCandidates.length > 0) return rebalanceCandidates[0];

  const fallbackCandidates = portfolioSummary
    .filter((row) => {
      const availableQty = holdingDetails[row.Symbol]?.rawQuantity || 0;
      return row.Symbol && row.Price > 0 && availableQty > 0 && row.Value >= Math.min(requestedUsd, row.Value) && row.Symbol !== 'USDC' && row.Symbol !== 'USDG';
    })
    .map((row) => ({
      side: 'SELL',
      symbol: row.Symbol,
      productId: `${row.Symbol}-USD`,
      usdAmount: Math.min(requestedUsd, row.Value),
      previewPrice: row.Price,
      previewQuantity: roundQty(row.Symbol, Math.min(requestedUsd, row.Value) / row.Price),
      selectionMode: 'fallback-dominant-holding',
      reason: 'no exact live strategy trigger active; previewing dominant live holding instead',
      exactTrigger: false,
      deviationRatio: Number.isFinite(row.Baseline) && row.Baseline > 0 ? ((row.Value - row.Baseline) / row.Baseline) : null,
      activeHarvestTrigger: null,
      activeRebalanceTrigger: null,
      triggerGap: null,
      availableQuantity: holdingDetails[row.Symbol]?.rawQuantity || 0,
      holdingValue: row.Value,
    }))
    .filter((candidate) => parseFloat(candidate.previewQuantity) > 0 && checkMinQuantity(candidate.symbol, candidate.previewQuantity) && checkMinTrade(parseFloat(candidate.previewQuantity) * candidate.previewPrice) && candidate.availableQuantity >= parseFloat(candidate.previewQuantity))
    .sort((a, b) => (b.holdingValue - a.holdingValue));

  return fallbackCandidates[0] || null;
}