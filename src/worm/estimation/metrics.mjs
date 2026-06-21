// src/worm/estimation/metrics.mjs
// Value-grounded metric functions that replace scalar-constant guesses.
// Each metric takes observable state and returns a derived value.
// The relationships are explicit: state in, value out.

import { SLIPPAGE_BUFFERS } from '../config/constants.mjs';

// =====================================================================
// 1. SLIPPAGE: derived from real spread (REST /products/<id>/book)
// =====================================================================

/**
 * Compute expected slippage for a product from its order book spread.
 * Replaces SLIPPAGE_BUFFERS[symbol]?.sell scalar guess.
 *
 * @param {Object} book - { best_bid, best_ask, bids: [[price, size]...], asks: [[price, size]...] }
 * @param {string} side - 'buy' | 'sell'
 * @param {number} orderSizeUsd - size of the order in USD (impacts walk through book)
 * @returns {number} expected slippage as a fraction (e.g. 0.0005 = 5 bps)
 */
export function metricSlippageFromBook(book, side, orderSizeUsd) {
  if (!book || !book.bids || !book.asks) return null;
  const bestBid = parseFloat(book.bids[0]?.[0] ?? book.best_bid);
  const bestAsk = parseFloat(book.asks[0]?.[0] ?? book.best_ask);
  if (!isFinite(bestBid) || !isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) return null;

  const mid = (bestBid + bestAsk) / 2;
  const halfSpread = (bestAsk - bestBid) / 2;
  const baseSlip = halfSpread / mid; // crossing the spread alone

  // Walk the book to estimate impact of orderSizeUsd
  const levels = side === 'buy' ? book.asks : book.bids;
  let remaining = orderSizeUsd;
  let filled = 0;
  let vwap = 0;
  for (const [priceStr, sizeStr] of levels) {
    const price = parseFloat(priceStr);
    const size = parseFloat(sizeStr);
    const levelUsd = price * size;
    const take = Math.min(remaining, levelUsd);
    vwap += price * (take / price); // = take
    filled += take;
    remaining -= take;
    if (remaining <= 0) break;
  }
  if (filled <= 0) return baseSlip;
  vwap = vwap / (filled / (side === 'buy' ? bestAsk : bestBid));
  // Impact = (vwap - mid) / mid, signed by side
  const impact = side === 'buy' ? (vwap - mid) / mid : (mid - vwap) / mid;
  // Total expected slip = base crossing + impact
  return Math.max(0, baseSlip + impact);
}

/**
 * Fallback: derive slippage from observed fill history.
 * Uses rolling median + 1.5 * IQR (Tukey's fence) for robustness.
 *
 * @param {Array<{slip: number}>} fillHistory - last N fills, each with `slip` field
 * @returns {number} expected slippage
 */
