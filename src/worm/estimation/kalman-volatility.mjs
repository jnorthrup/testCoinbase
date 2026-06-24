// src/worm/estimation/kalman-volatility.mjs
// 1D Kalman Filter for estimating latent volatility from noisy realized volatility observations.
// Useful for smoothing volatility estimates and adapting to regime changes in volatility.

export class KalmanVolatilityFilter {
  constructor(options = {}) {
    this.x = options.initialVolatility || 0.02;
    this.P = options.initialUncertainty || 0.01;
    this.Q = options.processNoise || 0.0001;
    this.R = options.measurementNoise || 0.005;
    this.initialized = false;
  }

  update(realizedVol) {
    if (!this.initialized) {
      this.x = realizedVol;
      this.initialized = true;
      return this.x;
    }

    const x_pred = this.x;
    const P_pred = this.P + this.Q;

    const K = P_pred / (P_pred + this.R);
    this.x = x_pred + K * (realizedVol - x_pred);
    this.P = (1 - K) * P_pred;

    return this.x;
  }

  getEstimate() {
    return this.x;
  }

  reset(initialVolatility = 0.02) {
    this.x = initialVolatility;
    this.P = 0.01;
    this.initialized = false;
  }
}