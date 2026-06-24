// src/worm/engine/alpha-modulator.mjs
// Highest-leverage integration layer between technical alpha signals and the TradingEngine.

import { memoize } from '../utils/idempotent-cache.mjs';
import { calculateAlphaConviction } from '../estimation/technical-indicators.mjs';

const memoizedConviction = memoize(calculateAlphaConviction, { maxSize: 256 });

export function getAlphaConviction(recentPrices, options = {}) {
  if (!recentPrices || recentPrices.length < 20) return 0;
  try {
    const result = memoizedConviction(recentPrices, options);
    return result?.conviction ?? 0;
  } catch {
    return 0;
  }
}

export function modulateHarvestTrigger(baseTrigger, conviction) {
  if (typeof conviction !== 'number' || Math.abs(conviction) < 0.1) return baseTrigger;
  const mod = Math.max(-0.015, Math.min(0.015, conviction * 0.04));
  return baseTrigger + mod;
}

export function modulateRebalanceTrigger(baseTrigger, conviction) {
  if (typeof conviction !== 'number' || Math.abs(conviction) < 0.1) return baseTrigger;
  const mod = Math.max(-0.015, Math.min(0.015, -conviction * 0.035));
  return baseTrigger + mod;
}

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
  getAlphaModulatedTriggers
};