// src/worm/regime/regime-genome-manager.mjs
// Manages loading and persisting regime-specific optimal genomes.
// Works together with ScientificOptimizer and AssetRegimeManager.

import fs from 'fs';
import path from 'path';

export class RegimeGenomeManager {
  constructor(options = {}) {
    this.filePath = options.filePath || path.join(process.cwd(), 'configs', 'regime_genomes.json');
    this.genomes = {};
    this.load();
  }

  load() {
    if (fs.existsSync(this.filePath)) {
      try {
        this.genomes = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        console.log(`[RegimeGenomeManager] Loaded regime genomes for ${Object.keys(this.genomes).length} symbols`);
      } catch (e) {
        console.error('Failed to load regime_genomes.json', e);
        this.genomes = {};
      }
    }
  }

  async save() {
    try {
      const dir = path.dirname(this.filePath);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(this.filePath, JSON.stringify(this.genomes, null, 2));
    } catch (e) {
      console.error('Failed to save regime_genomes.json', e);
    }
  }

  async updateGenome(symbol, regime, genomeSlice) {
    if (!this.genomes[symbol]) {
      this.genomes[symbol] = {};
    }
    this.genomes[symbol][regime] = {
      ...genomeSlice,
      updatedAt: Date.now()
    };
    await this.save();
    console.log(`[RegimeGenomeManager] Updated ${symbol} → ${regime}`);
  }

  getGenome(symbol, regime) {
    return this.genomes[symbol]?.[regime] || null;
  }

  getAllRegimesForSymbol(symbol) {
    return this.genomes[symbol] || {};
  }
}
