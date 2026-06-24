// src/worm/estimation/kalman.mjs
// Kalman Filter (Kálmán, 1960) for recursive slippage/thresh estimation
// Replaces heuristic metrics with optimal recursive Bayesian estimation.
// State: [slip]
// Measurement: observed slippage from fills
// Process noise: Q (how much slip can change per tick)
// Measurement noise: R (variance of fill observations)

class KalmanFilter1D {
  constructor({ q = 1e-6, r = 1e-4, x0 = 0.001, p0 = 0.01 } = {}) {
    this.x = x0;
    this.P = p0;
    this.Q = q;
    this.R = r;
    this.initialized = false;
    this.n = 0;
    this.innovations = [];
  }

  predict() {
    this.P = this.P + this.Q;
    return this.x;
  }

  update(z) {
    if (!this.initialized) {
      this.x = z;
      this.initialized = true;
      this.n = 1;
      return this.x;
    }

    const y = z - this.x;
    const S = this.P + this.R;
    const K = this.P / S;
    this.x = this.x + K * y;
    this.P = (1 - K) * this.P;

    this.innovations.push(y);
    if (this.innovations.length > 100) this.innovations.shift();

    this.n++;
    return this.x;
  }

  step(z) {
    this.predict();
    return this.update(z);
  }

  getState() {
    return {
      estimate: this.x,
      variance: this.P,
      stddev: Math.sqrt(this.P),
      measurements: this.n,
      initialized: this.initialized,
    };
  }

  getConfidenceInterval(z = 1.96) {
    return {
      lower: this.x - z * Math.sqrt(this.P),
      upper: this.x + z * Math.sqrt(this.P),
    };
  }

  reset(x0, p0) {
    this.x = x0;
    this.P = p0;
    this.initialized = false;
    this.n = 0;
    this.innovations = [];
  }
}

class MultiAssetKalman {
  constructor(defaults = {}) {
    this.filters = new Map();
    this.defaults = { q: 1e-6, r: 1e-4, x0: 0.001, p0: 0.01, ...defaults };
  }

  getFilter(symbol) {
    if (!this.filters.has(symbol)) {
      this.filters.set(symbol, new KalmanFilter1D(this.defaults));
    }
    return this.filters.get(symbol);
  }

  observe(symbol, observedSlip) {
    const filter = this.getFilter(symbol);
    return filter.step(observedSlip);
  }

  estimate(symbol) {
    const filter = this.getFilter(symbol);
    return filter.getState();
  }

  confidence(symbol, z = 1.96) {
    const filter = this.getFilter(symbol);
    return filter.getConfidenceInterval(z);
  }

  cap(symbol, floor = 0.01, ceiling = 0.10) {
    const { estimate, stddev } = this.getFilter(symbol).getState();
    const cap = Math.min(ceiling, Math.max(floor, estimate + 3 * stddev));
    return cap;
  }

  record(symbol, observedSlip) {
    const filter = this.getFilter(symbol);
    const before = filter.getState();
    const estimate = filter.step(observedSlip);
    const after = filter.getState();

    return {
      observed: observedSlip,
      estimated: estimate,
      capped: Math.min(this.cap(symbol), observedSlip),
      truncated: observedSlip > this.cap(symbol),
      priorVariance: before.variance,
      posteriorVariance: after.variance,
      kalmanGain: (before.variance - after.variance) / before.variance,
    };
  }

  driftTest(symbol, window = 20) {
    const filter = this.filters.get(symbol);
    if (!filter || !filter.innovations || filter.innovations.length < window) {
      return { healthy: true, reason: 'insufficient_data' };
    }
    const recent = filter.innovations.slice(-window);
    const meanInnovation = recent.reduce((a, b) => a + b, 0) / recent.length;
    const innovationVar = recent.reduce((a, b) => a + (b - meanInnovation) ** 2, 0) / recent.length;

    const threshold = 2 * Math.sqrt(innovationVar / recent.length);
    const healthy = Math.abs(meanInnovation) < threshold;

    return {
      healthy,
      meanInnovation,
      innovationStddev: Math.sqrt(innovationVar),
      threshold,
      window,
      reason: healthy ? 'innovations_zero_mean' : 'innovations_biased',
    };
  }

