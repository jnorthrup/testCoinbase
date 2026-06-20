import fs from 'fs';
import path from 'path';

class AssetRegimeManager {
  constructor(options = {}) {
    this.memoryFile = options.memoryFile || path.join(process.cwd(), 'configs', 'asset_regime_memory.json');
    this.memory = {};
    this.load();
  }

  load() {
    if (fs.existsSync(this.memoryFile)) {
      try {
        this.memory = JSON.parse(fs.readFileSync(this.memoryFile, 'utf-8'));
        console.log(`🧠 [Memory] Loaded Asset Regimes for ${Object.keys(this.memory).length} assets.`);
      } catch (e) {
        console.error('❌ Failed to load asset_regime_memory.json', e);
        this.memory = {};
      }
    } else {
      this.save();
    }
  }

  async save() {
    try {
      const dir = path.dirname(this.memoryFile);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(this.memoryFile, JSON.stringify(this.memory, null, 2));
    } catch (e) {
      console.error('❌ Failed to save asset_regime_memory.json', e);
    }
  }

  getProfile(symbol) {
    return this.memory[symbol] || null;
  }

  async update(symbol, genomeSlice, tier, regime = 'UNKNOWN') {
    if (!this.memory[symbol]) {
      this.memory[symbol] = {
        activeRegime: regime,
        tiers: {
          TIER_0_FACTORY: {},
          TIER_1_THEORETICAL: null,
          TIER_2_VERIFIED: null,
        },
      };
    }

    const entry = { timestamp: Date.now(), regime, config: genomeSlice };
    this.memory[symbol].tiers[tier] = entry;
    this.memory[symbol].activeRegime = regime;
    await this.save();
  }
}

class RegimeDetector {
  constructor() {
    this.regimes = {};
  }

  analyze(symbol, history) {
    if (!history || history.length < 50) {
      this.regimes[symbol] = 'UNKNOWN';
      return 'UNKNOWN';
    }

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
    void symbol;
    void price;
    void timestamp;
  }

  getRegime(symbol) {
    return this.regimes[symbol] || 'UNKNOWN';
  }
}

export { AssetRegimeManager, RegimeDetector };
