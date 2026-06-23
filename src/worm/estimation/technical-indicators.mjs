// src/worm/estimation/technical-indicators.mjs
// Technical analysis indicators for generating additional alpha signals.
// These can be used to filter, modulate, or confirm harvest/rebalance/spawn decisions
// in the trading engine, regime detection, and scientific optimizer.
// Pure functions, no external dependencies. Suitable for both batch backtests and streaming.

export function calculateRSI(prices, period = 14) {
  if (!Array.isArray(prices) || prices.length < period + 1) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const delta = prices[i] - prices[i - 1];
    if (delta > 0) avgGain += delta;
    else avgLoss -= delta;
  }
  avgGain /= period;
  avgLoss /= period;
  let rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  let rsi = 100 - (100 / (1 + rs));
  for (let i = period + 1; i < prices.length; i++) {
    const delta = prices[i] - prices[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    rsi = 100 - (100 / (1 + rs));
  }
  return rsi;
}

export function calculateSMA(prices, period) {
  if (!Array.isArray(prices) || prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((sum, p) => sum + p, 0) / period;
}

export function calculateEMA(prices, period) {
  if (!Array.isArray(prices) || prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((sum, p) => sum + p, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

export function calculateBollingerBands(prices, period = 20, stdDevMultiplier = 2) {
  if (!Array.isArray(prices) || prices.length < period) return null;
  const sma = calculateSMA(prices, period);
  const slice = prices.slice(-period);
  const squaredDiffs = slice.map(p => Math.pow(p - sma, 2));
  const variance = squaredDiffs.reduce((sum, d) => sum + d, 0) / period;
  const std = Math.sqrt(variance);
  const upper = sma + stdDevMultiplier * std;
  const lower = sma - stdDevMultiplier * std;
  const lastPrice = prices[prices.length - 1];
  const percentB = (upper - lower) === 0 ? 0.5 : (lastPrice - lower) / (upper - lower);
  return {
    middle: sma,
    upper,
    lower,
    percentB: Math.max(0, Math.min(1, percentB)),
    bandwidth: (upper - lower) / sma,
    std
  };
}

export function calculateROC(prices, period = 10) {
  if (!Array.isArray(prices) || prices.length < period + 1) return null;
  const current = prices[prices.length - 1];
  const past = prices[prices.length - period - 1];
  if (past === 0) return 0;
  return ((current - past) / past) * 100;
}

export function calculateVolatility(prices, period = 20, annualize = false) {
  if (!Array.isArray(prices) || prices.length < period + 1) return null;
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] !== 0) {
      returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }
  }
  if (returns.length < period) return null;
  const recent = returns.slice(-period);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
  let vol = Math.sqrt(variance);
  if (annualize) vol *= Math.sqrt(252); // assumes daily bars; scale for tick data as needed
  return vol;
}

/**
 * Composite alpha conviction score (-1 to +1).
 * Positive = bullish conviction for buys/rebalances or holding winners.
 * Negative = bearish or overbought signal for harvesting.
 * Combines RSI (momentum/mean-reversion), Bollinger position, and short-term ROC.
 * This is a ready-to-use alpha factor that can modulate thresholds, position sizes,
 * or act as a filter in the trading engine and optimizer.
 */
export function calculateAlphaConviction(prices, options = {}) {
  const {
    rsiPeriod = 14,
    bbPeriod = 20,
    rocPeriod = 10,
    rsiWeight = 0.4,
    bbWeight = 0.3,
    rocWeight = 0.3
  } = options;

  const rsi = calculateRSI(prices, rsiPeriod);
  const bb = calculateBollingerBands(prices, bbPeriod);
  const roc = calculateROC(prices, rocPeriod);

  if (rsi === null || bb === null || roc === null) {
    return { conviction: 0, signals: { insufficientData: true }, rsi, bb, roc };
  }

  let conviction = 0;
  const signals = {};

  // RSI component: mean-reversion bias with momentum awareness
  if (rsi > 75) {
    signals.rsi = 'strongly_overbought';
    conviction -= 0.5 * rsiWeight;
  } else if (rsi > 65) {
    signals.rsi = 'overbought';
    conviction -= 0.25 * rsiWeight;
  } else if (rsi < 25) {
    signals.rsi = 'strongly_oversold';
    conviction += 0.6 * rsiWeight;
  } else if (rsi < 35) {
    signals.rsi = 'oversold';
    conviction += 0.35 * rsiWeight;
  } else {
    signals.rsi = 'neutral';
    // slight mean-reversion pull to center
    conviction += (50 - rsi) / 100 * 0.1 * rsiWeight;
  }

  // Bollinger %B: position in band for mean-reversion alpha
  if (bb.percentB > 0.95) {
    signals.bb = 'at_upper_band';
    conviction -= 0.4 * bbWeight;
  } else if (bb.percentB > 0.8) {
    signals.bb = 'upper_half';
    conviction -= 0.15 * bbWeight;
  } else if (bb.percentB < 0.05) {
    signals.bb = 'at_lower_band';
    conviction += 0.5 * bbWeight;
  } else if (bb.percentB < 0.2) {
    signals.bb = 'lower_half';
    conviction += 0.25 * bbWeight;
  } else {
    signals.bb = 'middle_band';
  }

  // ROC momentum confirmation
  if (roc > 8) {
    signals.roc = 'strong_momentum_up';
    conviction += 0.4 * rocWeight;
  } else if (roc > 3) {
    signals.roc = 'momentum_up';
    conviction += 0.2 * rocWeight;
  } else if (roc < -8) {
    signals.roc = 'strong_momentum_down';
    conviction -= 0.35 * rocWeight;
  } else if (roc < -3) {
    signals.roc = 'momentum_down';
    conviction -= 0.15 * rocWeight;
  } else {
    signals.roc = 'neutral_momentum';
  }

  // Normalize to [-1, 1]
  const rawConviction = conviction;
  conviction = Math.max(-1, Math.min(1, conviction));

  return {
    conviction,
    rawConviction,
    rsi: rsi.toFixed(2),
    bbPercentB: bb.percentB.toFixed(3),
    roc: roc.toFixed(2),
    signals,
    interpretation: conviction > 0.3 ? 'BULLISH_ALPHA' : 
                    conviction < -0.3 ? 'BEARISH_OR_OVERBOUGHT' : 'NEUTRAL'
  };
}

export default {
  calculateRSI,
  calculateSMA,
  calculateEMA,
  calculateBollingerBands,
  calculateROC,
  calculateVolatility,
  calculateAlphaConviction
};
