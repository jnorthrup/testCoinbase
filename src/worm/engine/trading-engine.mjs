import { getAlphaModulatedTriggers } from './alpha-modulator.mjs';
import { calculateRealizedVolatility } from '../estimation/technical-indicators.mjs';
import { KalmanVolatilityFilter } from '../estimation/kalman-volatility.mjs';
import { RegimeGenomeManager } from '../regime/regime-genome-manager.mjs';

// In constructor:
// this.regimeGenomeManager = new RegimeGenomeManager();
// this.volatilityFilters = {};
// this.filteredVolatility = {};
// this.logStrategyState = process.env.LOG_STRATEGY === 'true';

_getModulatedTriggers(sym, harvestMod = 0, rebalanceMod = 0) {
  const recentPrices = this._priceHistory?.[sym]?.slice(-60);
  if (!recentPrices || recentPrices.length < 20) return null;

  if (!this.volatilityFilters) this.volatilityFilters = {};
  if (!this.volatilityFilters[sym]) {
    this.volatilityFilters[sym] = new KalmanVolatilityFilter({
      initialVolatility: 0.025,
      processNoise: 0.00018,
      measurementNoise: 0.007
    });
  }

  const rawVol = calculateRealizedVolatility(recentPrices);
  const filteredVol = this.volatilityFilters[sym].update(rawVol);
  this.filteredVolatility[sym] = filteredVol;

  try {
    return getAlphaModulatedTriggers({
      flatHarvestTrigger: 0,
      flatRebalanceTrigger: 0,
      harvestModifier: harvestMod,
      rebalanceModifier: rebalanceMod,
      recentPrices
    });
  } catch (_) {
    return null;
  }
}

_getEffectiveGenome(sym, baseGenome) {
  if (!this.regimeDetector || !this.regimeGenomeManager) return baseGenome;

  const regime = this.regimeDetector.getRegime(sym) || 'CRAB_CHOP';
  const regimeGenome = this.regimeGenomeManager.getGenome(sym, regime);

  if (regimeGenome) {
    if (this.logStrategyState) {
      console.log(`[Genome] Using regime-specific genome for ${sym} (${regime})`);
    }
    return { ...baseGenome, ...regimeGenome };
  }

  return baseGenome;
}

_logStrategyState(sym, context = {}) {
  if (!this.logStrategyState) return;

  const {
    regime = 'N/A',
    conviction = 0,
    filteredVolatility = null,
    volAdjustment = 1,
    finalHarvestTrigger = 0,
    finalRebalanceTrigger = 0
  } = context;

  console.log(
    `[Strategy] ${sym.padEnd(8)} | Regime: ${regime.padEnd(18)} | ` +
    `Conv: ${conviction.toFixed(3)} | ` +
    `FiltVol: ${filteredVolatility ? filteredVolatility.toFixed(4) : 'N/A'} | ` +
    `VolAdj: ${volAdjustment.toFixed(3)} | ` +
    `H-Trig: ${finalHarvestTrigger.toFixed(4)} | ` +
    `R-Trig: ${finalRebalanceTrigger.toFixed(4)}`
  );
}

// Example usage in harvest logic:
// const effectiveGenome = this._getEffectiveGenome(sym, currentGenome);
// const modulated = this._getModulatedTriggers(sym, hMod, 0);
// const finalHarvestTrigger = modulated?.modulatedHarvestTrigger ?? (flatHarvestTrigger + hMod + effectiveSellSlip);