export function metricSlippageFromHistory(fillHistory) {
  if (!fillHistory || fillHistory.length === 0) return null;
  const slips = fillHistory.map(f => f.slip).filter(s => isFinite(s) && s >= 0);
  if (slips.length === 0) return null;
  const sorted = [...slips].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const median = sorted[Math.floor(sorted.length * 0.5)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  // Use median + 1.5*IQR as conservative upper bound; floor at 0
  return Math.max(0, median + 1.5 * iqr);
}

/**
 * Composite: use book if available, else history, else null.
 * Never returns a scalar guess. Caller must handle null.
 */
export function metricSlippage({ book, fillHistory, side, orderSizeUsd }) {
  const fromBook = metricSlippageFromBook(book, side, orderSizeUsd);
  if (fromBook !== null) return fromBook;
  return metricSlippageFromHistory(fillHistory);
}

/**
 * Cap slippage using observed fill variance (not a scalar 0.04).
 * cap = clamp(median + 3 * stddev, floor, ceiling)
 */
export function metricSlippageCap(fillHistory, floor = 0.01, ceiling = 0.10) {
  if (!fillHistory || fillHistory.length < 3) return ceiling; // not enough data, use ceiling
  const slips = fillHistory.map(f => f.slip).filter(s => isFinite(s) && s >= 0);
  if (slips.length < 3) return ceiling;
  const mean = slips.reduce((a, b) => a + b, 0) / slips.length;
  const stddev = Math.sqrt(slips.reduce((a, b) => a + (b - mean) ** 2, 0) / slips.length);
  const median = [...slips].sort((a, b) => a - b)[Math.floor(slips.length / 2)];
  const cap = Math.min(ceiling, Math.max(floor, median + 3 * stddev));
  return cap;
}

// =====================================================================
// 2. THRESHOLDS: derived from value, not scalar
// =====================================================================

/**
 * Harvest trigger threshold as a function of baseline and target USD profit.
 * Replaces FLAT_HARVEST_TRIGGER_PERCENT = 0.035 scalar.
 *
 * thresholdPct = targetUsdProfit / baselineUsd
 *
 * @param {number} baselineUsd - the asset's baseline value in USD
 * @param {number} targetUsdProfit - the USD profit target
 * @returns {number} threshold as a fraction
 */
export function metricHarvestThresholdPct(baselineUsd, targetUsdProfit) {
  if (baselineUsd <= 0 || targetUsdProfit <= 0) return 0;
  return targetUsdProfit / baselineUsd;
}

/**
 * Rebalance threshold from target USD recovery amount.
 * Replaces FLAT_REBALANCE_TRIGGER_PERCENT = 0.035 scalar.
 */
export function metricRebalanceThresholdPct(baselineUsd, targetUsdRecovery) {
  return metricHarvestThresholdPct(baselineUsd, targetUsdRecovery);
}

// =====================================================================
// 3. CRASH FUND: derived from real capacity requirements
// =====================================================================

/**
 * Required cash reserve as max of:
 *   - N * MIN_SPAWN_COST_USD (always able to spawn N more)
 *   - K * expectedDrawdownUsd (survive K% drop with no action)
 * Replaces CRASH_FUND_THRESHOLD_PERCENT = 0.10 scalar.
 *
 * @param {number} minSpawnCostUsd
 * @param {number} spawnBufferCount
 * @param {number} totalPortfolioUsd
 * @param {number} maxDrawdownPct
 * @returns {number} required cash reserve in USD
 */
export function metricCrashFundUsd({
  minSpawnCostUsd = 30,
  spawnBufferCount = 5,
  totalPortfolioUsd,
  maxDrawdownPct = 0.10,
}) {
  const fromSpawning = minSpawnCostUsd * spawnBufferCount;
  const fromDrawdown = totalPortfolioUsd * maxDrawdownPct;
  return Math.max(fromSpawning, fromDrawdown);
}

// =====================================================================
// 4. RATCHET: derived from USD profit cumulative
// =====================================================================

/**
 * Promotion threshold: cumulative USD profit after fees must exceed a floor.
 * Replaces MIN_TRADES_FOR_PROMOTION = 1, EVOLUTION_CONSISTENCY_COUNT = 3.
 *
 * @param {Array<{pnlUsd: number}>} tradeHistory
 * @param {number} minCumulativeUsd
 * @param {number} minWinStreak
 * @returns {boolean} whether the genome should be promoted
 */
export function metricPromotionEligible(tradeHistory, minCumulativeUsd = 1.0, minWinStreak = 3) {
  if (!tradeHistory || tradeHistory.length === 0) return false;
  const cumulative = tradeHistory.reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
  if (cumulative < minCumulativeUsd) return false;
  // Check trailing win streak in USD terms (positive after fees)
  let streak = 0;
  for (let i = tradeHistory.length - 1; i >= 0; i--) {
    if ((tradeHistory[i].pnlUsd || 0) > 0) streak++;
    else break;
  }
  return streak >= minWinStreak;
}

// =====================================================================
// 5. SPAWN CAPACITY: derived metric, not implicit
// =====================================================================

/**
 * Number of additional spawns possible given current state.
 * Exposes a previously implicit relationship.
 *
 * @param {number} cashBalance
 * @param {number} crashFundUsd
 * @param {number} minSpawnCostUsd
 * @returns {number} count of additional spawns
 */
export function metricSpawnCapacity(cashBalance, crashFundUsd, minSpawnCostUsd) {
  const available = Math.max(0, cashBalance - crashFundUsd);
  if (minSpawnCostUsd <= 0) return 0;
  return Math.floor(available / minSpawnCostUsd);
}

// =====================================================================
// 6. CASH/PORTFOLIO RATIOS: explicit decision inputs
// =====================================================================

export function metricCashRatio(cashUsd, portfolioUsd) {
  if (portfolioUsd <= 0) return 0;
  return cashUsd / portfolioUsd;
}

export function metricDeployedRatio(cashUsd, portfolioUsd) {
  return 1 - metricCashRatio(cashUsd, portfolioUsd);
}

// =====================================================================
// 7. DRIFT: observed vs assumed, with cap
// =====================================================================

/**
 * Record an observed fill and produce both the observed and capped slippage.
 * Replaces the silent `Math.min(0.04, Math.max(0, slippage))` truncation.
 *
 * @param {number} observedSlip - the actual measured slip
 * @param {number} cap - from metricSlippageCap()
 * @returns {{observed: number, capped: number, truncated: boolean, reason: string}}
 */
export function metricRecordSlippage(observedSlip, cap) {
  const safeObserved = Math.max(0, observedSlip);
  const capped = Math.min(cap, safeObserved);
  return {
    observed: safeObserved,
    capped,
    truncated: safeObserved > cap,
    reason: safeObserved > cap ? 'exceeds_observed_cap' : 'within_band',
    cap,
  };
}

// =====================================================================
// 8. SPAR DRAG: derived from volatility, not scalar 0.999968
// =====================================================================

/**
 * Baseline drag coefficient from recent volatility.
 * Higher volatility -> more drag (faster baseline decay).
 * Replaces SPAR_DRAG_COEFFICIENT = 0.999968.
 *
 * @param {Array<number>} recentPrices - last N prices
 * @returns {number} drag coefficient (0.99 - 1.0 range, closer to 1.0 = less drag)
 */
/**
 * Kalman baseline update. Single source of truth for both the live engine
 * and the Dreamer fitness scoring. Subsumes the obsolete EWMA
 * `SPAR_DRAG_COEFFICIENT` scalar.
 *
 * Predict:
 *   P_pred = P_prev + Q
 * Update:
 *   K    = P_pred / (P_pred + R)
 *   x_new = x_pred + K * (z - x_pred)
 *   P_new = (1 - K) * P_pred
 *
 * @param {Object} state - { baseline, p }
 * @param {number} observation - the trusted/untrusted observation (e.g. mid, fill)
 * @param {number} q - process noise (variance of dynamics), 1e-6 to 1e-1
 * @param {number} r - measurement noise (variance of observation), 1e-3 to 10
 * @returns {{baseline:number, p:number, gain:number, residual:number}}
 */
export function metricKalmanBaseline(state, observation, q, r) {
  const baseline = state && typeof state.baseline === 'number' ? state.baseline : observation;
  const pPrev = state && typeof state.p === 'number' && state.p > 0 ? state.p : Math.max(q, 1e-6);

  // Predict
  const pPred = pPrev + q;

  // Update
  const denom = pPred + r;
  const gain = denom > 0 ? pPred / denom : 0;
  const residual = observation - baseline;
  const newBaseline = baseline + gain * residual;
  const newP = (1 - gain) * pPred;

  return {
    baseline: newBaseline,
    p: newP,
    gain,
    residual,
  };
}

/**
 * Q from observed volatility. Thin wrapper that delegates to the Kalman
 * metric when possible; returns a scalar fall-back when fewer than 10
 * samples are present.
 *
 * @param {Array<number>} recentPrices - last N prices
 * @returns {number} process noise estimate (variance of returns, not 1-drag)
 */
export function metricBaselineDrag(recentPrices) {
  if (!recentPrices || recentPrices.length < 10) return 0.999968;
  const returns = [];
  for (let i = 1; i < recentPrices.length; i++) {
    if (recentPrices[i - 1] > 0) {
      returns.push(Math.abs(Math.log(recentPrices[i] / recentPrices[i - 1])));
    }
  }
  if (returns.length === 0) return 0.999968;
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  // Map mean abs log-return to drag: vol 0.01 -> 0.9999 ; vol 0.05 -> 0.998
  const drag = 1 - (meanReturn * 0.5);
  return Math.max(0.99, Math.min(0.99999, drag));
}

// =====================================================================
// 8. BASELINE RESIDUAL ORACLE: single bridge between Dreamer + live engine
// =====================================================================

/**
 * Average absolute residual of a baseline track against the price walk.
 * Dreamer fitness scoring uses this to penalize genomes whose baseline
 * dynamics diverge from observed prices — even if ROI is high.
 *
 * This is the DRY bridge: the same `metricKalmanBaseline` instance runs
 * in both the live engine and the shadow simulation; this oracle reports
 * how well that consensus matches the actual price walk.
 *
 * @param {Array<{baseline:number, observation:number}>} trace - one entry per cycle
 * @returns {{meanAbsResidual:number, p95:number, count:number}}
 */
export function metricBaselineResidual(trace) {
  if (!trace || trace.length === 0) {
    return { meanAbsResidual: 0, p95: 0, count: 0 };
  }
  const residuals = [];
  for (const t of trace) {
    if (typeof t.observation === 'number' && typeof t.baseline === 'number' && t.observation > 0) {
      residuals.push(Math.abs(t.baseline - t.observation) / t.observation);
    }
  }
  if (residuals.length === 0) return { meanAbsResidual: 0, p95: 0, count: 0 };
  residuals.sort((a, b) => a - b);
  const mean = residuals.reduce((a, b) => a + b, 0) / residuals.length;
  const p95 = residuals[Math.floor(residuals.length * 0.95)];
  return { meanAbsResidual: mean, p95, count: residuals.length };
}

// =====================================================================
// 9. CRASH PROTECTION: -7% expressed in USD per asset
// =====================================================================

/**
 * Crash trigger threshold as USD loss per asset.
 * Replaces CP_TRIGGER_MIN_NEGATIVE_DEV_PERCENT = -0.07 scalar.
 *
 * @param {number} baselineUsd
 * @param {number} crashPct - e.g. 0.07 for 7%
 * @returns {number} USD loss threshold (negative number)
 */
export function metricCrashTriggerUsd(baselineUsd, crashPct = 0.07) {
  return -(baselineUsd * crashPct);
}

// =====================================================================
// 10. EFFECTIVE PRICE: from REST, not fallback
// =====================================================================

/**
 * Build a verified order result. If verification is missing, mark unverified.
 * Replaces the silent fallback to expectedPrice.
 *
 * @param {Object} resp - REST /orders/<id> response
 * @param {number} expectedPrice - what we expected to fill at
 * @returns {{average_price: number|null, settled: boolean, verified: boolean, source: string}}
 */
export function metricVerifiedFill(resp, expectedPrice) {
  if (!resp) {
    return { average_price: null, settled: false, verified: false, source: 'no_response' };
  }
  const orderId = resp.order_id || resp.id;
  if (!orderId) {
    return { average_price: null, settled: false, verified: false, source: 'no_order_id' };
  }
  // Coinbase order response: filled_value, average_price, total_fees after settled
  const avgPrice = parseFloat(resp.average_price || resp.execution?.avg_price);
  const settled = resp.settled === true || resp.status === 'FILLED' || resp.status === 'COMPLETED';
  if (!isFinite(avgPrice) || avgPrice <= 0) {
    return {
      average_price: null,
      settled,
      verified: settled,
      source: settled ? 'settled_no_price' : 'unverified',
    };
  }
  return {
    average_price: avgPrice,
    settled,
    verified: settled,
    source: 'rest_confirmed',
  };
}

// =====================================================================
// 11. GLOBAL: drift oracle
// =====================================================================

/**
 * Compare rolling assumed vs actual slippage distribution.
 * Replaces the silent `lastSlippage` decay.
 *
 * @param {Array<{assumed: number, actual: number}>} history
 * @returns {{meanAssumed: number, meanActual: number, driftPct: number, healthy: boolean}}
 */
export function metricDriftOracle(history) {
  if (!history || history.length === 0) {
    return { meanAssumed: 0, meanActual: 0, driftPct: 0, healthy: true, sampleSize: 0 };
  }
  const meanA = history.reduce((s, r) => s + r.assumed, 0) / history.length;
  const meanX = history.reduce((s, r) => s + r.actual, 0) / history.length;
  const driftPct = meanA > 0 ? (meanX - meanA) / meanA : 0;
  // Healthy if drift is within +/- 30% (configurable)
  const healthy = Math.abs(driftPct) < 0.30;
  return {
    meanAssumed: meanA,
    meanActual: meanX,
    driftPct,
    healthy,
    sampleSize: history.length,
  };
}