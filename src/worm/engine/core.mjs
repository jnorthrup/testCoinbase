// src/worm/engine/core.mjs
// Core TradingEngine class with state management
// 64-bit math via BigInt where precision matters

import crypto from 'crypto';
import { I64, U64, Price64, PortfolioTensor } from '../types/int64.mjs';
import { getGenomicParam, parseOptionalNumber } from '../utils/helpers.mjs';
import { roundQty, checkMinQuantity } from '../utils/quantity.mjs';
import {
  getEffectivePriceFromResp,
  getFilledQuantityFromResp,
  getSettledValueFromResp,
  getTotalFeesFromResp,
  getGrossValueFromResp,
} from '../utils/trade-response.mjs';

const HARVEST_EXCLUDE = ['BTC', 'ETH', 'USDC', 'USDG'];
const REBALANCE_EXCLUDE = ['BTC', 'ETH', 'USDC', 'USDG'];
const PRECISION_THRESHOLD = 0.0001;

export class TradingEngine {
  constructor(genome, mode = 'SHADOW', initialCapital = 0, initialHoldings = {}) {
    this.genome = { ...genome };
    this.mode = mode;

    // Persistent State
    this.baselines = {};
    this.trailingState = {};
    this.ratchetState = {};
    this.lastActionTimestamps = {};
    this.reinvestHistory = [];

    // Transient State
    this.rebalanceState = {};
    this.portfolioHarvestState = {
      flagged: false,
      cycleCount: 0,
      previousDeviationPercent: null,
      flaggedAt: null,
    };

    // Simulation State (Shadow Only)
    this.cashBalance = initialCapital;
    this.holdings = initialHoldings;
    this.totalHarvested = 0;
    this.totalTrades = 0;
    this.lastTotalValue = initialCapital;

    // Risk Metrics
    this.peakTotalValue = initialCapital;
    this.maxDrawdownPercent = 0.0;
    this.initialCapital = initialCapital;

    // BigInt tensor for precise quantity tracking
    this.tensor = new PortfolioTensor();

    this.priceHistory = {};
    this.priceHistoryBuffer = [];

    // Tier 1 & 2 Upgrades
    this.cyclesWithoutTrade = 0;
    this.lastCyclePrices = {};
    this.minTradeUSD = 1.00;
    this.postMortemEvents = [];
    this.isGlobalRiskSignalActive = false;
  }

  loadPersistedState(data) {
    if (!data) return;
    if (data.baselines) this.baselines = data.baselines;
    if (data.trailingState) this.trailingState = data.trailingState;
    if (data.ratchetState) this.ratchetState = data.ratchetState;
    if (data.lastActionTimestamps) this.lastActionTimestamps = data.lastActionTimestamps;
    if (data.reinvestHistory) this.reinvestHistory = data.reinvestHistory;
    if (data.genome) {
      this.genome = { ...this.genome, ...data.genome };
      this.genome.REINVEST_COOLDOWN_QUEUE_SIZE = 15;
    }
    if (data.initialCapital !== undefined && data.initialCapital > 0) this.initialCapital = data.initialCapital;
    if (data.peakTotalValue !== undefined && data.peakTotalValue > 0) this.peakTotalValue = data.peakTotalValue;
    if (data.maxDrawdownPercent !== undefined) this.maxDrawdownPercent = data.maxDrawdownPercent;
  }

  getStateSnapshot() {
    return {
      baselines: this.baselines,
      trailingState: this.trailingState,
      ratchetState: this.ratchetState || {},
      lastActionTimestamps: this.lastActionTimestamps,
      reinvestHistory: this.reinvestHistory || [],
      genome: this.genome,
      cashBalance: this.cashBalance,
      holdings: this.holdings,
      lastCyclePrices: this.lastCyclePrices || {},
      lastBestScore: global.lastBestScore || 1.0,
      assetSourceTimeframe: this.assetSourceTimeframe || {},
      overflowTarget: 'ETH',
      initialCapital: this.initialCapital,
      peakTotalValue: this.peakTotalValue,
      maxDrawdownPercent: this.maxDrawdownPercent,
    };
  }

