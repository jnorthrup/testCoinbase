// --- RegimeDetector (Enhanced with Technical Alpha Factors) ---
// Now incorporates RSI, Bollinger, and composite alpha conviction for more nuanced
// regime detection. This enables the trading system to generate additional alpha
// by adapting harvest/rebalance/spawn logic based on momentum + mean-reversion signals.
//
// Performance & Idempotency: Heavy indicator calculations (RSI, BB, ROC, AlphaConviction)
// are memoized using the shared idempotent-cache utility. Repeated analyses on the same
// or highly similar price histories (common in optimizer sweeps and backtests) are fast
// and perfectly deterministic.

import {
  calculateRSI,
  calculateBollingerBands,
  calculateROC,
  calculateAlphaConviction
} from '../estimation/technical-indicators.mjs';

import { memoize } from '../utils/idempotent-cache.mjs';

// Memoized indicator functions for performance in repeated regime analysis
// (keyed intelligently on array length + tail hash for large price histories)
const memoizedCalculateRSI = memoize(calculateRSI, { maxSize: 64 });
const memoizedCalculateBollingerBands = memoize(calculateBollingerBands, { maxSize: 64 });
const memoizedCalculateROC = memoize(calculateROC, { maxSize: 64 });
const memoizedCalculateAlphaConviction = memoize(calculateAlphaConviction, { maxSize: 32 });

export class RegimeDetector {
  constructor() {
    this.regimes = {};
    this.market24h = { gainers: [], losers: [] };
    this.diagnostics = {}; // per-symbol last analysis details for alpha use
  }

  analyze(symbol, history) {
    if (!history || history.length < 50) {
      this.regimes[symbol] = 'UNKNOWN';
      this.diagnostics[symbol] = { regime: 'UNKNOWN', reason: 'insufficient_history' };
      return 'UNKNOWN';
    }

    const currentPrice = history[history.length - 1];
    const startPrice = history[0];
    const roi = (currentPrice - startPrice) / startPrice;
    const mean = history.reduce((a, b) => a + b) / history.length;
    const variance = history.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / history.length;
    const volatility = Math.sqrt(variance) / mean;

    // --- NEW: Alpha factors from technical indicators (memoized for speed & idempotency) ---
    const rsi = memoizedCalculateRSI(history, 14);
    const bb = memoizedCalculateBollingerBands(history, 20);
    const roc = memoizedCalculateROC(history, 10);
    const alphaConv = memoizedCalculateAlphaConviction(history, { rsiPeriod: 14, bbPeriod: 20, rocPeriod: 10 });

    let regime = 'CRAB_CHOP';
    let regimeReason = 'base_vol_roi';

    // Base regime logic (preserved)
    if (roi > 0.05 && volatility > 0.02) {
      regime = 'BULL_RUSH';
      regimeReason = 'strong_uptrend_high_vol';
    } else if (roi < -0.05 && volatility > 0.02) {
      regime = 'BEAR_CRASH';
      regimeReason = 'strong_downtrend_high_vol';
    } else if (roi > 0.02 && volatility < 0.01) {
      regime = 'STEADY_GROWTH';
      regimeReason = 'steady_up_low_vol';
    } else if (volatility > 0.05) {
      regime = 'VOLATILE_CHOP';
      regimeReason = 'high_volatility';
    }

    // --- NEW: Alpha-enhanced regime refinement using conviction and RSI ---
    // This adds more alpha by making regimes sensitive to overbought/oversold + momentum
    if (regime === 'BULL_RUSH' && rsi !== null) {
      if (rsi > 72 && alphaConv.conviction < 0) {
        regime = 'BULL_RUSH_OVERBOUGHT';
        regimeReason = 'bull_rush_with_overbought_rsi';
      } else if (rsi < 45) {
        // Strong bull but not yet overbought - healthy momentum
        regimeReason = 'bull_rush_healthy_momentum';
      }
    }

    if (regime === 'BEAR_CRASH' && rsi !== null && rsi < 28) {
      regime = 'BEAR_CRASH_OVERSOLD';
      regimeReason = 'bear_crash_with_oversold_rsi_alpha_opportunity';
    }

    if (regime === 'VOLATILE_CHOP' && alphaConv.conviction > 0.4) {
      regime = 'VOLATILE_CHOP_BULLISH_ALPHA';
      regimeReason = 'volatile_but_strong_alpha_conviction';
    }

    // Store rich diagnostics for downstream alpha use (engine, optimizer, optimizer, etc.)
    this.diagnostics[symbol] = {
      regime,
      regimeReason,
      roi: parseFloat(roi.toFixed(4)),
      volatility: parseFloat(volatility.toFixed(4)),
      rsi: rsi !== null ? parseFloat(rsi.toFixed(2)) : null,
      bbPercentB: bb ? parseFloat(bb.percentB.toFixed(3)) : null,
      roc: roc !== null ? parseFloat(roc.toFixed(2)) : null,
      alphaConviction: alphaConv.conviction,
      alphaInterpretation: alphaConv.interpretation,
      signals: alphaConv.signals,
      timestamp: Date.now()
    };

    if (this.regimes[symbol] !== regime) {
      console.log(`[Regime+Alpha] ${symbol} Change: ${this.regimes[symbol] || 'INIT'} -> ${regime} ` +
        `(Vol: ${(volatility * 100).toFixed(2)}%, RSI: ${rsi ? rsi.toFixed(1) : 'N/A'}, ` +
        `Conviction: ${alphaConv.conviction.toFixed(2)})`);
    }
    this.regimes[symbol] = regime;
    return regime;
  }

  getDiagnostics(symbol) {
    return this.diagnostics[symbol] || null;
  }

  update(symbol, price, timestamp) {
    // Placeholder for streaming price buffer if needed for fully self-contained state.
    // Current design expects analyze(history) to be called with sufficient price array.
  }

  updateMarket24h(gainers, losers) {
    this.market24h = { gainers, losers, updatedAt: Date.now() };
    if (gainers.length > 0) {
      console.log(`24h Gainers: ${gainers.map(g => `${g.symbol} ${g.change24h.toFixed(2)}%`).join(', ')}`);
    }
    if (losers.length > 0) {
      console.log(`24h Losers: ${losers.map(l => `${l.symbol} ${l.change24h.toFixed(2)}%`).join(', ')}`);
    }
  }

  getRegime(symbol) {
    return this.regimes[symbol] || 'UNKNOWN';
  }

  getMarket24h() {
    return this.market24h;
  }

  // Convenience: get full alpha-enriched regime info
  getAlphaRegimeInfo(symbol) {
    const regime = this.getRegime(symbol);
    const diag = this.getDiagnostics(symbol);
    return { regime, ...diag };
  }
}