  /**
   * Classify the symbol's recent volatility regime by comparing the latest
   * innovations-variance to the historical innovations-variance. Returns one of:
   *   'STABLE'      — variance in line with historical mean (within band)
   *   'COMPRESSING' — variance contracting (current < historical - band)
   *   'EXPANDING'   — variance expanding (current > historical + band)
   * If fewer than `minPoints` innovations are available, returns the prior
   * classification (or 'STABLE' on first call).
   */
  classifyRegime(symbol, halfWindow = 10, transitionBand = 1.5, minPoints = 20) {
    const filter = this.filters.get(symbol);
    if (!filter || !filter.innovations || filter.innovations.length < minPoints) {
      return filter && filter._lastRegime ? filter._lastRegime : 'STABLE';
    }
    const all = filter.innovations;
    const recent = all.slice(-halfWindow);
    const historic = all.slice(-halfWindow * 2, -halfWindow);
    if (historic.length < 2) {
      return filter._lastRegime || 'STABLE';
    }
    const varianceOf = (xs) => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;
    };
    const recentVar = varianceOf(recent);
    const historicVar = varianceOf(historic);
    let regime;
    if (recentVar < historicVar / transitionBand) regime = 'COMPRESSING';
    else if (recentVar > historicVar * transitionBand) regime = 'EXPANDING';
    else regime = 'STABLE';
    filter._lastRegime = regime;
    return regime;
  }

  /**
   * Serialize the per-symbol filter state so volatility survives across engine reconstruction.
   * Returns a plain object suitable for JSON.stringify.
   */
  serialize() {
    const out = {};
    for (const [symbol, filter] of this.filters) {
      out[symbol] = {
        x: filter.x,
        P: filter.P,
        initialized: filter.initialized,
        n: filter.n,
        lastRegime: filter._lastRegime || 'STABLE',
      };
    }
    return out;
  }

  /**
   * Restore serialized filter state from a prior `serialize()` round-trip.
   * Filters whose symbol is not present in `state` get a fresh initialization
   * on first use; filters present get their x / P / n / regime advanced.
   */
  restore(state) {
    if (!state || typeof state !== 'object') return;
    for (const [symbol, f] of Object.entries(state)) {
      const filter = this.getFilter(symbol);
      filter.x = Number.isFinite(f.x) ? f.x : this.defaults.x0;
      filter.P = Number.isFinite(f.P) && f.P > 0 ? f.P : this.defaults.p0;
      filter.initialized = Boolean(f.initialized);
      filter.n = Number.isFinite(f.n) && f.n > 0 ? f.n : 0;
      filter._lastRegime = typeof f.lastRegime === 'string' ? f.lastRegime : 'STABLE';
    }
  }
}

function kalmanSlipCap(filter, symbol, floor = 0.01, ceiling = 0.10) {
  return filter.cap(symbol, floor, ceiling);
}

function kalmanHarvestThreshold(kalman, symbol, baselineUsd, targetUsdProfit) {
  const { estimate, stddev } = kalman.estimate(symbol);
  const conservativeSlip = estimate + 2 * stddev;
  const thresholdPct = (targetUsdProfit / baselineUsd) + conservativeSlip;
  return thresholdPct;
}

function kalmanCrashFund(kalman, symbols, minSpawnCostUsd, spawnBufferCount, totalPortfolioUsd, maxDrawdownPct) {
  const fromSpawning = minSpawnCostUsd * spawnBufferCount;
  const fromDrawdown = totalPortfolioUsd * maxDrawdownPct;
  const uncertaintyBuffer = symbols.reduce((sum, sym) => {
    const { estimate, stddev } = kalman.estimate(sym);
    return sum + (estimate + 3 * stddev) * minSpawnCostUsd;
  }, 0);
  return Math.max(fromSpawning, fromDrawdown) + uncertaintyBuffer;
}

export { KalmanFilter1D, MultiAssetKalman, kalmanSlipCap, kalmanHarvestThreshold, kalmanCrashFund };

// Kelly-sized spawn cost.
// f* = kellyFraction from TradeHistoryAnalyzer (null = no data yet).
// Falls back to minSpawnCostUsd when data is insufficient.
// Half-Kelly is already enforced in TradeHistoryAnalyzer.kellyFraction (cap 0.25).
// @param {number|null} kellyFraction   — f* from TradeHistoryAnalyzer, or null
// @param {number}      totalPortfolioUsd
// @param {number}      minSpawnCostUsd  — hard floor (e.g. 30)
// @param {number}      maxSpawnCostUsd  — hard ceiling (e.g. 500)
export function kellySpawnCost(kellyFraction, totalPortfolioUsd, minSpawnCostUsd = 30, maxSpawnCostUsd = 500) {
  // Bootstrap fallback: no history yet — use 1% of portfolio (conservative but portfolio-scaled).
  // Never a flat $30 constant — that makes spawn size independent of capital size.
  const effectiveFraction = (kellyFraction === null || kellyFraction <= 0)
    ? 0.01
    : kellyFraction;
  if (totalPortfolioUsd <= 0) return minSpawnCostUsd;
  const raw = effectiveFraction * totalPortfolioUsd;
  return Math.max(minSpawnCostUsd, Math.min(maxSpawnCostUsd, raw));
}