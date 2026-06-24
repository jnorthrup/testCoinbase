// src/worm/estimation/inductive-oracle.mjs
// Inductive Math Oracle: Computes optimal trading parameters using closed-form financial math.

import { 
  calculateOrderBookImbalance, 
  calculateDownsideSemiVariance, 
  calculateTailDependence, 
  extractKalmanInnovation 
} from './quant-discriminators.mjs';

/**
 * Shannon-Leland Optimal Threshold
 * Calculates the mathematically optimal rebalance/harvest threshold given transaction friction.
 * Extended Leland formulation: w = (1.5 * cost / sigma^2)^(1/3)
 *
 * @param {number} downsideSemiVariance - The asymmetric risk measure (sigma_down^2)
 * @param {number} transactionCost - Proportional expected cost (e.g., fee + slippage, ~0.006)
 * @returns {number} The optimal trigger percentage (e.g., 0.035)
 */
export function induceOptimalTrigger(downsideSemiVariance, transactionCost = 0.006) {
  // Guard against unrealistic zero variance
  const safeVariance = Math.max(downsideSemiVariance, 0.00001);
  
  // Leland optimal band width
  const optimalBand = Math.pow((1.5 * transactionCost) / safeVariance, 1/3);
  
  // Constrain to sane bounds (1% to 15%)
  return Math.max(0.01, Math.min(0.15, optimalBand));
}

/**
 * Asymmetric Kelly Allocation
 * Calculates the optimal capital allocation split using the Kelly Criterion f* = mu / sigma^2,
 * conditioned by order book imbalance, Kalman surprise, and tail-dependence contagion.
 *
 * @param {Object} context - The current market context
 * @param {Object} context.assets - Dict of asset metrics: { 'BTC': { book, kalmanEstimate, currentPrice, prices }, ... }
 * @param {string} context.triggerAsset - The asset that triggered the harvest
 * @returns {Object} Allocations mapping (BTC, ETH, Reinvest, Cash summing to 1.0)
 */
export function induceOptimalAllocation(context) {
  const { assets, triggerAsset } = context;
  
  // Default fallback if context is missing
  if (!assets || !assets['BTC'] || !assets['ETH']) {
    return { BTC: 0.25, ETH: 0.25, Reinvest: 0.20, Cash: 0.30 };
  }

  // 1. Calculate the Kelly fraction (f*) for each target asset
  const calculateKelly = (sym) => {
    const assetData = assets[sym];
    if (!assetData) return 0.01;

    // μ_obi: Order Book Imbalance (-1 to +1, scaled to a drift proxy, say max 2% edge per period)
    const obi = calculateOrderBookImbalance(assetData.book);
    const mu_obi = obi * 0.02;

    // μ_innov: Kalman Surprise
    const mu_innov = extractKalmanInnovation(assetData.kalmanEstimate, assetData.currentPrice);

    // Total expected forward edge
    const total_mu = mu_obi + mu_innov;

    // σ²_down: Asymmetric Risk
    const sigma2_down = calculateDownsideSemiVariance(assetData.prices);

    // Naive Kelly f = μ / σ²
    // We floor μ at a small positive number to ensure non-zero weights for baseline holding
    const safe_mu = Math.max(0.001, total_mu); 
    const kelly_f = safe_mu / sigma2_down;

    // Tail Dependence Penalty (against BTC)
    // BTC has TD=0 against itself.
    let tailDiscount = 0;
    if (sym !== 'BTC' && assets['BTC'].prices) {
      const td = calculateTailDependence(assetData.prices, assets['BTC'].prices);
      // If TD is high (> 0.5), we apply a heavy penalty.
      tailDiscount = Math.max(0, td - 0.2); 
    }

    return Math.max(0, kelly_f * (1 - tailDiscount));
  };

  const scoreBTC = calculateKelly('BTC');
  const scoreETH = calculateKelly('ETH');
  
  // Reinvest score is the score of the asset that just triggered the harvest
  const scoreReinvest = triggerAsset ? calculateKelly(triggerAsset) : 0;

  // We add a 'Cash' base score. Cash has 0 variance and 0 drift, but it acts as 
  // the risk-free denominator in our normalization. We assign it a fixed high score 
  // to ensure Kelly doesn't suggest 100% leverage.
  const scoreCash = 100; // Arbitrary safe baseline

  const totalScore = scoreBTC + scoreETH + scoreReinvest + scoreCash;

  // Normalize to 1.0
  return {
    BTC: scoreBTC / totalScore,
    ETH: scoreETH / totalScore,
    Reinvest: scoreReinvest / totalScore,
    Cash: scoreCash / totalScore
  };
}
