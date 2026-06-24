// src/worm/estimation/quant-discriminators.mjs
// Institutional-grade quantitative discriminators for the Inductive Math Oracle.

/**
 * 1. Microstructural Drift (μ_obi) via Order Book Imbalance
 * Calculates the depth imbalance between bids and asks.
 * +1.0 = 100% bids (extreme bullish micro-structure)
 * -1.0 = 100% asks (extreme bearish micro-structure)
 *
 * @param {Object} book - { bids: [[price, size]...], asks: [[price, size]...] }
 * @param {number} depthLevels - How many levels deep to calculate
 * @returns {number} Imbalance from -1.0 to 1.0
 */
export function calculateOrderBookImbalance(book, depthLevels = 10) {
  if (!book || !book.bids || !book.asks || book.bids.length === 0 || book.asks.length === 0) {
    return 0; // Neutral if no data
  }

  let bidVolume = 0;
  let askVolume = 0;

  const bidLimit = Math.min(book.bids.length, depthLevels);
  for (let i = 0; i < bidLimit; i++) {
    const price = parseFloat(book.bids[i][0]);
    const size = parseFloat(book.bids[i][1]);
    bidVolume += price * size; // Volume in quote currency
  }

  const askLimit = Math.min(book.asks.length, depthLevels);
  for (let i = 0; i < askLimit; i++) {
    const price = parseFloat(book.asks[i][0]);
    const size = parseFloat(book.asks[i][1]);
    askVolume += price * size;
  }

  const totalVolume = bidVolume + askVolume;
  if (totalVolume === 0) return 0;

  return (bidVolume - askVolume) / totalVolume;
}

/**
 * 2. Asymmetric Risk (σ²_down) via Downside Semi-Variance
 * Standard variance penalizes assets for upside breakouts.
 * This measures variance strictly on the downside.
 *
 * @param {Array<number>} prices - Chronological array of prices
 * @param {number} targetReturn - The threshold for 'downside' (usually 0)
 * @returns {number} Downside semi-variance
 */
export function calculateDownsideSemiVariance(prices, targetReturn = 0) {
  if (!prices || prices.length < 2) return 0.0001; // Small non-zero fallback

  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) {
      returns.push(Math.log(prices[i] / prices[i - 1]));
    }
  }

  if (returns.length === 0) return 0.0001;

  let sumSquaredDownside = 0;
  let downsideCount = 0;

  for (const r of returns) {
    if (r < targetReturn) {
      sumSquaredDownside += Math.pow(r - targetReturn, 2);
      downsideCount++;
    }
  }

  // If no downside returns, variance is effectively tiny
  if (downsideCount === 0) return 0.00001;

  return sumSquaredDownside / downsideCount; // Semi-variance
}

/**
 * 3. Systemic Contagion (TD_btc) via Empirical Lower Tail-Dependence Copula
 * Measures the probability that the asset crashes GIVEN that the benchmark (BTC) crashes.
 * High tail dependence = dangerous, provides no diversification in a crash.
 *
 * @param {Array<number>} assetPrices - Asset price history
 * @param {Array<number>} benchmarkPrices - Benchmark (BTC) price history
 * @param {number} tailQuantile - e.g., 0.10 for the worst 10% of returns
 * @returns {number} Tail dependence coefficient (0.0 to 1.0)
 */
export function calculateTailDependence(assetPrices, benchmarkPrices, tailQuantile = 0.10) {
  if (!assetPrices || !benchmarkPrices || assetPrices.length !== benchmarkPrices.length || assetPrices.length < 10) {
    return 0.5; // Neutral fallback
  }

  const assetReturns = [];
  const benchReturns = [];

  for (let i = 1; i < assetPrices.length; i++) {
    if (assetPrices[i - 1] > 0 && benchmarkPrices[i - 1] > 0) {
      assetReturns.push(Math.log(assetPrices[i] / assetPrices[i - 1]));
      benchReturns.push(Math.log(benchmarkPrices[i] / benchmarkPrices[i - 1]));
    }
  }

  if (benchReturns.length === 0) return 0.5;

  // Find the threshold return for the benchmark's worst tail
  const sortedBench = [...benchReturns].sort((a, b) => a - b);
  const benchThreshold = sortedBench[Math.floor(sortedBench.length * tailQuantile)];

  // Find the threshold return for the asset's worst tail
  const sortedAsset = [...assetReturns].sort((a, b) => a - b);
  const assetThreshold = sortedAsset[Math.floor(sortedAsset.length * tailQuantile)];

  let totalBenchTailEvents = 0;
  let jointTailEvents = 0;

  for (let i = 0; i < benchReturns.length; i++) {
    if (benchReturns[i] <= benchThreshold) {
      totalBenchTailEvents++;
      // If benchmark is in its tail, is the asset also in its tail?
      if (assetReturns[i] <= assetThreshold) {
        jointTailEvents++;
      }
    }
  }

  if (totalBenchTailEvents === 0) return 0.5;
  
  // P(Asset Crashes | Bench Crashes)
  return jointTailEvents / totalBenchTailEvents;
}

/**
 * 4. Zero-Lag Momentum (μ_innov) via Kalman Innovations
 * The residual between the Kalman filter's prediction and the actual observation.
 * A positive innovation means the price is surprising the model to the upside.
 * 
 * @param {Object} kalmanEstimate - { estimate, variance } from the Kalman filter
 * @param {number} observation - The current actual price
 * @returns {number} Normalized innovation (z-score roughly)
 */
export function extractKalmanInnovation(kalmanEstimate, observation) {
  if (!kalmanEstimate || typeof kalmanEstimate.estimate !== 'number' || typeof kalmanEstimate.variance !== 'number') {
    return 0;
  }
  
  const predicted = kalmanEstimate.estimate;
  const stddev = Math.sqrt(kalmanEstimate.variance);
  
  if (stddev === 0) return 0;
  
  const residual = observation - predicted;
  
  // Normalize the innovation to a fractional drift proxy
  const normalizedSurprise = residual / predicted;
  
  return normalizedSurprise;
}
