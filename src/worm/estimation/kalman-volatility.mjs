// src/worm/estimation/kalman-volatility.mjs
// 1D Kalman Filter for estimating latent volatility from noisy realized volatility observations.
// Useful for smoothing volatility estimates and adapting to regime changes in volatility.

export class KalmanVolatilityFilter {
  constructor(options = {}) {
    // State estimate (current volatility)
    this.x = options.initialVolatility || 0.02; // starting guess (e.g. 2% daily vol)

    // Estimate uncertainty
    this.P = options.initialUncertainty || 0.01;

    // Process noise (how much we expect volatility to change between steps)
    this.Q = options.processNoise || 0.0001;

    // Measurement noise (how noisy our realized volatility observation is)
    this.R = options.measurementNoise || 0.005;

    this.initialized = false;
  }

  /**
   * Update the filter with a new realized volatility observation.
   * @param {number} realizedVol - Newly calculated realized volatility
   * @returns {number} - Filtered (smoothed) volatility estimate
   */
  update(realizedVol) {
    if (!this.initialized) {
      this.x = realizedVol;
      this.initialized = true;
      return this.x;
    }

    // Prediction step
    const x_pred = this.x;
    const P_pred = this.P + this.Q;

    // Update step (Kalman Gain)
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