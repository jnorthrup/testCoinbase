// src/worm/estimation/technical-indicators.mjs
// Technical analysis indicators for generating additional alpha signals.
// These can be used to filter, modulate, or confirm harvest/rebalance/spawn decisions
// in the trading engine, regime detection, and scientific optimizer.
// Pure functions, no external dependencies. Suitable for both batch backtests and streaming.
//
// Caching note: For maximum performance in optimizer sweeps, wrap heavy calls with
// memoize from '../utils/idempotent-cache.mjs' (or use the exported memoized variants
// in future versions). The functions are already idempotent by design.

/**
 * Calculate Relative Strength Index.
 * @param {number[]} prices
 * @param {number} period
 * @returns {number|null} RSI in [0, 100] or null if insufficient data
 */
export function calculateRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const delta = prices[i] - prices[i - 1];
    if (delta >= 0) gains += delta;
    else losses += Math.abs(delta);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Simple Moving Average.
 * @param {number[]} prices
 * @param {number} period
 * @returns {number|null}
 */
export function calculateSMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Exponential Moving Average.
 * @param {number[]} prices
 * @param {number} period
 * @returns {number|null}
 */
export function calculateEMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }
  return ema;
}

/**
 * Bollinger Bands.
 * @param {number[]} prices
 * @param {number} period
 * @param {number} numStdDev
 * @returns {{ upper: number, middle: number, lower: number, percentB: number }|null}
 */
export function calculateBollingerBands(prices, period = 20, numStdDev = 2) {
  if (!prices || prices.length < period) return null;
  const sma = calculateSMA(prices, period);
  const slice = prices.slice(-period);
  const variance = slice.reduce((sum, p) => sum + (p - sma) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);
  const upper = sma + numStdDev * stdDev;
  const lower = sma - numStdDev * stdDev;
  const latest = prices[prices.length - 1];
  const percentB = stdDev === 0 ? 0.5 : (latest - lower) / (upper - lower);
  return { upper, middle: sma, lower, percentB: Math.max(0, Math.min(1, percentB)) };
}

/**
 * Rate of Change.
 * @param {number[]} prices
 * @param {number} period
 * @returns {number|null}
 */
export function calculateROC(prices, period = 12) {
  if (!prices || prices.length < period + 1) return null;
  const latest = prices[prices.length - 1];
  const prior = prices[prices.length - 1 - period];
  if (prior === 0) return null;
  return (latest - prior) / prior;
}

/**
 * Historical volatility (annualised standard deviation of log returns).
 * @param {number[]} prices
 * @param {number} period
 * @returns {number|null}
 */
export function calculateVolatility(prices, period = 20) {
  if (!prices || prices.length < period + 1) return null;
  const slice = prices.slice(-period - 1);
  const returns = [];
  for (let i = 1; i < slice.length; i++) {
    if (slice[i - 1] > 0) returns.push(Math.log(slice[i] / slice[i - 1]));
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * 252); // annualised
}

/**
 * Alpha Conviction score — directional confidence from RSI + trend alignment.
 * @param {number[]} prices
 * @param {{ rsiPeriod?: number }} options
 * @returns {{ conviction: number, interpretation: string, rsi: number|null, signals: object }}
 */
export function calculateAlphaConviction(prices, { rsiPeriod = 14 } = {}) {
  const signals = {};
  if (!prices || prices.length < rsiPeriod + 1) {
    signals.insufficientData = true;
    return { conviction: 0, interpretation: 'NEUTRAL', rsi: null, signals };
  }
  const rsi = calculateRSI(prices, rsiPeriod);
  const roc = calculateROC(prices, 12);
  const bb = calculateBollingerBands(prices, 20);
  signals.rsi = rsi;
  signals.roc = roc;
  signals.bbPercentB = bb ? bb.percentB : null;

  let conviction = 0;
  // RSI component: overbought < 30 (bullish), > 70 (bearish)
  const rsiComponent = rsi !== null
    ? (rsi < 30 ? (30 - rsi) / 30 : rsi > 70 ? -(rsi - 70) / 30 : 0)
    : 0;
  // Trend component: positive ROC → bullish, negative → bearish
  const trendComponent = roc !== null ? Math.max(-1, Math.min(1, roc * 10)) : 0;
  // Bollinger position: price below lower band → bullish (oversold), above upper → bearish
  const bbComponent = bb
    ? (bb.percentB < 0.2 ? (0.2 - bb.percentB) * 2.5 : bb.percentB > 0.8 ? -(bb.percentB - 0.8) * 2.5 : 0)
    : 0;

  conviction = (rsiComponent + trendComponent + bbComponent) / 3;
  conviction = Math.max(-1, Math.min(1, conviction));

  let interpretation;
  if (conviction > 0.2) interpretation = 'BULLISH_ALPHA';
  else if (conviction < -0.2) interpretation = 'BEARISH_OR_OVERBOUGHT';
  else interpretation = 'NEUTRAL';

  return { conviction, interpretation, rsi, signals };
}
