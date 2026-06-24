// src/worm/estimation/technical-indicators.mjs
// Technical indicators with volatility awareness

import { KalmanVolatilityFilter } from './kalman-volatility.mjs';

const globalVolFilter = new KalmanVolatilityFilter({
  initialVolatility: 0.025,
  processNoise: 0.00018,
  measurementNoise: 0.007
});

export function calculateRealizedVolatility(prices, periodsPerYear = 525600) {
  if (!prices || prices.length < 2) return 0;

  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    const ret = Math.log(prices[i] / prices[i - 1]);
    returns.push(ret);
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  return stdDev * Math.sqrt(periodsPerYear);
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
  if (annualize) vol *= Math.sqrt(252);
  return vol;
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

export function calculateBollingerBands(prices, period = 20, stdDevMultiplier = 2) {
  if (!Array.isArray(prices) || prices.length < period) return null;
  const sma = calculateSMA(prices, period);
  if (sma === null) return null;
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

export function calculateAlphaConviction(prices, options = {}) {
  if (!prices || prices.length < 20) {
    return { conviction: 0, signals: { insufficientData: true }, rsi: null, bb: null, roc: null };
  }

  const rsi = calculateRSI(prices);
  const bb = calculateBollingerBands(prices);
  const roc = calculateROC(prices, 10);

  const rawVol = calculateRealizedVolatility(prices);
  const filteredVol = globalVolFilter.update(rawVol);

  const volAdjustment = Math.max(0.6, Math.min(1.4, 1 / (1 + filteredVol * 2.5)));

  let conviction = 0;

  if (rsi < 30) conviction += 0.4;
  else if (rsi > 70) conviction -= 0.4;

  if (bb && bb.percentB < 0.2) conviction += 0.3;
  else if (bb && bb.percentB > 0.8) conviction -= 0.3;

  if (roc > 3) conviction += 0.3;
  else if (roc < -3) conviction -= 0.3;

  conviction = conviction * volAdjustment;
  conviction = Math.max(-1, Math.min(1, conviction));

  return {
    conviction,
    rsi,
    bollingerPercentB: bb ? bb.percentB : 0.5,
    roc,
    rawVolatility: rawVol,
    filteredVolatility: filteredVol,
    volAdjustment,
    signals: { insufficientData: false },
    interpretation: conviction > 0.3 ? 'BULLISH_ALPHA' : 
                    conviction < -0.3 ? 'BEARISH_OR_OVERBOUGHT' : 'NEUTRAL'
  };
}