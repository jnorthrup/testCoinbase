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