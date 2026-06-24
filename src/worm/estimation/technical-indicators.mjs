// src/worm/estimation/technical-indicators.mjs

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

export function calculateAlphaConviction(prices, options = {}) {
  if (!prices || prices.length < 20) {
    return { conviction: 0, insufficientData: true };
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

  if (bb.percentB < 0.2) conviction += 0.3;
  else if (bb.percentB > 0.8) conviction -= 0.3;

  if (roc > 3) conviction += 0.3;
  else if (roc < -3) conviction -= 0.3;

  conviction = conviction * volAdjustment;
  conviction = Math.max(-1, Math.min(1, conviction));

  return {
    conviction,
    rsi,
    bollingerPercentB: bb.percentB,
    roc,
    rawVolatility: rawVol,
    filteredVolatility: filteredVol,
    volAdjustment,
    insufficientData: false
  };
}

export function calculateRSI(prices, period = 14) { /* existing */ }
export function calculateBollingerBands(prices, period = 20, stdDev = 2) { /* existing */ }
export function calculateROC(prices, period = 10) { /* existing */ }