  _logTrade({ asset, side, quantity, price, clientOrderId, note = '', grossValue = null, totalFees = null, settledValue = null }) {
    try {
      const quantityNum = parseFloat(quantity);
      const priceNum = parseFloat(price);
      if (isNaN(quantityNum) || isNaN(priceNum) || priceNum <= 0) {
        console.error(`Error logging trade: Invalid numeric values. Qty: ${quantity}, Price: ${price}`);
        return;
      }
      const totalValue = (quantityNum * priceNum).toFixed(2);
      const grossValueNum = parseOptionalNumber(grossValue) ?? (quantityNum * priceNum);
      const totalFeesNum = parseOptionalNumber(totalFees) ?? 0;
      const settledValueNum = parseOptionalNumber(settledValue) ?? Math.max(0, grossValueNum - totalFeesNum);
      console.log(`📝 Trade: ${side} ${quantityNum} ${asset} @ $${priceNum} (${note})`);
    } catch (error) {
      console.error(`Error logging trade for ${asset}:`, error);
    }
  }

  _placeBuy(api, symbol, quantity, expectedPrice = null) {
    const cleanSymbol = symbol.replace('-USD', '');
    if (!checkMinQuantity(cleanSymbol, quantity)) {
      if (this.mode === 'LIVE') {
        console.warn(`⚠️ [API Safety Guard] Skip BUY order for ${cleanSymbol}: quantity ${quantity} is below minimum.`);
      }
      return null;
    }
    if (this.mode === 'LIVE' && api) {
      try {
        return api.placeBuy(symbol, quantity);
      } catch (err) {
        console.error(`⚠️ [API Warning] BUY order failed for ${cleanSymbol}:`, err.message);
        return null;
      }
    }
    if (this.mode === 'SHADOW') {
      let executedPrice = expectedPrice || 0;
      const rSt = this.ratchetState[cleanSymbol];
      const slip = rSt && rSt.lastSlippage !== undefined ? rSt.lastSlippage : 0.01;
      executedPrice = expectedPrice * (1 + slip);
      return {
        id: `shadow_buy_${crypto.randomUUID()}`,
        client_order_id: `oid_${Date.now()}`,
        average_price: executedPrice.toString(),
      };
    }
    return null;
  }

  _placeSell(api, symbol, quantity, expectedPrice = null) {
    const cleanSymbol = symbol.replace('-USD', '');
    if (!checkMinQuantity(cleanSymbol, quantity)) {
      if (this.mode === 'LIVE') {
        console.warn(`⚠️ [API Safety Guard] Skip SELL order for ${cleanSymbol}: quantity ${quantity} is below minimum.`);
      }
      return null;
    }
    if (this.mode === 'LIVE' && api) {
      try {
        return api.placeSell(symbol, quantity);
      } catch (err) {
        console.error(`⚠️ [API Warning] SELL order failed for ${cleanSymbol}:`, err.message);
        return null;
      }
    }
    if (this.mode === 'SHADOW') {
      let executedPrice = expectedPrice || 0;
      const rSt = this.ratchetState[cleanSymbol];
      const slip = rSt && rSt.lastSlippage !== undefined ? rSt.lastSlippage : 0.01;
      executedPrice = expectedPrice * (1 - slip);
      return {
        id: `shadow_sell_${crypto.randomUUID()}`,
        client_order_id: `oid_${Date.now()}`,
        average_price: executedPrice.toString(),
      };
    }
    return null;
  }

  _getDynamicCriticalMass(portfolioSummary, holdingDetails) {
    const tokenBaselines = this.baselines;
    const hasUnspawnedTokens = Object.keys(this._minOrderQtyMap || {}).some(sym =>
      !HARVEST_EXCLUDE.includes(sym) &&
      (!tokenBaselines[sym] || tokenBaselines[sym] <= 0) &&
      (!holdingDetails[sym] || (holdingDetails[sym].rawQuantity || 0) <= 0)
    );
    if (hasUnspawnedTokens) {
      return 100.00;
    }
    let portfolioValue = portfolioSummary.reduce((sum, r) => sum + r.Value, 0);
    return portfolioValue * 0.01;
  }
}

export { HARVEST_EXCLUDE, REBALANCE_EXCLUDE, PRECISION_THRESHOLD };