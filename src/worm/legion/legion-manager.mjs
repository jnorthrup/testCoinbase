// --- LegionManager (Embedded) ---
import { EventEmitter } from 'events';
import {
  SLIPPAGE_BUFFERS, HARVEST_EXCLUDE, REBALANCE_EXCLUDE,
  SNOWBALL_CONFIG, defaultGenome, LEGION_CONFIG,
} from '../config/constants.mjs';
import { getMinOrderQtyMap } from '../utils/quantity.mjs';
import { getGenomicParam } from '../utils/helpers.mjs';
const MIN_ORDER_QTY_MAP = new Proxy({}, {
  get(_, k)  { return getMinOrderQtyMap()[k]; },
  ownKeys()  { return Object.keys(getMinOrderQtyMap()); },
  has(_, k)  { return k in getMinOrderQtyMap(); },
  getOwnPropertyDescriptor(_, k) { return Object.getOwnPropertyDescriptor(getMinOrderQtyMap(), k); },
});
export const MANAGER_CONFIG = {
  HEAT_CHECK_INTERVAL: 8000,
  CULL_THRESHOLD_HOURS: 4,
  STALE_GENOME_HOURS: 24,
  SWARM_SPREAD_PERCENT: 0.005,
};
export class LegionManager extends EventEmitter {
  constructor(liveEngine, TradingEngineClass, dreamerGrid) {
    super();
    this.liveEngine = liveEngine;
    this.TradingEngineClass = TradingEngineClass;
    this.dreamerGrid = dreamerGrid;
    this.shadowLegion = [];
    this.assetHeatMap = {};
    this.lastHeatCheck = 0;
    this.lastOptimizationRequest = {};
    this.activeDreamJobs = new Set();
  }
  async heartbeat(portfolioSummary, api) {
    const now = Date.now();
    if (now - this.lastHeatCheck < MANAGER_CONFIG.HEAT_CHECK_INTERVAL) return;
    this.updateHeatMap(portfolioSummary, api);
    this.reallocateLegion(portfolioSummary);
    await this.marchLegion(portfolioSummary);
    this.lastHeatCheck = now;
  }
  updateHeatMap(portfolioSummary, api) {
    portfolioSummary.forEach(row => {
      const sym = row.Symbol;
      const baseline = this.liveEngine.baselines[sym] || 0;
      if (baseline <= 0) { this.assetHeatMap[sym] = 'COLD'; return; }
      const deviation = Math.abs((row.Value - baseline) / baseline);
      const rSt = this.liveEngine.ratchetState[sym];
      const slipConfig = SLIPPAGE_BUFFERS[sym] || SLIPPAGE_BUFFERS.DEFAULT;
      const lastBuySlip = (rSt && rSt.lastSlippage !== undefined && rSt.lastSlippage !== null) ? rSt.lastSlippage : slipConfig.buy;
      const lastSellSlip = (rSt && rSt.lastSlippage !== undefined && rSt.lastSlippage !== null) ? rSt.lastSlippage : slipConfig.sell;

      const apiBuySlip = (api && api.lastSpreads && api.lastSpreads[sym]) ? api.lastSpreads[sym].buy : null;
      const apiSellSlip = (api && api.lastSpreads && api.lastSpreads[sym]) ? api.lastSpreads[sym].sell : null;
      const effectiveBuySlip = (apiBuySlip !== null) ? Math.max(apiBuySlip, lastBuySlip) : lastBuySlip;
      const effectiveSellSlip = (apiSellSlip !== null) ? Math.max(apiSellSlip, lastSellSlip) : lastSellSlip;

      const harvestTrig = this.liveEngine.genome.FLAT_HARVEST_TRIGGER_PERCENT + effectiveSellSlip;
      const rebalTrig = this.liveEngine.genome.FLAT_REBALANCE_TRIGGER_PERCENT + effectiveBuySlip;
      const triggerDist = Math.min(Math.abs(deviation - harvestTrig), Math.abs(deviation - rebalTrig));

      if (triggerDist < 0.005) this.assetHeatMap[sym] = 'INFERNO';
      else if (triggerDist < 0.02) this.assetHeatMap[sym] = 'HOT';
      else if (triggerDist < 0.05) this.assetHeatMap[sym] = 'WARM';
      else this.assetHeatMap[sym] = 'COLD';

      if (this.assetHeatMap[sym] === 'HOT' || this.assetHeatMap[sym] === 'INFERNO') {
        const lastReq = this.lastOptimizationRequest[sym] || 0;
        if (Date.now() - lastReq > 60 * 60 * 1000) {
          this.requestOptimization(sym);
          this.lastOptimizationRequest[sym] = Date.now();
        }
      }
    });
  }
  reallocateLegion(portfolioSummary) {
    // CULL
    const maxCapacity = LEGION_CONFIG.TOTAL_SHADOW_CAPACITY || 50;
    let shadowsToRemove = [];
    this.shadowLegion.forEach((shadow, index) => {
      const asset = shadow.assignedAsset;
      const heat = this.assetHeatMap[asset] || 'COLD';
      const ageHours = (Date.now() - shadow.startTime) / 3600000;
      const idleHours = (Date.now() - (shadow.lastTradeTime || shadow.startTime)) / 3600000;
      if (shadow.killMe) { shadowsToRemove.push(index); return; } // Handle self-termination
      if (idleHours > MANAGER_CONFIG.CULL_THRESHOLD_HOURS) { shadowsToRemove.push(index); return; }
      if (ageHours > MANAGER_CONFIG.STALE_GENOME_HOURS) { shadowsToRemove.push(index); return; }
      if (this.shadowLegion.length > maxCapacity * 0.9 && heat === 'COLD') {
        const brothers = this.shadowLegion.filter(s => s.assignedAsset === asset);
        if (brothers.length > (LEGION_CONFIG.PASSIVE_ASSET_MONITOR_COUNT || 5)) shadowsToRemove.push(index);
      }
    });
    shadowsToRemove.sort((a, b) => b - a).forEach(idx => {
      const trash = this.shadowLegion[idx];
      // 🧹 MEMORY LEAK FIX: Explicitly nullify heavy references
      trash.priceHistoryBuffer = null;
      trash.holdings = null;
      trash.genome = null;
      this.shadowLegion.splice(idx, 1);
    });

    // SPAWN
    const density = LEGION_CONFIG.ACTIVE_ASSET_SWARM_DENSITY || 10;
    Object.entries(this.assetHeatMap).forEach(([asset, heat]) => {
      if (heat === 'HOT' || heat === 'INFERNO') {
        const currentCount = this.shadowLegion.filter(s => s.assignedAsset === asset).length;
        const deficit = density - currentCount;
        if (deficit > 0) this.deploySwarm(asset, deficit, portfolioSummary);
      }
    });
  }
  deploySwarm(asset, count, portfolioSummary) {
    const baseGenome = { ...this.liveEngine.genome };
    const row = portfolioSummary ? portfolioSummary.find(r => r.Symbol === asset) : null;
    let sweepTarget = 'FLAT_HARVEST_TRIGGER_PERCENT';
    if (row && row.Baseline > 0) {
      const deviation = (row.Value - row.Baseline) / row.Baseline;
      if (deviation < 0) sweepTarget = 'FLAT_REBALANCE_TRIGGER_PERCENT';
    }
    const centerVal = this.getParam(baseGenome, sweepTarget, asset);
    const spreadStep = (MANAGER_CONFIG.SWARM_SPREAD_PERCENT * 2) / count;

    // console.log(`⚔️ Deploying Swarm for ${asset}. Sweeping ${sweepTarget}`);
    for (let i = 0; i < count; i++) {
      const offset = -MANAGER_CONFIG.SWARM_SPREAD_PERCENT + (i * spreadStep);
      const swarmGenome = {
        ...baseGenome,
        overrides: baseGenome.overrides ? JSON.parse(JSON.stringify(baseGenome.overrides)) : {}
      };
      if (!swarmGenome.overrides) swarmGenome.overrides = {};
      if (!swarmGenome.overrides[asset]) swarmGenome.overrides[asset] = {};
      swarmGenome.overrides[asset][sweepTarget] = centerVal + offset;

      const shadowHoldings = {};
      if (this.liveEngine.holdings && this.liveEngine.holdings[asset]) {
        shadowHoldings[asset] = JSON.parse(JSON.stringify(this.liveEngine.holdings[asset]));
      }
      const shadow = new this.TradingEngineClass(swarmGenome, 'SHADOW', this.liveEngine.cashBalance, shadowHoldings);
      shadow.priceHistoryBuffer = this.liveEngine.priceHistoryBuffer; // Inject Shared Real-Time History
      shadow.id = `Legion_${asset}_${i}`;
      shadow.assignedAsset = asset;
      shadow.startTime = Date.now();
      shadow.lastTradeTime = Date.now();
      this.shadowLegion.push(shadow);
    }
  }
  async marchLegion(portfolioSummary) {
    const priceMap = {};
    portfolioSummary.forEach(r => priceMap[r.Symbol] = r.Price);
    const marchPromises = this.shadowLegion.map(async (shadow) => {
      const shadowPortfolio = [];
      Object.keys(shadow.holdings).forEach(sym => {
        if (priceMap[sym]) {
          shadowPortfolio.push({
            Symbol: sym, Price: priceMap[sym],
            Value: (shadow.holdings[sym].rawQuantity || 0) * priceMap[sym],
            Baseline: shadow.baselines[sym] || 0
          });
        }
      });
      const result = await shadow.update(shadowPortfolio, null, shadow.cashBalance, shadow.holdings, null, priceMap);
      if (result.killMe) shadow.killMe = true; // Mark for culling
      if (result.anyTradesThisCycle) {
        shadow.lastTradeTime = Date.now();
        this.handleShadowVictory(shadow, result);
      }
    });
    await Promise.all(marchPromises);
  }
  handleShadowVictory(shadow, result) {
    // console.log(`🏆 Shadow ${shadow.id} won!`);
    this.dispatchToDreamer({ type: 'FEEDBACK', genome: shadow.genome, score: shadow.lastTotalValue, focus: shadow.assignedAsset });
  }
  requestOptimization(asset) {
    // console.log(`🧠 Requesting Optimization for ${asset}`);
    // Ensure we send the CURRENT live genome so the Dreamer starts searching from where we are now,
    // not from scratch (defaults).
    const currentGenome = JSON.parse(JSON.stringify(this.liveEngine.genome));
    this.activeDreamJobs.add(asset); // Track active job
    this.dispatchToDreamer({ type: 'OPTIMIZE_ORDER', symbol: asset, baseGenome: currentGenome });
  }
  notifyOptimizationComplete(asset) {
    this.activeDreamJobs.delete(asset);
  }
  dispatchToDreamer(msg) {
    if (!this.dreamerGrid || this.dreamerGrid.length === 0) return;
    const worker = this.dreamerGrid[Math.floor(Math.random() * this.dreamerGrid.length)];
    if (worker && worker.send) worker.send(msg);
  }
  getParam(genome, key, asset) {
    if (genome.overrides && genome.overrides[asset] && genome.overrides[asset][key] !== undefined) return genome.overrides[asset][key];
    return genome[key];
  }
}
