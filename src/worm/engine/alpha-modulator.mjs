// src/worm/engine/alpha-modulator.mjs
// Highest-leverage integration layer between technical alpha signals and the TradingEngine.
// This is the mechanical bridge that turns research alpha (RSI, Bollinger, ROC, Conviction)
// into live trading mechanics (threshold modulation, position sizing, spawn conviction).
//
// Goal: Maximum edge extraction with minimum risk of breakage.
// All modulations are small, bounded, and gracefully degrade if data is missing.

import { memoize } from '../utils/idempotent-cache.mjs';
import { calculateAlphaConviction } from '../estimation/technical-indicators.mjs';

const memoizedConviction = memoize(calculateAlphaConviction, { maxSize: 256 });

/**
 * Compute bounded alpha conviction for an asset given recent prices.
 * Returns a value in [-1, 1] or 0 if insufficient data.
 */
export function getAlphaConviction(recentPrices, options = {}) {
  if (!recentPrices || recentPrices.length < 20) return 0;
  try {
    const result = memoizedConviction(recentPrices, options);
    return result?.conviction ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Modulate a harvest trigger percentage using alpha conviction.
 * - Positive conviction (bullish momentum / healthy) → slightly higher trigger → let winners run longer.
 * - Negative conviction (overbought) → lower trigger → harvest more aggressively.
 *
 * Modulation is deliberately small (±1.5% on the trigger) to limit risk.
 */
export function modulateHarvestTrigger(baseTrigger, conviction) {
  if (typeof conviction !== 'number' || Math.abs(conviction) < 0.1) {
    return baseTrigger;
  }
  // conviction in [-1,1] → modulation roughly [-0.015, +0.015]
  const mod = Math.max(-0.015, Math.min(0.015, conviction * 0.04));
  return baseTrigger + mod;
}

/**
 * Modulate a rebalance trigger using alpha conviction.
 * - Strong oversold conviction → more aggressive rebalance (lower trigger).
 * - Overbought conviction → less aggressive rebalance.
 */
export function modulateRebalanceTrigger(baseTrigger, conviction) {
  if (typeof conviction !== 'number' || Math.abs(conviction) < 0.1) {
    return baseTrigger;
  }
  const mod = Math.max(-0.015, Math.min(0.015, -conviction * 0.035)); // opposite sign for rebalance
  return baseTrigger + mod;
}

/**
 * Scale Kelly spawn size or conviction using alpha signal.
 * Positive conviction increases spawn aggressiveness modestly.
 */
export function modulateSpawnConviction(baseKellyFraction, conviction) {
  if (typeof conviction !== 'number') return baseKellyFraction;
  const scale = 1 + Math.max(-0.3, Math.min(0.3, conviction * 0.25));
  return Math.max(0.05, Math.min(0.95, baseKellyFraction * scale));
}

/**
 * Convenience: get modulated triggers in one call (for use inside TradingEngine update loop).
 */
export function getAlphaModulatedTriggers({
  flatHarvestTrigger,
  flatRebalanceTrigger,
  harvestModifier = 0,
  rebalanceModifier = 0,
  recentPrices = null,
  convictionOptions = {}
}) {
  const conviction = getAlphaConviction(recentPrices, convictionOptions);

  const harvest = modulateHarvestTrigger(flatHarvestTrigger + harvestModifier, conviction);
  const rebalance = modulateRebalanceTrigger(flatRebalanceTrigger + rebalanceModifier, conviction);

  return {
    conviction,
    modulatedHarvestTrigger: harvest,
    modulatedRebalanceTrigger: rebalance,
    alphaInterpretation: conviction > 0.25 ? 'BULLISH' : conviction < -0.25 ? 'BEARISH' : 'NEUTRAL'
  };
}

export default {
  getAlphaConviction,
  modulateHarvestTrigger,
  modulateRebalanceTrigger,
  modulateSpawnConviction,
  getAlphaModulatedTriggers
};