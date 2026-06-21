
// --- RegimeDetector (Embedded) ---
export class RegimeDetector {
  constructor() { this.regimes = {}; this.market24h = { gainers: [], losers: [] }; }
  analyze(symbol, history) {
    if (!history || history.length < 50) { this.regimes[symbol] = 'UNKNOWN'; return 'UNKNOWN'; }
    const currentPrice = history[history.length - 1];
    const startPrice = history[0];
    const roi = (currentPrice - startPrice) / startPrice;
    const mean = history.reduce((a, b) => a + b) / history.length;
    const variance = history.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / history.length;
    const volatility = Math.sqrt(variance) / mean;
    let regime = 'CRAB_CHOP';
    if (roi > 0.05 && volatility > 0.02) regime = 'BULL_RUSH';
    else if (roi < -0.05 && volatility > 0.02) regime = 'BEAR_CRASH';
    else if (roi > 0.02 && volatility < 0.01) regime = 'STEADY_GROWTH';
    else if (volatility > 0.05) regime = 'VOLATILE_CHOP';

    if (this.regimes[symbol] !== regime) {
      console.log(`🔮 [Regime] ${symbol} Change: ${this.regimes[symbol] || 'INIT'} -> ${regime} (Vol: ${(volatility * 100).toFixed(2)}%)`);
    }
    this.regimes[symbol] = regime;
    return regime;
  }
  update(symbol, price, timestamp) {
    // Maintained history buffer could go here if we wanted fully self-contained detector state
    // For now relying on analyze() being called with history
  }
  updateMarket24h(gainers, losers) {
    this.market24h = { gainers, losers, updatedAt: Date.now() };
    // Log top movers for regime awareness
    if (gainers.length > 0) console.log(`📈 24h Gainers: ${gainers.map(g => `${g.symbol} ${g.change24h.toFixed(2)}%`).join(', ')}`);
    if (losers.length > 0) console.log(`📉 24h Losers: ${losers.map(l => `${l.symbol} ${l.change24h.toFixed(2)}%`).join(', ')}`);
  }
  getRegime(symbol) { return this.regimes[symbol] || 'UNKNOWN'; }
  getMarket24h() { return this.market24h; }
}
