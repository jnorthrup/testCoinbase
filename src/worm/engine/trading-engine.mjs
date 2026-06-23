// Lifted from robinhood-worm.js — Python array scissor.
// Full shared imports cloned. DCE later.

import dotenv from 'dotenv';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import os from 'os';
import { fileURLToPath } from 'url';
import { fork } from 'child_process';
import {
  minIncrementMap, SLIPPAGE_BUFFERS, HARVEST_EXCLUDE, REBALANCE_EXCLUDE,
  PRECISION_THRESHOLD, SNOWBALL_CONFIG, defaultGenome, getFallbackMinQty,
} from '../config/constants.mjs';
import { roundQty, checkMinQuantity, setMinOrderQtyMap, getMinOrderQtyMap } from '../utils/quantity.mjs';
import {
  getEffectivePriceFromResp, getFilledQuantityFromResp, getSettledValueFromResp,
  getTotalFeesFromResp, getGrossValueFromResp, parseOptionalNumber, getGenomicParam,
} from '../utils/helpers.mjs';
import {
  verifyOrder, logTrade, checkMinTrade,
} from '../utils/trading-helpers.mjs';
import { MultiAssetKalman, kalmanSlipCap, kellySpawnCost } from '../estimation/kalman.mjs';
import { metricKalmanBaseline } from '../estimation/metrics.mjs';
import { TradeHistoryAnalyzer } from '../dreamer/trade-history-analyzer.mjs';
const MIN_ORDER_QTY_MAP = new Proxy({}, {
  get(_, k)  { return getMinOrderQtyMap()[k]; },
  ownKeys()  { return Object.keys(getMinOrderQtyMap()); },
  has(_, k)  { return k in getMinOrderQtyMap(); },
  getOwnPropertyDescriptor(_, k) { return Object.getOwnPropertyDescriptor(getMinOrderQtyMap(), k); },
});

// Singleton Kalman filter — one filter per asset, shared across TradingEngine instances.
// Survives respawns within a process; resets on full restart (acceptable for slippage estimation).
const _kalman = new MultiAssetKalman({ q: 1e-5, r: 1e-3, x0: 0.001, p0: 0.01 });

// Falls back to SLIPPAGE_BUFFERS.DEFAULT ceiling when no oracle data is available,
// but at 0.005 (= 50 bps) instead of 0.0097 — a no-spread-over-estimate that also
// keeps the system inside the safety envelope when measured data is fresh.
const ORACLE_SLIP_FLOOR_FALLBACK = { sell: 0.005, buy: 0.005 };

/**
 * Functional constants named and lifted out so repeated scatter-grep literals
 * (Math.min(0.04, Math.max(0, …))) become one named helper. If the threshold
 * ever changes, this is the one place to update.
 */
const SLIPPAGE_CLAMP_LO = 0.0;
const SLIPPAGE_CLAMP_HI = 0.04;
function clampSlippage(slippage) {
  return Math.min(SLIPPAGE_CLAMP_HI, Math.max(SLIPPAGE_CLAMP_LO, slippage));
}

/** Ratchet modifier advance: bump by `step` (default 0.5%), ceiling at `cap` (default 2%). */
function bumpRatchetModifier(state, field, step = 0.005, cap = 0.02) {
  state[field] = Math.min(cap, (state[field] || 0) + step);
  return state[field];
}

/**
 * Oracle-anchored slippage floor. Pulls top-of-book bid/ask from the WS price
 * cache (or, if missing/stale, falls back to the ORACLE_SLIP_FLOOR_FALLBACK).
 * Replaces the legacy SLIPPAGE_BUFFERS.DEFAULT.sell scalar guess which ran at
 * exactly 0.0097 regardless of measured product-book spread.
 *
 * @param {object} api - the CoinbaseWormAPI instance (must expose _ws optionally)
 * @param {string} sym - bare ticker (e.g. 'BTC', no '-USD' suffix)
 * @param {'sell'|'buy'} side
 * @returns {number} - a slippage floor in `[1e-6, 0.04]`
 */
function _oracleSlipFloor(api, sym, side) {
  const fallback = ORACLE_SLIP_FLOOR_FALLBACK[side] || 0.005;
  let entry = null;
  try {
    const wsClient = api && api._ws;
    if (wsClient && typeof wsClient.getPrice === 'function') {
      entry = wsClient.getPrice(sym);
    }
  } catch (_) {
    entry = null;
  }
  if (entry && Number.isFinite(entry.bid) && Number.isFinite(entry.ask)
      && entry.ask > 0 && entry.bid > 0) {
    const spread = (entry.ask - entry.bid) / entry.ask;
    if (Number.isFinite(spread) && spread > 0) {
      // Use 4× measured spread as a one-side-impact estimate. Caps keep us inside the
      // safety envelope even on volatile pairs (single-side impact rarely exceeds 4× spread).
      const impact = Math.min(0.04, Math.max(1e-6, spread * 4));
      return Math.min(fallback, impact);
    }
  }
  return fallback;
}

export class TradingEngine {
  constructor(genome, modeParam = 'sim', initialCapital = 0, initialHoldings = {}) {
    this.genome = { ...genome };
    // mode param is now a hint, not the discriminator. Keep `this.mode` for backward
    // compat with consumers (Legion dreams, scientific-optimizer) that still read it,
    // but the executor bit is what gates LIVE-vs-SIM behavior.

    // --- Persistent State ---
    this.baselines = {};        // { SYM: value }
    this.trailingState = {};    // { SYM: harvest_info }
    this.ratchetState = {};     // { SYM: ratchet_info (Heartbeat) }
    this.lastActionTimestamps = {}; // { SYM: timestamp }
    this.reinvestHistory = [];  // Solution 1: Cooldown history for rotational reinvestment
    this._baselineP = {};       // { SYM: covariance } for metricKalmanBaseline state, persists with engine lifecycle
    this._priceFetchFailures = new Map(); // { SYM: timestamp } — cooldown for symbols that failed price lookup

    // --- Executor selection: 'sim' or 'live' ---
    // Replaces the old 'LIVE' / 'SHADOW' string discriminator that bifurcated
    // every state-mutating branch (15 SHADOW branches, 39 LIVE-only branches).
    // SHADOW is still kept for Legion's defective-micro-backtest plumbing (line 546+),
    // since that is training plumbing, not a real executor. The runtime flag is `executor`.
    this.executor = (modeParam === 'sim' || modeParam === 'SHADOW' || modeParam === 'PAPER') ? 'sim'
      : (modeParam === 'live' || modeParam === 'LIVE') ? 'live'
      : 'sim';
    this.mode = this.executor === 'sim' ? 'SIM' : 'LIVE';

    // --- Audit history: every fill (live or sim) lands here, regardless of mode ---
    // Calibration, dreamer fitness, Kelly FIFO P&L, and liveEngineState.json reads
    // ALL consume this ringbuffer. Mode does not belong in the consumer.
    this._audit = {
      fills: [],          // chronological list of FillRecord objects
      maxEntries: 4096,   // cap memory; ringbuffer
      record(fill) {
        this.fills.push(fill);
        if (this.fills.length > this.maxEntries) this.fills.shift();
      },
      tail(n = 1) {
        return this.fills.slice(-n);
      },
      bySym(sym) {
        return this.fills.filter(f => f.sym === sym);
      },
    };

    // --- Transient State ---
    this.rebalanceState = {};   // { SYM: rebalance_info }
    this.portfolioHarvestState = {
      flagged: false,
      cycleCount: 0,
      previousDeviationPercent: null,
      flaggedAt: null
    };

    // --- Simulation State (Shadow Only) ---
    this.cashBalance = initialCapital;
    this._historyAnalyzer = new TradeHistoryAnalyzer();
    this.holdings = initialHoldings; // { SYM: qty }
    this.totalHarvested = 0; // Track performance (Cumulative Lifetime)
    this.totalTrades = 0;    // Track activity level
    this.lastTotalValue = initialCapital; // Value tracking

    // --- Risk Metrics ---
    this.peakTotalValue = initialCapital;
    this.maxDrawdownPercent = 0.0;
    this.initialCapital = initialCapital; // $0 for LIVE; set from first portfolio value on boot

    this.priceHistory = {}; // Engine-local price history
    this.priceHistoryBuffer = []; // Global high-res history (LIVE only) or Simulation history (SHADOW)

    // --- Tier 1 & 2 Upgrades ---
    this.cyclesWithoutTrade = 0;
    this.lastCyclePrices = {}; // { SYM: price }
    this.minTradeUSD = 1.00; // Tier 2 Dust Protection
    this.postMortemEvents = []; // Queue for Tier 1 Post-Mortem
    this.isGlobalRiskSignalActive = false; // Global risk status exposed to mainLoop
  }

  loadPersistedState(data) {
    if (!data) return;
    if (data.baselines) this.baselines = data.baselines;
    if (data.trailingState) this.trailingState = data.trailingState;
    if (data.ratchetState) this.ratchetState = data.ratchetState;
    if (data.lastActionTimestamps) this.lastActionTimestamps = data.lastActionTimestamps;
    if (data.reinvestHistory) this.reinvestHistory = data.reinvestHistory;
    if (data._baselineP) this._baselineP = data._baselineP;
    if (data.genome) {
      this.genome = { ...this.genome, ...data.genome };
      this.genome.REINVEST_COOLDOWN_QUEUE_SIZE = 15; // Enforce 15-token queue size
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
      // Include Live Portfolio State for Simulation
      cashBalance: this.cashBalance,
      holdings: this.holdings,
      lastCyclePrices: this.lastCyclePrices || {},
      // Include Dreamer promotion threshold & visual metadata for persistence
      lastBestScore: global.lastBestScore || 1.0,
      assetSourceTimeframe: this.assetSourceTimeframe || {},
      overflowTarget: SNOWBALL_CONFIG.OVERFLOW_TARGET,
      initialCapital: this.initialCapital,
      peakTotalValue: this.peakTotalValue,
      maxDrawdownPercent: this.maxDrawdownPercent,
      _baselineP: this._baselineP || {}
    };
  }

  /**
   * 🧬 SCIENTIFIC REGIME: Deep Hydration
   * Inject a full snapshot of the Live Bot's reality into this Shadow.
   * Crucial for "Counterfactual Simulation" - asking "What if?" from the exact current state.
   */
  injectSimulationState(snapshot) {
    if (this.mode !== 'SHADOW') {
      console.warn("⚠️ Attempted to inject simulation state into LIVE engine. Ignoring.");
      return;
    }

    if (snapshot.cashBalance !== undefined) this.cashBalance = snapshot.cashBalance;
    if (snapshot.holdings) this.holdings = JSON.parse(JSON.stringify(snapshot.holdings));
    if (snapshot.baselines) this.baselines = JSON.parse(JSON.stringify(snapshot.baselines));
    if (snapshot.trailingState) this.trailingState = JSON.parse(JSON.stringify(snapshot.trailingState));
    if (snapshot.ratchetState) this.ratchetState = JSON.parse(JSON.stringify(snapshot.ratchetState));
    if (snapshot.rebalanceState) this.rebalanceState = JSON.parse(JSON.stringify(snapshot.rebalanceState));
    if (snapshot.lastActionTimestamps) this.lastActionTimestamps = JSON.parse(JSON.stringify(snapshot.lastActionTimestamps));

    // Log for verification
    // console.log(`💉 State Injected: Cash=${this.cashBalance}, Holdings=${Object.keys(this.holdings).join(',')}`);
  }

  // Active Shadow Validation ("Micro-Backtest")
  isDefective(portfolioSummary, priceHistoryBuffer) {
    if (!priceHistoryBuffer || priceHistoryBuffer.length === 0) return false;

    const asset = this.assignedAsset;
    if (!asset) return false;

    // Get Genome Trigger (Rebalance Trigger - Buying the Dip)
    const overrides = this.genome.overrides && this.genome.overrides[asset];
    const rebalanceTrigger = (overrides && overrides.FLAT_REBALANCE_TRIGGER_PERCENT)
      || this.genome.FLAT_REBALANCE_TRIGGER_PERCENT;

    // If trigger is not negative (or effectively disabled), skip check
    if (!rebalanceTrigger || rebalanceTrigger >= 0) return false;

    // Needs at least some history
    if (priceHistoryBuffer.length < 10) return false;

    // Extract Asset Prices
    const prices = [];
    for (const tick of priceHistoryBuffer) {
      if (tick.prices && tick.prices[asset]) {
        prices.push({ t: tick.t, p: tick.prices[asset] });
      }
    }
    if (prices.length === 0) return false;

    // "Bad Trade" Definition:
    // We "Buy" when (Price - RollingMax) / RollingMax < Trigger
    // We "Fail" if Price subsequently drops > 1.0% (CRASH_THRESHOLD) below BuyPrice.
    const CRASH_THRESHOLD = 0.01;

    let maxPrice = prices[0].p;

    for (let i = 0; i < prices.length; i++) {
      const current = prices[i];
      if (current.p > maxPrice) maxPrice = current.p;

      // Check Trigger
      const deviation = (current.p - maxPrice) / maxPrice;

      if (deviation < rebalanceTrigger) {
        // VIRTUAL BUY SIGNAL at current.p

        // Look Ahead for Crash
        let minFuturePrice = current.p;
        for (let j = i + 1; j < prices.length; j++) {
          if (prices[j].p < minFuturePrice) minFuturePrice = prices[j].p;
        }

        const subsequentDrop = (minFuturePrice - current.p) / current.p;

        if (subsequentDrop < -CRASH_THRESHOLD) {
          // console.log(`💀 Shadow ${this.id} DEFECTIVE. Trigger ${rebalanceTrigger.toFixed(4)} hit at ${current.p}, crashed to ${minFuturePrice}`);
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Refresh the alpha-source candidate list once per cycle.
   * Returns the ranked sym array; internally caches `api.lastSpawnCandidates`
   * so other code paths (regime detector, dreamer fitness) can read it.
   *
   * Caching rule: refresh on a fresh cycle OR after MIN_REFRESH_MS — prevents
   * cost explosion if multiple cycle entry points fire per cycle.
   *
   * Source priority: `getOutlierCandidates` (multi-dim 5m+24h+volume fusion)
   *   > `getShortTermMovers` (5m tape + 24h gainers) > null.
   * The engine prefers the outlier fusion when present so the spawn queue
   * attacks all dimensions of "where the action is" simultaneously.
   */
  async _refreshAlphaCandidates(api) {
    const now = Date.now();
    const last = this._lastAlphaRefresh || 0;
    const MIN_REFRESH_MS = 30 * 1000;
    if (!api) return null;
    const hasCache = Array.isArray(api.lastSpawnCandidates);
    if ((now - last) < MIN_REFRESH_MS && hasCache) {
      return api.lastSpawnCandidates;
    }
    try {
      let movers;
      if (typeof api.getOutlierCandidates === 'function') {
        movers = await api.getOutlierCandidates({ limit: 30, minTicks: 4 });
      } else if (typeof api.getShortTermMovers === 'function') {
        movers = await api.getShortTermMovers(5 * 60 * 1000, 10, 4);
      }
      api.lastSpawnCandidates = (Array.isArray(movers) ? movers : [])
        .map(e => ({ symbol: e.symbol, change5m: e.change5m, change24h: e.change24h, volume24h: e.volume24h, score: e.score, source: e.source || e.sources?.join?.('+') || 'fresh' }))
        .filter(e => e.symbol);
      this._lastAlphaRefresh = now;
      return api.lastSpawnCandidates;
    } catch (_err) {
      return null;
    }
  }

  /**
   * Unified fill executor. Replaces the two LIVE/SHADOW bifurcated methods.
   * Side='sell' or 'buy' is the only structural difference; everything else
   * (slippage calibration, audit ringbuffer, counter increment, return shape)
   * is identical regardless of executor (sim or live).
   *
   * Returns a normalized FillRecord: { id, client_order_id, average_price,
   *  effectivePrice, qty, fee, sym, side, executor } OR null when aborted.
   */
  async _executeFill(api, side, symbol, quantity, expectedPrice = null) {
    side = (side === 'buy' || side === 'BUY') ? 'BUY' : 'SELL';
    const counterKey = side === 'BUY' ? 'buys' : 'sells';
    const cleanSymbol = symbol.replace('-USD', '');

    if ((this._cycleCounters?.[counterKey] ?? 0) >= (this._cycleCounters?.[`max${side === 'BUY' ? 'Buys' : 'Sells'}`] ?? Infinity)) {
      return null;
    }
    if (!checkMinQuantity(cleanSymbol, quantity)) {
      if (this.executor === 'live') {
        console.warn(`⚠️ [API Safety Guard] Skip ${side} order for ${cleanSymbol}: quantity ${quantity} is less than required minimum ${MIN_ORDER_QTY_MAP[cleanSymbol]}.`);
      }
      return null;
    }

    // --- Executor dispatch (the ONLY mode-shaped branching) ---
    let result;
    let effectivePrice = null;
    let fee = 0;
    if (this.executor === 'live' && api) {
      try {
        const placeMethod = side === 'BUY' ? api.placeBuy : api.placeSell;
        const resp = await placeMethod.call(api, symbol, quantity);
        if (resp?.preview_only) {
          // preview path: no real fill, no mirror, no audit entry — counters advance
          if (this._cycleCounters) this._cycleCounters[counterKey]++;
          return resp;
        }
        if (resp?.id) {
          const verified = await verifyOrder(api, resp.id, symbol);
          effectivePrice = getEffectivePriceFromResp(verified, expectedPrice);
          if (!verified || effectivePrice === null) {
            console.warn(`⚠️ [Fill Verification] ${side} ${symbol} order ${resp.id} has no verified fill price; skipping accounting mutation.`);
            return null;
          }
          result = verified;
        } else {
          result = resp;
        }
      } catch (err) {
        const apiMsg = err.response?.data?.errors?.[0]?.detail || err.response?.data?.message || err.message;
        console.error(`⚠️ [API Warning] ${side} order failed/skipped for ${cleanSymbol}: ${apiMsg}`);
        return null;
      }
    } else {
      // --- SIM branch ---
      // mirror the LIVE branch's slippage/audit but sourced from priceMap/BidAsk.
      // qty-shaping uses `expectedPrice` directly (bypassing slippage) so the test
      // contract "rawQuantity == spawnCost / buyP" holds; effectivePrice gets the
      // slippage-adjusted fill so cost/ratchet/audit observe the real fill reality.
      const rSt = this.ratchetState[cleanSymbol];
      const _defaultSlip = SLIPPAGE_BUFFERS[cleanSymbol] || SLIPPAGE_BUFFERS.DEFAULT;
      const oracleFloorSell = _oracleSlipFloor(api, cleanSymbol, 'sell');
      const oracleFloorBuy  = _oracleSlipFloor(api, cleanSymbol, 'buy');
      const slipConfig = {
        sell: kalmanSlipCap(_kalman, cleanSymbol, Math.min(oracleFloorSell, _defaultSlip.sell), Math.min(0.08, _defaultSlip.sell * 3)),
        buy:  kalmanSlipCap(_kalman, cleanSymbol, Math.min(oracleFloorBuy,  _defaultSlip.buy),  Math.min(0.08, _defaultSlip.buy  * 3)),
      };
      const baselineSlip = side === 'BUY' ? slipConfig.buy : slipConfig.sell;
      const lastSlip = rSt && rSt.lastSlippage !== undefined && rSt.lastSlippage !== null ? rSt.lastSlippage : baselineSlip;
      const slipMultiplier = side === 'BUY' ? (1 + lastSlip) : (1 - lastSlip);
      effectivePrice = expectedPrice && expectedPrice > 0 ? expectedPrice * slipMultiplier : 0;
      fee = side === 'BUY' ? (effectivePrice * parseFloat(quantity) * 0.01) : 0;   // SIM matches the legacy 1% buy fee
      // The "reported fill qty" back to the caller is what the caller REQUESTED,
      // which would equal what Coinbase would confirm if slippage didn't bite.
      // Slippage-affected cost reality is captured under `effectivePrice`.
      const reportedQty = parseFloat(quantity);
      result = {
        id: `sim_${side.toLowerCase()}_${crypto.randomUUID()}`,
        client_order_id: `oid_${Date.now()}`,
        average_price: effectivePrice.toString(),
        average_filled_price: effectivePrice.toString(),
        filled_asset_quantity: reportedQty.toString(),
        expected_quantity: reportedQty.toString(),
      };
    }

    if (result) {
      const observedFee = getTotalFeesFromResp(result);
      if (Number.isFinite(observedFee) && observedFee >= 0) fee = observedFee;
    }

    // --- Unified audit record (runs in BOTH modes; calibration can't tell the difference) ---
    if (effectivePrice !== null && Number.isFinite(effectivePrice) && effectivePrice > 0) {
      const fillRecord = {
        ts: Date.now(),
        sym: cleanSymbol,
        side,
        qty: parseFloat(quantity) || 0,
        effectivePrice,
        expectedPrice: expectedPrice || null,
        fee,
        executor: this.executor,
        simulated: Boolean(result?.simulated),
        orderId: result.id,
        clientOrderId: result.client_order_id || result.clientOrderId,
      };
      this._audit.record(fillRecord);
      if (this._cycleCounters) this._cycleCounters[counterKey]++;
    }
    return { ...result, effectivePrice, executor: this.executor, side, sym: cleanSymbol };
  }

  // Thin wrappers preserved for the call sites in update(). Backwards-compatible.
  async _placeSell(api, symbol, quantity, expectedPrice = null) {
    return this._executeFill(api, 'SELL', symbol, quantity, expectedPrice);
  }
  async _placeBuy(api, symbol, quantity, expectedPrice = null) {
    return this._executeFill(api, 'BUY', symbol, quantity, expectedPrice);
  }

  _getDynamicCriticalMass(portfolioSummary, holdingDetails) {
    const tokenBaselines = this.baselines;

    // 1. Identify if we have any unspawned tokens left in the queue
    const hasUnspawnedTokens = Object.keys(MIN_ORDER_QTY_MAP).some(sym =>
      !HARVEST_EXCLUDE.includes(sym) &&
      (!tokenBaselines[sym] || tokenBaselines[sym] <= 0) &&
      (!holdingDetails[sym] || (holdingDetails[sym].rawQuantity || 0) <= 0)
    );

    // If there are still new tokens to spawn, our active milestone target remains $100.00
    if (hasUnspawnedTokens) {
      return 100.00;
    }

    // 2. Scan active altcoins (exclude stablecoins, BTC, ETH)
    const activeAltcoins = portfolioSummary.filter(r =>
      !HARVEST_EXCLUDE.includes(r.Symbol) &&
      tokenBaselines[r.Symbol] > 0
    );

    if (activeAltcoins.length === 0) {
      return 100.00; // Fallback
    }

    // 3. Increment threshold by $100 blocks until at least one altcoin falls below it
    let threshold = 100.00;
    while (activeAltcoins.every(r => r.Value >= threshold)) {
      threshold += 100.00;
    }

    return threshold;
  }

  _logTrade(data) {
    this.totalTrades++;
    if (this.cycleTrades) this.cycleTrades.push(data.asset);
    // Feed Kelly stats in-memory regardless of mode — paper trades count too.
    this._historyAnalyzer.recordTrade(data);
    if (this.mode === 'LIVE') {
      logTrade(data);
    }
  }

  // --- Core Logic ---
  async update(portfolioSummary, api, cashBalance, holdingDetails, simTime = null, priceMap = null) {
    const now = simTime || Date.now();
    // CRITICAL: Sync external balance to internal state
    // Without this, this.cashBalance stays at initialization value (0) and blocks all buys
    this.cashBalance = cashBalance;

    // Persist Holdings in LIVE mode for Snapshotting
    if (this.mode === 'LIVE' && holdingDetails) {
      this.holdings = holdingDetails;
    }

    let anyTradesThisCycle = false;
    let stateChanged = false;
    let harvestedAmount = 0; // Local accumulator
    let matureHarvestedAmount = 0; // Accumulated mature harvests
    let snowballHarvestedAmount = 0; // Accumulated snowball harvests
    let buysThisCycle = 0;
    let sellsThisCycle = 0;
    const MAX_BUYS  = SNOWBALL_CONFIG.MAX_BUYS_PER_CYCLE  ?? 2;
    const MAX_SELLS = SNOWBALL_CONFIG.MAX_SELLS_PER_CYCLE ?? 2;
    this._cycleCounters = { buys: 0, sells: 0, maxBuys: MAX_BUYS, maxSells: MAX_SELLS };
    const dynamicCriticalMass = this._getDynamicCriticalMass(portfolioSummary, holdingDetails || this.holdings);
    this.cycleTrades = [];   // Track trades for this cycle to notify Dreamer
    this.postMortemEvents = []; // Reset events

    // Calculate Total Value for Fitness Tracking
    let currentHoldingsValue = 0;
    portfolioSummary.forEach(r => currentHoldingsValue += r.Value);
    const currentTotalValue = currentHoldingsValue + this.cashBalance;

    // Dev Log Helper (Scoped to Engine or Global? Let's use Global if strictly defined, or simple conditional)
    const devLog = (msg) => { if (typeof LEGION_CONFIG !== 'undefined' && LEGION_CONFIG.ENABLE_DEVELOPER_LOGS) console.log(`🛠️ [DEV] ${msg}`); };


    // --- AUTO-INITIALIZE NEW ASSETS ---
    // If a new asset appears in holdings (user bought it), we must set a baseline so the bot can track it.
    // We set Baseline = Current Value (Assumption: User just bought it, so deviation is 0).
    if (this.mode === 'LIVE') {
      portfolioSummary.forEach(row => {
        if (row.Value > 1.0 && (!this.baselines[row.Symbol] || this.baselines[row.Symbol] <= 0)) {
          console.log(`✨ [NEW ASSET DETECTED] Initializing Baseline for ${row.Symbol} @ $${row.Value.toFixed(2)}`);
          this.baselines[row.Symbol] = row.Value;
          stateChanged = true;
        }
      });
    }


    // --- Tier 1: Manual Cash Extraction Detection & Baseline Healing ---
    if (this.mode === 'LIVE' && this.lastTotalValue > 0) {
      const dropPercent = (this.lastTotalValue - currentTotalValue) / this.lastTotalValue;
      if (dropPercent > 0.12) { // Trigger at > 12% drop
        // Calculate Average Price Change
        let totalPriceChangePct = 0;
        let priceCount = 0;
        portfolioSummary.forEach(r => {
          if (this.lastCyclePrices[r.Symbol]) {
            const prevP = this.lastCyclePrices[r.Symbol];
            const change = Math.abs((r.Price - prevP) / prevP);
            totalPriceChangePct += change;
            priceCount++;
          }
        });
        const avgPriceChange = priceCount > 0 ? (totalPriceChangePct / priceCount) : 0;

        if (avgPriceChange < 0.02) { // If prices moved < 2% (Stable)
          console.warn(`🚨 USER_EXTRACTION_DETECTED: Portfolio dropped ${(dropPercent * 100).toFixed(1)}% but prices are stable. Healing Baselines...`);
          // Proportional Baseline Reset
          Object.keys(this.baselines).forEach(sym => {
            // Scale down or set to current? Instruction: "set baselines[sym] = current_value[sym] * 0.995"
            const row = portfolioSummary.find(r => r.Symbol === sym);
            if (row) {
              this.baselines[sym] = row.Value * 0.995;
            }
          });
          this.lastTotalValue = currentTotalValue; // Reset tracking
          console.log(`   ✅ Baselines Re-aligned to Current Value * 0.995.`);
          return { anyTradesThisCycle: false, harvestedAmount: 0, tradedSymbols: [] }; // Skip trading this cycle
        }
      }
    }

    // Store current total value & prices for next cycle comparison
    this.lastTotalValue = currentTotalValue;
    portfolioSummary.forEach(r => this.lastCyclePrices[r.Symbol] = r.Price);

    // Update Risk Metrics
    if (currentTotalValue > this.peakTotalValue) {
      this.peakTotalValue = currentTotalValue;
    } else if (this.peakTotalValue > 0.0001) {
      const drawdown = (this.peakTotalValue - currentTotalValue) / this.peakTotalValue;
      const clampedDrawdown = Math.min(1.0, Math.max(0.0, drawdown));
      if (clampedDrawdown > this.maxDrawdownPercent) this.maxDrawdownPercent = clampedDrawdown;
    }

    // Local State References (Aliases)
    const tokenBaselines = this.baselines;
    const trailingState = this.trailingState;
    const lastActionTimestamps = this.lastActionTimestamps;
    const rebalanceState = this.rebalanceState;
    let portfolioHarvestState = this.portfolioHarvestState; // Local ref for reassignment
    const currentGenome = this.genome;
    const priceHistory = this.priceHistory;

    // --- Calculate Portfolio Deviation (Needed for Portfolio Harvest) ---
    let totalBaselineDifference = 0; let totalManagedBaselineValue = 0;
    portfolioSummary.forEach(row => { if (row.Baseline && typeof row.Baseline === 'number' && row.Baseline > 0 && !REBALANCE_EXCLUDE.includes(row.Symbol)) { totalBaselineDifference += (row.Value - row.Baseline); totalManagedBaselineValue += row.Baseline; } });
    let currentPortfolioDeviationPercent = 0; if (totalManagedBaselineValue > 0) { currentPortfolioDeviationPercent = (totalBaselineDifference / totalManagedBaselineValue) * 100; }

    // --- Check if there are any active compounding candidates (< dynamicCriticalMass) ---
    const hasCompoundingCandidates = portfolioSummary.some(r =>
      !HARVEST_EXCLUDE.includes(r.Symbol) &&
      tokenBaselines[r.Symbol] > 0 &&
      r.Value < dynamicCriticalMass
    );

    // --- Update Price History & EMA for Adaptive Trend Escape (Tier 2) ---
    portfolioSummary.forEach(row => {
      if (!priceHistory[row.Symbol]) priceHistory[row.Symbol] = [];
      if (row.Price > 0) {
        // Add to history
        priceHistory[row.Symbol].push(row.Price);
        if (priceHistory[row.Symbol].length > currentGenome.PRICE_HISTORY_WINDOW_SIZE) priceHistory[row.Symbol].shift();
      }
    });

    // --- Update Global History Buffer (LIVE Mode Only) ---
    if (this.mode === 'LIVE') {
      const tick = { t: Date.now(), prices: {} };
      portfolioSummary.forEach(r => { if (r.Price > 0) tick.prices[r.Symbol] = r.Price; });
      this.priceHistoryBuffer.push(tick);
      // Keep last 65 minutes to be safe (needed for 60m backtest)
      const cutoff = Date.now() - (65 * 60 * 1000);
      while (this.priceHistoryBuffer.length > 0 && this.priceHistoryBuffer[0].t < cutoff) {
        this.priceHistoryBuffer.shift();
      }
    }

    // --- Active Shadow Logic ---
    // Check if the shadow is defective based on recent history
    if (this.mode === 'SHADOW' && this.isDefective(portfolioSummary, this.priceHistoryBuffer)) { // Pass the buffer
      // console.log(`💀 Shadow ${this.id} is defective. Terminating.`);
      return {
        anyTradesThisCycle: false,
        harvestedAmount: 0,
        tradedSymbols: [],
        postMortemEvents: [],
        killMe: true // <--- SIGNAL TO MANAGER
      };
    }

    // --- Project Dynamo: The Heavy Spar (Dynamic Baselines) ---
    // DRY bridge: the same metricKalmanBaseline instance powers Dreamer's
    // residual oracle and this live engine's baseline drift. The
    // genome-driven SPAR_DRAG_* coefficients now control process noise Q —
    // a tighter (closer-to-1) drag maps to a smaller Q, i.e. the filter
    // trusts the prior baseline more; a looser drag maps to a larger Q, so
    // the filter adapts faster to the new observation.
    // SIMULATION FIX: Disable baseline drift in SHADOW mode to prevent fake ROI from compounding drift
    if (this.mode !== 'SHADOW') {
      Object.keys(tokenBaselines).forEach(sym => {
        const currentBaseline = tokenBaselines[sym];
        const row = portfolioSummary.find(r => r.Symbol === sym);
        const currentValue = row ? row.Value : 0;
        if (currentBaseline > 0 && currentValue > 0) {
          const lastAction = lastActionTimestamps[sym] || now;
          const timeSinceLastAction = now - lastAction;

          let dragCoef;
          if (timeSinceLastAction < 48 * 60 * 60 * 1000) {
            // Grace Period (< 48h): apply ultra-slow Grace Drag to protect high baseline anchor
            dragCoef = getGenomicParam(currentGenome, 'SPAR_DRAG_GRACE_COEFFICIENT', sym) || 0.999998;
          } else {
            // Reality Zone (>= 48h): apply faster Reality Drag to slowly adapt to current reality
            dragCoef = getGenomicParam(currentGenome, 'SPAR_DRAG_COEFFICIENT', sym) || 0.999968;
          }

          // Translating "drag toward current" into Kalman process noise:
          // a drag of 0.999998 lets ~2 ppm of the gap persist per cycle ⇒ very small Q.
          // a drag of 0.999968 lets ~32 ppm persist per cycle ⇒ larger Q.
          // R is held fixed (measurement trust in the observed current value).
          const gapSharePerCycle = Math.min(1.0, Math.max(1e-7, 1.0 - dragCoef));
          const q = gapSharePerCycle;          // process noise variance (drag-driven)
          const r = 0.01;                        // measurement noise variance (fixed)

          const prevP = this._baselineP[sym];
          const state = {
            baseline: currentBaseline,
            p: Number.isFinite(prevP) && prevP > 0 ? prevP : Math.max(q, 1e-6),
          };
          const { baseline: newBaseline, p: newP } = metricKalmanBaseline(state, currentValue, q, r);
          this._baselineP[sym] = newP;
          tokenBaselines[sym] = newBaseline;
        }
      });
    }

    // --- Crash Protection Check ---
    let isGlobalRiskSignalActive = false;
    if (currentGenome.ENABLE_CRASH_PROTECTION) {
      let assetsWithBaselineCount = 0; let assetsMeetingDeclineThresholdCount = 0;
      portfolioSummary.forEach(row => {
        if (row.Baseline && typeof row.Baseline === 'number' && row.Baseline > 0) {
          assetsWithBaselineCount++;
          const deviation = (row.Value - row.Baseline) / row.Baseline;
          if (deviation <= currentGenome.CP_TRIGGER_MIN_NEGATIVE_DEV_PERCENT) { assetsMeetingDeclineThresholdCount++; }
        }
      });
      if (assetsWithBaselineCount > 0) {
        const percentageMeetingThreshold = assetsMeetingDeclineThresholdCount / assetsWithBaselineCount;
        if (percentageMeetingThreshold >= currentGenome.CP_TRIGGER_ASSET_PERCENT) {
          isGlobalRiskSignalActive = true;
          // console.log(`🛡️ Crash Protection ACTIVE.`);
        }
      }
    }
    this.isGlobalRiskSignalActive = isGlobalRiskSignalActive;

    // --- Portfolio Override Harvest Logic ---
    let portfolioHarvestExecutedThisCycle = false;
    if (currentGenome.ENABLE_PORTFOLIO_HARVEST) {
      const portfolioHarvestTriggerValue = currentGenome.PORTFOLIO_HARVEST_TRIGGER_DEVIATION_PERCENT * 100;
      if (!portfolioHarvestState.flagged && currentPortfolioDeviationPercent >= portfolioHarvestTriggerValue) {
        portfolioHarvestState = { flagged: true, cycleCount: 0, flaggedAt: now, previousDeviationPercent: currentPortfolioDeviationPercent };
        // console.log(`📈 Portfolio flagged for Baseline Reset Harvest.`);
      } else if (portfolioHarvestState.flagged && currentPortfolioDeviationPercent < portfolioHarvestTriggerValue) {
        // console.log(`📉 Portfolio dropped below Baseline Reset Harvest trigger. Clearing flag.`);
        portfolioHarvestState = { flagged: false, cycleCount: 0, previousDeviationPercent: null, flaggedAt: null };
      }
      if (portfolioHarvestState.flagged) {
        const prevDev = portfolioHarvestState.previousDeviationPercent;
        if (prevDev !== null) {
          const currDev = currentPortfolioDeviationPercent;
          if (currDev < prevDev - PRECISION_THRESHOLD) { portfolioHarvestState.cycleCount++; }
          else if (currDev > prevDev + PRECISION_THRESHOLD) { portfolioHarvestState.cycleCount = Math.max(0, portfolioHarvestState.cycleCount - 1); }
        }
        portfolioHarvestState.previousDeviationPercent = currentPortfolioDeviationPercent;
      }
      if (portfolioHarvestState.flagged && portfolioHarvestState.cycleCount >= currentGenome.PORTFOLIO_HARVEST_CONFIRMATION_CYCLES) {
        // console.log(`🎉 Executing Portfolio Baseline Reset Harvest!`);
        portfolioHarvestExecutedThisCycle = true;
        let assetsSoldCount = 0;
        const sellPromises = []; const assetsToUpdateTimestamp = [];
        for (const row of portfolioSummary) {
          if (HARVEST_EXCLUDE.includes(row.Symbol) || !row.Baseline || row.Value <= row.Baseline) continue;
          const originalBaseline = row.Baseline;
          const surplusUSD = row.Value - originalBaseline;
          if (surplusUSD < currentGenome.MIN_ASSET_SURPLUS_FOR_PORTFOLIO_HARVEST) continue;
          const qtyToSell = surplusUSD / row.Price;
          const qtyStr = roundQty(row.Symbol, qtyToSell);
          if (parseFloat(qtyStr) > 0) {
            assetsSoldCount++;
            sellPromises.push((async () => {
              try {
                const sellResp = await this._placeSell(api, `${row.Symbol}-USD`, qtyStr, row.Price);
                if (sellResp?.id) {
                  const effectiveSellPrice = getEffectivePriceFromResp(sellResp, row.Price);
                  const settledSoldValue = getSettledValueFromResp(sellResp, qtyStr, row.Price);
                  const grossSoldValue = getGrossValueFromResp(sellResp, qtyStr, row.Price);
                  const totalFees = getTotalFeesFromResp(sellResp);

                  // Measure and update lastSlippage
                  const slippage = (row.Price - effectiveSellPrice) / row.Price;
                  const rStObj = this.ratchetState[row.Symbol] || { harvestModifier: 0.0, rebalanceModifier: 0.0, lastTradeSide: null, localCostBasis: 0.0, localQty: 0.0 };
                  rStObj.lastSlippage = clampSlippage(slippage);
                  _kalman.observe(row.Symbol, clampSlippage(slippage));
                  this.ratchetState[row.Symbol] = rStObj;

                  this._logTrade({ asset: row.Symbol, side: "SELL", quantity: qtyStr, price: effectiveSellPrice.toString(), clientOrderId: sellResp.client_order_id || sellResp.id, note: `Portfolio Baseline Reset Harvest`, grossValue: grossSoldValue, totalFees, settledValue: settledSoldValue });
                  if (row.Value < dynamicCriticalMass) {
                    snowballHarvestedAmount += settledSoldValue;
                  } else {
                    matureHarvestedAmount += settledSoldValue;
                  }
                  tokenBaselines[row.Symbol] = originalBaseline;
                  if (trailingState[row.Symbol]) delete trailingState[row.Symbol];
                  assetsToUpdateTimestamp.push(row.Symbol);

                  // Update Cash (Live & Shadow)
                  if (this.mode === 'LIVE') {
                    this.cashBalance += settledSoldValue;
                  }
                  // SHADOW MODE: Update Holdings & Cash (with 1% fee)
                  else if (this.mode === 'SHADOW') {
                    const soldQty = parseFloat(qtyStr);
                    if (this.holdings[row.Symbol]) {
                      this.holdings[row.Symbol].rawQuantity -= soldQty;
                      if (this.holdings[row.Symbol].rawQuantity < 0) this.holdings[row.Symbol].rawQuantity = 0;
                    }
                    this.cashBalance += settledSoldValue;
                  }

                  return settledSoldValue;
                }
                return 0;
              } catch (err) { console.error(`   ❌ Error P-Harvest sell ${row.Symbol}:`, err.message); return 0; }
            })());
          }
        }
        const harvestedValues = await Promise.all(sellPromises);
        harvestedAmount += harvestedValues.reduce((sum, val) => sum + val, 0);
        if (assetsSoldCount > 0) {
          anyTradesThisCycle = true; stateChanged = true;
          assetsToUpdateTimestamp.forEach(sym => { lastActionTimestamps[sym] = now; });
        }
        portfolioHarvestState = { flagged: false, cycleCount: 0, previousDeviationPercent: null, flaggedAt: null };
      }
    }

    // --- Individual Asset Harvest Logic ---
    if (!portfolioHarvestExecutedThisCycle) {
      for (const row of portfolioSummary) {
        const sym = row.Symbol; const currentBaseline = tokenBaselines[sym];
        if (HARVEST_EXCLUDE.includes(sym) || !currentBaseline || currentBaseline <= 0) continue;
        const curP = row.Price; const totalVal = row.usdValueNum; const currentDeviation = (totalVal - currentBaseline) / currentBaseline;
        // Initialize Ratchet State & Proactive Manual Trade Alignment Sync
        if (!this.ratchetState[sym]) {
          this.ratchetState[sym] = { harvestModifier: 0.0, rebalanceModifier: 0.0, lastTradeSide: null, localCostBasis: 0.0, localQty: 0.0 };
        }
        const rSt = this.ratchetState[sym];
        if (holdingDetails[sym]?.rawQuantity > 0) {
          const actualQty = holdingDetails[sym].rawQuantity;
          const oldQty = rSt.localQty || 0;
          const currentCost = rSt.localCostBasis || 0;

          if (oldQty <= 0 || currentCost <= 0) {
            rSt.localQty = actualQty;
            rSt.localCostBasis = currentBaseline / actualQty;
            if (this.mode === 'LIVE') {
              console.log(`ℹ️ [Cost Sync] Initialized cost basis for ${sym}: $${rSt.localCostBasis.toFixed(8)} (Qty: ${rSt.localQty.toFixed(4)})`);
            }
          } else if (Math.abs(actualQty - oldQty) > 0.0001) {
            if (actualQty > oldQty) {
              const addedQty = actualQty - oldQty;
              const oldValue = oldQty * currentCost;
              const addedValue = addedQty * curP;
              rSt.localCostBasis = (oldValue + addedValue) / actualQty;
              rSt.localQty = actualQty;
              if (this.mode === 'LIVE') {
                console.log(`ℹ️ [Cost Sync] External App Buy detected for ${sym}! Qty aligned from ${oldQty.toFixed(4)} to ${actualQty.toFixed(4)}. Updated Cost Basis: $${rSt.localCostBasis.toFixed(8)}`);
              }
            } else {
              rSt.localQty = actualQty;
              if (this.mode === 'LIVE') {
                console.log(`ℹ️ [Cost Sync] External App Sell detected for ${sym}! Qty aligned from ${oldQty.toFixed(4)} to ${actualQty.toFixed(4)}. Cost Basis kept at: $${rSt.localCostBasis.toFixed(8)}`);
              }
            }
            stateChanged = true;
          }
        } else if (rSt.localQty > 0) {
          if (this.mode === 'LIVE') {
            console.log(`ℹ️ [Cost Sync] External App Sellout detected for ${sym}! Wiping cost basis and modifiers.`);
          }
          rSt.localQty = 0.0;
          rSt.localCostBasis = 0.0;
          rSt.harvestModifier = 0.0;
          rSt.rebalanceModifier = 0.0;
          stateChanged = true;
        }

        // Fetch dynamic params
        const flatHarvestTrigger = getGenomicParam(currentGenome, 'FLAT_HARVEST_TRIGGER_PERCENT', sym);

        const hMod = rSt.harvestModifier || 0.0;
        const _defaultSlip = SLIPPAGE_BUFFERS[sym] || SLIPPAGE_BUFFERS.DEFAULT;
        const oracleFloorSell = _oracleSlipFloor(api, sym, 'sell');
        const oracleFloorBuy  = _oracleSlipFloor(api, sym, 'buy');
        const slipConfig = {
          sell: kalmanSlipCap(_kalman, sym, Math.min(oracleFloorSell, _defaultSlip.sell), Math.min(0.08, _defaultSlip.sell * 3)),
          buy:  kalmanSlipCap(_kalman, sym, Math.min(oracleFloorBuy,  _defaultSlip.buy),  Math.min(0.08, _defaultSlip.buy  * 3)),
        };
        const lastSlippage = (rSt.lastSlippage !== undefined && rSt.lastSlippage !== null) ? rSt.lastSlippage : slipConfig.sell;
        const apiSellSlip = (api && api.lastSpreads && api.lastSpreads[sym]) ? api.lastSpreads[sym].sell : null;
        const effectiveSellSlip = (apiSellSlip !== null) ? Math.max(apiSellSlip, lastSlippage) : lastSlippage;
        const effectiveHarvestTrigger = flatHarvestTrigger + hMod + effectiveSellSlip;
        const harvestTriggerValue = currentBaseline * (1 + effectiveHarvestTrigger);

        if (!trailingState[sym]) { trailingState[sym] = { flagged: false, harvestCycleCount: 0, flaggedAt: null, previousDeviation: null }; }
        let st = trailingState[sym];

        if (!st.flagged && totalVal >= harvestTriggerValue) {
          st = { flagged: true, harvestCycleCount: 0, flaggedAt: now, previousDeviation: currentDeviation };
          trailingState[sym] = st;
          stateChanged = true;
        } else if (st.flagged && totalVal < harvestTriggerValue) {
          delete trailingState[sym]; stateChanged = true; continue;
        }
        if (!st.flagged) continue;

        // Harvest Execution Logic
        const flaggedDuration = now - (st.flaggedAt || now);
        const baseHarvestCycles = getGenomicParam(currentGenome, 'HARVEST_CYCLE_THRESHOLD', sym);
        const requiredHarvestCycles = baseHarvestCycles;

        let shouldHarvest = false; let harvestType = "";

        if (st.previousDeviation !== null) {
          if (currentDeviation < st.previousDeviation - PRECISION_THRESHOLD) st.harvestCycleCount++;
          else if (currentDeviation > st.previousDeviation + PRECISION_THRESHOLD) st.harvestCycleCount = Math.max(0, st.harvestCycleCount - 1);
        }
        st.previousDeviation = currentDeviation;

        if (flaggedDuration > currentGenome.FORCED_HARVEST_TIMEOUT) { shouldHarvest = true; harvestType = "Forced"; }
        else if (st.harvestCycleCount >= requiredHarvestCycles) { shouldHarvest = true; harvestType = "Standard"; }

        if (shouldHarvest) {
          const surplus = totalVal - currentBaseline;
          const minSurplus = harvestType === "Forced" ? currentGenome.MIN_SURPLUS_FOR_FORCED_HARVEST : getGenomicParam(currentGenome, 'MIN_SURPLUS_FOR_HARVEST', sym);

          if (surplus >= minSurplus) {
            let harvestTakePct = getGenomicParam(currentGenome, 'HARVEST_TAKE_PERCENT', sym);
            if (harvestTakePct === undefined) harvestTakePct = 0.70; // Fallback

            // 💰 DYNAMIC LIQUIDITY OVERRIDE:
            // If Cash falls below the Crash Fund Threshold (10% of total portfolio value),
            // override harvestTakePct to 1.00 (100% to Cash) to prioritize rapid liquidity replenishment.
            const currentTotalPortfolioValue = portfolioSummary.reduce((sum, r) => sum + r.Value, 0);
            const currentCashPercent = this.cashBalance / Math.max(1, currentTotalPortfolioValue);
            const crashFundThreshold = currentGenome.CRASH_FUND_THRESHOLD_PERCENT ?? 0.10;
            if (currentCashPercent < crashFundThreshold) {
              harvestTakePct = 1.00;
              if (this.mode === 'LIVE' && !global.hasLoggedLiquidityOverride) {
                console.log(`💰 [Liquidity Priority] Cash at ${(currentCashPercent * 100).toFixed(1)}% < ${(crashFundThreshold * 100).toFixed(1)}% of portfolio. Temporarily harvesting 100% of surplus to replenish cash reserve.`);
                global.hasLoggedLiquidityOverride = true;
              }
            } else {
              global.hasLoggedLiquidityOverride = false;
            }

            const qtyToSell = (surplus * harvestTakePct) / curP;
            const retainedSurplusUSD = surplus * (1 - harvestTakePct);
            const qtyStr = roundQty(sym, qtyToSell);
            // Tier 2: Dust Protection
            if (checkMinTrade(parseFloat(qtyStr) * curP)) {
              if (parseFloat(qtyStr) > 0) {
                try {
                  console.log(`📉 Attempting ${harvestType} Harvest ${sym}`);
                  const sellResp = await this._placeSell(api, `${sym}-USD`, qtyStr, curP);
                  if (sellResp?.id) {
                    const effectiveSellPrice = getEffectivePriceFromResp(sellResp, curP);
                    const settledSoldValue = getSettledValueFromResp(sellResp, qtyStr, curP);
                    const grossSoldValue = getGrossValueFromResp(sellResp, qtyStr, curP);
                    const totalFees = getTotalFeesFromResp(sellResp);

                    // Measure and update lastSlippage
                    const slippage = (curP - effectiveSellPrice) / curP;
                    if (!this.ratchetState[sym]) {
                      this.ratchetState[sym] = { harvestModifier: 0.0, rebalanceModifier: 0.0, lastTradeSide: null, localCostBasis: 0.0, localQty: 0.0 };
                    }
                    this.ratchetState[sym].lastSlippage = clampSlippage(slippage);
                    _kalman.observe(sym, clampSlippage(slippage));
                    this._logTrade({ asset: sym, side: "SELL", quantity: qtyStr, price: effectiveSellPrice.toString(), clientOrderId: sellResp.client_order_id || sellResp.id, note: `${harvestType} Harvest`, grossValue: grossSoldValue, totalFees, settledValue: settledSoldValue });
                    if (totalVal < dynamicCriticalMass) {
                      snowballHarvestedAmount += settledSoldValue;
                    } else {
                      matureHarvestedAmount += settledSoldValue;
                    }
                    harvestedAmount += settledSoldValue; anyTradesThisCycle = true;

                    // Tier 1: Post-Mortem Event
                    if (this.mode === 'LIVE') {
                      this.postMortemEvents.push({
                        symbol: sym,
                        type: 'harvest',
                        surplusUSD: surplus, // Actual realized surplus (approx)
                        deviation: currentDeviation,
                        genomeSlice: { ...currentGenome } // Pass full genome for now, Dreamer filters
                      });
                    }

                    const targetAdjust = getGenomicParam(currentGenome, 'TARGET_ADJUST_PERCENT', sym);
                    tokenBaselines[sym] += retainedSurplusUSD; // Geometric Growth: structurally raise baseline
                    tokenBaselines[sym] *= (1 + targetAdjust); // Additional Ratchet Tension, if any

                    // Update Harvest Ratchet Modifier based on Local Cost Basis
                    if (!this.ratchetState[sym]) {
                      this.ratchetState[sym] = { harvestModifier: 0.0, rebalanceModifier: 0.0, lastTradeSide: null, localCostBasis: 0.0, localQty: 0.0 };
                    }
                    const rSt = this.ratchetState[sym];
                    const avgCost = rSt.localCostBasis || 0.0;

                    if (avgCost > 0 && effectiveSellPrice < avgCost) {
                      // Sold at a loss relative to running average cost: ratchet trigger out by +0.5%
                      rSt.harvestModifier = Math.min(0.02, rSt.harvestModifier + 0.005);
                      if (this.mode === 'LIVE') {
                        console.log(`⚠️ [RATCHET] ${sym} Harvest Sell at a loss (Sell Price: $${effectiveSellPrice.toFixed(8)} < Local Cost Basis: $${avgCost.toFixed(8)}). Widening Harvest Trigger by +0.5%. New Modifier: +${(rSt.harvestModifier * 100).toFixed(2)}%`);
                      }
                    } else {
                      // Profit Harvest: Keep trigger at current widened state as persistent regime shield (no reset)
                      if (this.mode === 'LIVE' && avgCost > 0) {
                        console.log(`🌸 [RATCHET] ${sym} Harvest Sell at a profit (Sell Price: $${effectiveSellPrice.toFixed(8)} >= Local Cost Basis: $${avgCost.toFixed(8)}). Modifier remains at: +${(rSt.harvestModifier * 100).toFixed(2)}%`);
                      }
                    }

                    // Decrement local inventory quantity
                    const soldQty = parseFloat(qtyStr);
                    rSt.localQty = Math.max(0, (rSt.localQty || 0) - soldQty);
                    if (rSt.localQty <= 0) {
                      rSt.localCostBasis = 0.0; // Reset cost basis and modifier if completely sold out
                      rSt.harvestModifier = 0.0;
                      rSt.rebalanceModifier = 0.0;
                    }

                    rSt.lastTradeSide = 'SELL';

                    lastActionTimestamps[sym] = now;

                    if (this.mode === 'LIVE') {
                      this.cashBalance += settledSoldValue;
                    }
                    else if (this.mode === 'SHADOW') {
                      // Tier 2: Real Transaction Costs (1% Slippage/Fee Model)
                      const soldQty = parseFloat(qtyStr);
                      if (this.holdings[sym]) {
                        this.holdings[sym].rawQuantity -= soldQty;
                        if (this.holdings[sym].rawQuantity < 0) this.holdings[sym].rawQuantity = 0;
                      }
                      // Sell: Proceeds = Value - 1%
                      this.cashBalance += settledSoldValue;
                    }

                    delete trailingState[sym]; stateChanged = true;
                  } else { st.harvestCycleCount = 0; stateChanged = true; }
                } catch (err) { console.error(`❌ Error Harvest ${sym}:`, err.message); }
              } else { delete trailingState[sym]; stateChanged = true; }
            } else { if (harvestType === "Forced") delete trailingState[sym]; else st.harvestCycleCount = 0; stateChanged = true; }
          }
        }
      }

      // --- Harvest Proceeds Allocation ---
      if (harvestedAmount > 0) {
        // 💰 CRASH FUND CHECK
        // Ensure we have 10% Cash Reserve before allocating to Risk Assets
        // Note: portfolioSummary has OLD asset values. this.cashBalance has NEW cash (inc. harvest).
        const currentTotalPortfolioValue = portfolioSummary.reduce((sum, r) => sum + r.Value, 0) - harvestedAmount + this.cashBalance;
        const currentCashPercent = this.cashBalance / Math.max(1, currentTotalPortfolioValue); // Avoid div/0
        const crashFundThreshold = currentGenome.CRASH_FUND_THRESHOLD_PERCENT ?? 0.10;

        if (currentCashPercent < crashFundThreshold) {
          if (this.mode === 'LIVE') {
            console.log(`💰 [CRASH FUND ACTIVE] Cash at ${(currentCashPercent * 100).toFixed(1)}% (Target: ${(crashFundThreshold * 100).toFixed(1)}%).`);
            console.log(`   → Portfolio Value: $${currentTotalPortfolioValue.toFixed(2)} | Cash: $${this.cashBalance.toFixed(2)}`);
            console.log(`   → Keeping 100% of Harvest ($${harvestedAmount.toFixed(2)}) in Cash Reserves.`);
          }
          // Kept 100% of Harvest in Cash. No allocations are executed.
        }
        else {
          // Unified Harvest Allocation (25% BTC / 25% ETH / 25% Reinvest / 25% Cash)
          // Applies to ALL harvested proceeds once the crash fund is satisfied.
          // All tokens — regardless of size — get the same split treatment.
          if (harvestedAmount >= (currentGenome.MIN_HARVEST_TO_ALLOCATE || 0.25)) {
            const amountForBTC = harvestedAmount * (currentGenome.HARVEST_ALLOC_BTC_PERCENT ?? 0.25);
            const amountForETH = harvestedAmount * (currentGenome.HARVEST_ALLOC_ETH_PERCENT ?? 0.25);
            const amountForReinvest = harvestedAmount * (currentGenome.HARVEST_ALLOC_REINVEST_PERCENT ?? 0.25);

            if (this.mode === 'LIVE') {
              console.log(`🌾 Harvest Allocation ($${harvestedAmount.toFixed(2)} total): Safety BTC $${amountForBTC.toFixed(2)} | Safety ETH $${amountForETH.toFixed(2)} | Reinvest $${amountForReinvest.toFixed(2)} | Cash $${(harvestedAmount * (1 - (currentGenome.HARVEST_ALLOC_BTC_PERCENT ?? 0.25) - (currentGenome.HARVEST_ALLOC_ETH_PERCENT ?? 0.25) - (currentGenome.HARVEST_ALLOC_REINVEST_PERCENT ?? 0.25))).toFixed(2)}`);
            }

            // 1. BTC Buy Execution
            if (amountForBTC >= (currentGenome.MIN_BTC_BUY_USD || 0.10)) {
              const btcP = portfolioSummary.find(r => r.Symbol === 'BTC')?.Price || (await api?.getQuotes(['BTC']))?.['BTC'];
              if (btcP > 0 && this.cashBalance >= amountForBTC) {
                const qty = roundQty('BTC', amountForBTC / btcP);
                if (parseFloat(qty) > 0 && checkMinQuantity('BTC', qty)) {
                  const resp = await this._placeBuy(api, 'BTC-USD', qty, btcP);
                  if (resp?.id) {
                    const confirmedOrder = resp;
                    if (confirmedOrder) {
                      const effectivePrice = getEffectivePriceFromResp(confirmedOrder, btcP);
                      const rawQty = parseFloat(confirmedOrder.filled_asset_quantity);
                      const filledQty = (rawQty > 0) ? rawQty : parseFloat(qty);
                      this._logTrade({ asset: 'BTC', side: 'BUY', quantity: filledQty.toString(), price: effectivePrice.toString(), clientOrderId: confirmedOrder.client_order_id || confirmedOrder.id, note: 'Classic BTC Buy' });
                      tokenBaselines['BTC'] = ((holdingDetails['BTC']?.rawQuantity || 0) + filledQty) * effectivePrice;
                      lastActionTimestamps['BTC'] = now; stateChanged = true;
                      this.cashBalance -= amountForBTC;
                      if (this.cashBalance < 0) this.cashBalance = 0;
                      if (this.mode === 'SHADOW') {
                        if (!this.holdings['BTC']) this.holdings['BTC'] = { rawQuantity: 0 };
                        this.holdings['BTC'].rawQuantity += filledQty;
                      }
                    }
                  }
                }
              }
            }

            // 2. ETH Buy Execution
            if (amountForETH >= (currentGenome.MIN_ETH_BUY_USD || 0.25)) {
              const ethP = portfolioSummary.find(r => r.Symbol === 'ETH')?.Price || (await api?.getQuotes(['ETH']))?.['ETH'];
              if (ethP > 0 && this.cashBalance >= amountForETH) {
                const qty = roundQty('ETH', amountForETH / ethP);
                if (parseFloat(qty) > 0 && checkMinQuantity('ETH', qty)) {
                  const resp = await this._placeBuy(api, 'ETH-USD', qty, ethP);
                  if (resp?.id) {
                    const confirmedOrder = resp;
                    if (confirmedOrder) {
                      const effectivePrice = getEffectivePriceFromResp(confirmedOrder, ethP);
                      const rawQty = parseFloat(confirmedOrder.filled_asset_quantity);
                      const filledQty = (rawQty > 0) ? rawQty : parseFloat(qty);
                      this._logTrade({ asset: 'ETH', side: 'BUY', quantity: filledQty.toString(), price: effectivePrice.toString(), clientOrderId: confirmedOrder.client_order_id || confirmedOrder.id, note: 'Classic ETH Buy' });
                      tokenBaselines['ETH'] = ((holdingDetails['ETH']?.rawQuantity || 0) + filledQty) * effectivePrice;
                      lastActionTimestamps['ETH'] = now; stateChanged = true;
                      this.cashBalance -= amountForETH;
                      if (this.cashBalance < 0) this.cashBalance = 0;
                      if (this.mode === 'SHADOW') {
                        if (!this.holdings['ETH']) this.holdings['ETH'] = { rawQuantity: 0 };
                        this.holdings['ETH'].rawQuantity += filledQty;
                      }
                    }
                  }
                }
              }
            }

            // 3. Priority Reinvest Execution (Deepest negative deviation dip buy)
            if (amountForReinvest >= (currentGenome.MIN_REINVEST_BUY_USD || 0.25)) {
              const threshold = currentGenome.MIN_NEGATIVE_DEVIATION_FOR_REINVEST || -0.010;
              let deepestDev = threshold; // Only consider dips below/equal to threshold
              let reinvestTarget = null;
              let bypassedQueue = false;

              // First pass: try to find the deepest dip excluding the recent reinvest history
              for (const row of portfolioSummary) {
                const sym = row.Symbol;
                if (REBALANCE_EXCLUDE.includes(sym) || !tokenBaselines[sym]) continue;
                if (this.reinvestHistory && this.reinvestHistory.includes(sym)) continue;
                const dev = (row.Value - tokenBaselines[sym]) / tokenBaselines[sym];
                if (dev <= deepestDev) {
                  deepestDev = dev;
                  reinvestTarget = row;
                }
              }

              // Fallback pass: if no target found (e.g. all candidates with negative deviation are in the history),
              // select the candidate from history queue that has been there the longest (oldest first) to ensure correct cycling.
              if (!reinvestTarget && this.reinvestHistory && this.reinvestHistory.length > 0) {
                for (const sym of this.reinvestHistory) {
                  if (REBALANCE_EXCLUDE.includes(sym) || !tokenBaselines[sym]) continue;
                  const row = portfolioSummary.find(r => r.Symbol === sym);
                  if (!row) continue;
                  const dev = (row.Value - tokenBaselines[sym]) / tokenBaselines[sym];
                  if (dev <= threshold) {
                    reinvestTarget = row;
                    deepestDev = dev;
                    bypassedQueue = true;
                    break; // Pick the oldest one first to cycle correctly
                  }
                }
              }

              if (reinvestTarget && this.cashBalance >= amountForReinvest) {
                const sym = reinvestTarget.Symbol;
                const p = reinvestTarget.Price;
                const qty = roundQty(sym, amountForReinvest / p);
                if (parseFloat(qty) > 0 && checkMinQuantity(sym, qty)) {
                  if (this.mode === 'LIVE') {
                    if (bypassedQueue) {
                      console.log(`   ⚠️ [Rotational Reinvest] All candidate laggards are in the recency queue. Bypassing queue restriction.`);
                    }
                    console.log(`   🚀 Reinvesting $${amountForReinvest.toFixed(2)} into deepest dip: ${sym} (${(deepestDev * 100).toFixed(2)}% deviation)`);
                  }
                  const resp = await this._placeBuy(api, `${sym}-USD`, qty, p);
                  if (resp?.id) {
                    const confirmedOrder = resp;
                    if (confirmedOrder) {
                      const effectivePrice = getEffectivePriceFromResp(confirmedOrder, p);
                      const rawQty = parseFloat(confirmedOrder.filled_asset_quantity);
                      const filledQty = (rawQty > 0) ? rawQty : parseFloat(qty);

                      // Measure and update lastSlippage
                      const slippage = (effectivePrice - p) / p;
                      if (!this.ratchetState[sym]) {
                        this.ratchetState[sym] = { harvestModifier: 0.0, rebalanceModifier: 0.0, lastTradeSide: null, localCostBasis: 0.0, localQty: 0.0 };
                      }
                      this.ratchetState[sym].lastSlippage = clampSlippage(slippage);
                      _kalman.observe(sym, clampSlippage(slippage));
                      // Guarantee cost is never 0: every reinvest buy spends the allocation amount approx
                      const cost = (filledQty > 0 && effectivePrice > 0) ? filledQty * effectivePrice : amountForReinvest;

                      this._logTrade({ asset: sym, side: 'BUY', quantity: filledQty.toString(), price: effectivePrice.toString(), clientOrderId: confirmedOrder.client_order_id || confirmedOrder.id, note: 'Classic Reinvestment Buy' });

                      // Hybrid Logic: Adjust baseline upward by reinvestment cost to protect rotated capital
                      tokenBaselines[sym] = (tokenBaselines[sym] || 0) + cost;

                      // Append to reinvest history queue
                      if (!this.reinvestHistory) this.reinvestHistory = [];
                      const queueIdx = this.reinvestHistory.indexOf(sym);
                      if (queueIdx !== -1) {
                        this.reinvestHistory.splice(queueIdx, 1);
                      }
                      this.reinvestHistory.push(sym);
                      const maxQueueSize = currentGenome.REINVEST_COOLDOWN_QUEUE_SIZE || 5;
                      while (this.reinvestHistory.length > maxQueueSize) {
                        this.reinvestHistory.shift();
                      }
                      if (this.mode === 'LIVE') {
                        console.log(`   🔄 [Rotational Reinvest] Added ${sym} to recency queue. Current Queue: [${this.reinvestHistory.join(', ')}]`);
                      }

                      lastActionTimestamps[sym] = now; stateChanged = true;
                      this.cashBalance -= cost;
                      if (this.cashBalance < 0) this.cashBalance = 0;
                      if (this.mode === 'SHADOW') {
                        if (!this.holdings[sym]) this.holdings[sym] = { rawQuantity: 0 };
                        this.holdings[sym].rawQuantity += filledQty;
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      // --- Rebalancing Logic ---
      for (const row of portfolioSummary) {
        const sym = row.Symbol; const currentBaseline = tokenBaselines[sym];
        if (REBALANCE_EXCLUDE.includes(sym) || !currentBaseline || currentBaseline <= 0 || trailingState[sym]?.flagged) { if (rebalanceState[sym]) delete rebalanceState[sym]; continue; }
        const totalVal = row.Value; const curP = row.Price;

        // Initialize ratchet state
        if (!this.ratchetState[sym]) {
          this.ratchetState[sym] = { harvestModifier: 0.0, rebalanceModifier: 0.0, lastTradeSide: null, localCostBasis: 0.0, localQty: 0.0 };
        }
        const ratSt = this.ratchetState[sym];

        const flatRebalanceTrigger = getGenomicParam(currentGenome, 'FLAT_REBALANCE_TRIGGER_PERCENT', sym);

        const rMod = ratSt.rebalanceModifier || 0.0;
        let effectiveRebalanceTrigger = flatRebalanceTrigger + rMod;
        if (isGlobalRiskSignalActive) {
          effectiveRebalanceTrigger = (flatRebalanceTrigger + rMod) * (currentGenome.CRASH_PROTECTION_THRESHOLD_INCREASE || 2);
          if (this.mode === 'LIVE' && !global.hasLoggedCPTrigger) {
            console.log(`🛡️ [Crash Protection ACTIVE] Widening rebalance triggers for API safety.`);
            global.hasLoggedCPTrigger = true;
          }
        } else {
          global.hasLoggedCPTrigger = false;
        }

        const _defaultSlip = SLIPPAGE_BUFFERS[sym] || SLIPPAGE_BUFFERS.DEFAULT;
        const oracleFloorSell = _oracleSlipFloor(api, sym, 'sell');
        const oracleFloorBuy  = _oracleSlipFloor(api, sym, 'buy');
        const slipConfig = {
          sell: kalmanSlipCap(_kalman, sym, Math.min(oracleFloorSell, _defaultSlip.sell), Math.min(0.08, _defaultSlip.sell * 3)),
          buy:  kalmanSlipCap(_kalman, sym, Math.min(oracleFloorBuy,  _defaultSlip.buy),  Math.min(0.08, _defaultSlip.buy  * 3)),
        };
        const lastSlippage = (ratSt.lastSlippage !== undefined && ratSt.lastSlippage !== null) ? ratSt.lastSlippage : slipConfig.buy;
        const apiBuySlip = (api && api.lastSpreads && api.lastSpreads[sym]) ? api.lastSpreads[sym].buy : null;
        const effectiveBuySlip = (apiBuySlip !== null) ? Math.max(apiBuySlip, lastSlippage) : lastSlippage;
        effectiveRebalanceTrigger += effectiveBuySlip;

        const rebalanceTriggerValue = currentBaseline * (1 - effectiveRebalanceTrigger);

        // HYSTERESIS: Prevent flip-flopping by requiring a small recovery buffer (0.2%) to clear state
        const recoveryBuffer = rebalanceState[sym] ? 1.002 : 1.0;

        // --- ZERO BALANCE GUARD ---
        // If the asset value has dropped near zero (user sold it all), do NOT attempt to rebalance.
        // We don't want to throw good money after a dead asset unless the user explicitly buys back in.
        if (totalVal < 1.0) {
          if (rebalanceState[sym]) {
            if (this.mode === 'LIVE') {
              console.log(`📉 Dropping Rebalance for ${sym} (Value < $1.00 - Assuming Fully Sold).`);
            }
            delete rebalanceState[sym];
          }
          continue;
        }

        if (totalVal >= rebalanceTriggerValue * recoveryBuffer) {
          if (rebalanceState[sym]) {
            if (this.mode === 'LIVE') console.log(`📈 Clearing Rebalance ${sym} (Recovered to $${totalVal.toFixed(2)})`);
            delete rebalanceState[sym];
          }
          continue;
        }

        if (!rebalanceState[sym]) {
          rebalanceState[sym] = { triggered: true, triggeredAt: now, rebalancePosCycleCount: 0, attemptCount: 0, cooldownUntil: 0, currentBaselineWhenTriggered: currentBaseline, previousDeviation: (totalVal - currentBaseline) / currentBaseline };
          if (this.mode === 'LIVE') console.log(`⚖️ ${sym} Rebalance Triggered.`);
        }
        let rSt = rebalanceState[sym];

        // Forced Rebalance Check
        if (now - rSt.triggeredAt > currentGenome.FORCE_REBALANCE_TIMEOUT) {
          const shortfall = rSt.currentBaselineWhenTriggered - totalVal;
          let buyUSD = shortfall * currentGenome.FORCE_REBALANCE_SHORTFALL_PERCENT;
          if (buyUSD >= currentGenome.MIN_FORCED_REBALANCE_USD) {
            let qty = roundQty(sym, buyUSD / curP);
            const minQty = MIN_ORDER_QTY_MAP[sym];
            if (minQty && parseFloat(qty) < minQty) {
              const requiredMinUSD = minQty * curP;
              if (this.cashBalance >= requiredMinUSD) {
                qty = minQty.toString();
                buyUSD = requiredMinUSD;
                if (this.mode === 'LIVE') {
                  console.log(`⚠️ [API Safety Adjustment] Up-sized forced rebalance for ${sym} from calculated quantity ${roundQty(sym, shortfall * currentGenome.FORCE_REBALANCE_SHORTFALL_PERCENT / curP)} to minimum required ${minQty} ($${requiredMinUSD.toFixed(2)})`);
                }
              }
            }
            if (parseFloat(qty) > 0 && this.cashBalance >= buyUSD) {
              const resp = await this._placeBuy(api, `${sym}-USD`, qty, curP);
              if (resp?.id) {
                const effectivePrice = getEffectivePriceFromResp(resp, curP);

                // Measure and update lastSlippage
                const slippage = (effectivePrice - curP) / curP;
                if (!this.ratchetState[sym]) {
                  this.ratchetState[sym] = { harvestModifier: 0.0, rebalanceModifier: 0.0, lastTradeSide: null, localCostBasis: 0.0, localQty: 0.0 };
                }
                this.ratchetState[sym].lastSlippage = clampSlippage(slippage);
                _kalman.observe(sym, clampSlippage(slippage));
                this._logTrade({ asset: sym, side: 'BUY', quantity: qty, price: effectivePrice.toString(), clientOrderId: resp.client_order_id || resp.id, note: 'Forced Rebalance' });
                anyTradesThisCycle = true;
                // Tier 1: Post-Mortem Event (Forced Rebalance is a significant event)
                if (this.mode === 'LIVE') {
                  this.postMortemEvents.push({
                    symbol: sym,
                    type: 'rebalance', // Treat forced rebalance as event
                    shortfallUSD: shortfall,
                    deviation: (totalVal - rSt.currentBaselineWhenTriggered) / rSt.currentBaselineWhenTriggered,
                    genomeSlice: { ...currentGenome }
                  });
                }
                if (true) {
                  const targetAdjust = getGenomicParam(currentGenome, 'TARGET_ADJUST_PERCENT', sym);
                  tokenBaselines[sym] *= (1 - targetAdjust);
                }

                // Update Local Cost Basis & Rebalance Ratchet State
                if (!this.ratchetState[sym]) {
                  this.ratchetState[sym] = { harvestModifier: 0.0, rebalanceModifier: 0.0, lastTradeSide: null, localCostBasis: 0.0, localQty: 0.0 };
                }
                const ratSt = this.ratchetState[sym];

                const confirmedBuy = resp;
                const rawQty = parseFloat(confirmedBuy.filled_asset_quantity);
                const filledQty = (rawQty > 0) ? rawQty : parseFloat(qty);

                if (filledQty > 0 && effectivePrice > 0) {
                  const oldCostVal = (ratSt.localQty || 0) * (ratSt.localCostBasis || 0);
                  const newBuyVal = filledQty * effectivePrice;
                  ratSt.localQty = (ratSt.localQty || 0) + filledQty;
                  ratSt.localCostBasis = (oldCostVal + newBuyVal) / ratSt.localQty;
                  if (this.mode === 'LIVE') {
                    console.log(`📈 [COST BASIS] ${sym} Forced Rebalance Buy filled! Qty: ${filledQty.toFixed(4)} @ $${effectivePrice.toFixed(8)}. Updated Local Cost Basis: $${ratSt.localCostBasis.toFixed(8)} (Total Qty: ${ratSt.localQty.toFixed(4)})`);
                  }
                }

                if (ratSt.lastTradeSide === 'BUY') {
                  ratSt.rebalanceModifier = Math.min(0.02, ratSt.rebalanceModifier + 0.005);
                  if (this.mode === 'LIVE') {
                    console.log(`🚨 [RATCHET] ${sym} Consecutive Rebalance Buy! Catching freefall. Widening Rebalance Trigger by +0.5%. New Modifier: +${(ratSt.rebalanceModifier * 100).toFixed(2)}%`);
                  }
                }
                ratSt.lastTradeSide = 'BUY';

                lastActionTimestamps[sym] = now; stateChanged = true; delete rebalanceState[sym];

                // TRACK CASH LOCALLY (Live & Shadow)
                // Forced Rebalance: Cost + Fee (1%)
                const cost = buyUSD * (this.mode === 'SHADOW' ? 1.01 : 1.00);
                this.cashBalance -= cost;
                if (this.cashBalance < 0) this.cashBalance = 0;
                continue;
              }
            }
          }
        }

        const currentDeviation = (totalVal - currentBaseline) / currentBaseline;
        if (rSt.previousDeviation !== null) {
          if (currentDeviation > rSt.previousDeviation + PRECISION_THRESHOLD) rSt.rebalancePosCycleCount++;
          else if (currentDeviation < rSt.previousDeviation - PRECISION_THRESHOLD) rSt.rebalancePosCycleCount = Math.max(0, rSt.rebalancePosCycleCount - 1);
        }
        rSt.previousDeviation = currentDeviation;

        const basePosThreshold = getGenomicParam(currentGenome, 'REBALANCE_POSITIVE_THRESHOLD', sym);
        const reqCycles = basePosThreshold;

        if (rSt.rebalancePosCycleCount >= reqCycles && now >= rSt.cooldownUntil) {
          const shortfall = rSt.currentBaselineWhenTriggered - totalVal;
          let partialRecovery = Math.min(1.0, getGenomicParam(currentGenome, 'PARTIAL_RECOVERY_PERCENT', sym));
          if (isGlobalRiskSignalActive) {
            partialRecovery = currentGenome.CRASH_PROTECTION_PARTIAL_RECOVERY_PERCENT || 0.33;
          }
          let buyUSD = shortfall * partialRecovery;

          // INSUFFICIENT FUNDS HANDLING: Clamp to available cash if we have at least minimum
          if (buyUSD > this.cashBalance) {
            if (this.cashBalance >= currentGenome.MIN_PARTIAL_REBALANCE_USD) {
              if (this.mode === 'LIVE') console.log(`⚠️ Cash Constrained Rebalance: Wanted $${buyUSD.toFixed(2)} -> Buy Max Available $${this.cashBalance.toFixed(2)}`);
              buyUSD = this.cashBalance * 0.95; // Leave 5% buffer for slippage/fees
            }
          }

          if (buyUSD >= currentGenome.MIN_PARTIAL_REBALANCE_USD) {
            let qty = roundQty(sym, buyUSD / curP);
            const minQty = MIN_ORDER_QTY_MAP[sym];
            if (minQty && parseFloat(qty) < minQty) {
              const requiredMinUSD = minQty * curP;
              if (this.cashBalance >= requiredMinUSD) {
                qty = minQty.toString();
                buyUSD = requiredMinUSD;
                if (this.mode === 'LIVE') {
                  console.log(`⚠️ [API Safety Adjustment] Up-sized standard rebalance for ${sym} from calculated quantity ${roundQty(sym, shortfall * partialRecovery / curP)} to minimum required ${minQty} ($${requiredMinUSD.toFixed(2)})`);
                }
              }
            }
            if (parseFloat(qty) > 0 && this.cashBalance >= buyUSD) {
              const resp = await this._placeBuy(api, `${sym}-USD`, qty, curP);
              if (resp?.id) {
                const effectivePrice = getEffectivePriceFromResp(resp, curP);

                // Measure and update lastSlippage
                const slippage = (effectivePrice - curP) / curP;
                if (!this.ratchetState[sym]) {
                  this.ratchetState[sym] = { harvestModifier: 0.0, rebalanceModifier: 0.0, lastTradeSide: null, localCostBasis: 0.0, localQty: 0.0 };
                }
                this.ratchetState[sym].lastSlippage = clampSlippage(slippage);
                _kalman.observe(sym, clampSlippage(slippage));
                this._logTrade({ asset: sym, side: 'BUY', quantity: qty, price: effectivePrice.toString(), clientOrderId: resp.client_order_id || resp.id, note: 'Rebalance Buy' });
                anyTradesThisCycle = true;
                // Tier 1: Post-Mortem Event
                if (this.mode === 'LIVE') {
                  this.postMortemEvents.push({
                    symbol: sym,
                    type: 'rebalance',
                    shortfallUSD: shortfall,
                    deviation: (totalVal - rSt.currentBaselineWhenTriggered) / rSt.currentBaselineWhenTriggered,
                    genomeSlice: { ...currentGenome }
                  });
                }
                if (true) {
                  const targetAdjust = getGenomicParam(currentGenome, 'TARGET_ADJUST_PERCENT', sym);
                  tokenBaselines[sym] *= (1 - targetAdjust);
                }

                // Update Local Cost Basis & Rebalance Ratchet State
                if (!this.ratchetState[sym]) {
                  this.ratchetState[sym] = { harvestModifier: 0.0, rebalanceModifier: 0.0, lastTradeSide: null, localCostBasis: 0.0, localQty: 0.0 };
                }
                const ratSt = this.ratchetState[sym];

                const confirmedBuy = resp;
                const rawQty = parseFloat(confirmedBuy.filled_asset_quantity);
                const filledQty = (rawQty > 0) ? rawQty : parseFloat(qty);

                if (filledQty > 0 && effectivePrice > 0) {
                  const oldCostVal = (ratSt.localQty || 0) * (ratSt.localCostBasis || 0);
                  const newBuyVal = filledQty * effectivePrice;
                  ratSt.localQty = (ratSt.localQty || 0) + filledQty;
                  ratSt.localCostBasis = (oldCostVal + newBuyVal) / ratSt.localQty;
                  if (this.mode === 'LIVE') {
                    console.log(`📈 [COST BASIS] ${sym} Rebalance Buy filled! Qty: ${filledQty.toFixed(4)} @ $${effectivePrice.toFixed(8)}. Updated Local Cost Basis: $${ratSt.localCostBasis.toFixed(8)} (Total Qty: ${ratSt.localQty.toFixed(4)})`);
                  }
                }

                if (ratSt.lastTradeSide === 'BUY') {
                  ratSt.rebalanceModifier = Math.min(0.02, ratSt.rebalanceModifier + 0.005);
                  if (this.mode === 'LIVE') {
                    console.log(`🚨 [RATCHET] ${sym} Consecutive Rebalance Buy! Catching freefall. Widening Rebalance Trigger by +0.5%. New Modifier: +${(ratSt.rebalanceModifier * 100).toFixed(2)}%`);
                  }
                }
                ratSt.lastTradeSide = 'BUY';

                lastActionTimestamps[sym] = now; stateChanged = true;

                // TRACK CASH LOCALLY (Live & Shadow)
                const cost = buyUSD;
                const costWithFee = this.mode === 'SHADOW' ? cost * 1.01 : cost; // 1% buy fee
                this.cashBalance -= costWithFee;
                if (this.cashBalance < 0) this.cashBalance = 0;

                // SHADOW: Update holdings
                if (this.mode === 'SHADOW') {
                  if (!this.holdings[sym]) this.holdings[sym] = { rawQuantity: 0 };
                  this.holdings[sym].rawQuantity += parseFloat(qty);
                }

                rSt.attemptCount++; rSt.rebalancePosCycleCount = 0; rSt.previousDeviation = null;
                const maxAttempts = getGenomicParam(currentGenome, 'MAX_REBALANCE_ATTEMPTS', sym);

                // Using the new rebalance trigger logic (fetched via getGenomicParam) for consistency
                if (totalVal + buyUSD >= rSt.currentBaselineWhenTriggered * (1 - effectiveRebalanceTrigger)) delete rebalanceState[sym];
                else if (rSt.attemptCount >= maxAttempts) rSt.cooldownUntil = now + currentGenome.REBALANCE_COOLDOWN;
              } else {
                // ⚠️ Order placed but API returned no ID — silent failure. Log for diagnosis.
                if (this.mode === 'LIVE') {
                  console.warn(`⚠️ [REBALANCE FAIL] ${sym} buy rejected/no-ID. Qty: ${qty} (~$${buyUSD.toFixed(2)}) @ $${curP?.toFixed(5)} | Cash: $${this.cashBalance.toFixed(2)} | Resp: ${JSON.stringify(resp)}`);
                }
                rSt.rebalancePosCycleCount = 0; // Reset momentum — re-wait before retry
              }
            }
          }
        }
      }

      // ========================================================
      // 🐛 THE HYBRID "STABLECOIN SNOWBALL BANK" & "WORM SPAWNER" ENGINE
      // ========================================================
      const activeHoldings = holdingDetails || this.holdings;
      const currentTotalPortfolioValue = portfolioSummary.reduce((sum, r) => sum + r.Value, 0) + this.cashBalance;
      const crashFundThreshold = currentGenome.CRASH_FUND_THRESHOLD_PERCENT ?? 0.10;
      const crashFundUSD = currentTotalPortfolioValue * crashFundThreshold;
      // Kelly-sized spawn cost: f* × portfolio, floored at MIN_SPAWN_COST_USD.
      // Falls back to the constant when trade history is insufficient (< 5 closed rounds).
      const _kellyF = this._historyAnalyzer.portfolioKellyFraction();
      const spawnCost = kellySpawnCost(
        _kellyF,
        currentTotalPortfolioValue,
        SNOWBALL_CONFIG.MIN_SPAWN_COST_USD || 30,
        SNOWBALL_CONFIG.MAX_SPAWN_COST_USD || 500,
      );

      // Find next unheld queue token (fluid horizontal expansion)
      const MAX_HOLDINGS = SNOWBALL_CONFIG.MAX_HOLDINGS ?? 13;
      const currentHoldingCount = portfolioSummary.filter(r =>
        !HARVEST_EXCLUDE.includes(r.Symbol) && (activeHoldings[r.Symbol]?.rawQuantity || 0) > 0
      ).length;

      // Refresh alpha source from the API. Run at most once per cycle to keep
      // the engine compute-free. The result is a ranked list of symbols the
      // market is shaping right now (5-min WS tape; falls back to 24h gainers).
      const alphaRanked = await this._refreshAlphaCandidates(api);
      const _candidateFilter = (sym) =>
        !HARVEST_EXCLUDE.includes(sym) &&
        (!tokenBaselines[sym] || tokenBaselines[sym] <= 0) &&
        (!activeHoldings[sym] || (activeHoldings[sym].rawQuantity || 0) <= 0) &&
        // Skip symbols with recent price-fetch failures (5-minute cooldown)
        (!this._priceFetchFailures.get(sym) || (now - this._priceFetchFailures.get(sym)) > 5 * 60 * 1000);

      // Spawn queue is the union of ranked alpha + the static fallback map,
      // with alpha FIRST in iteration order. This way real movers get traded
      // BEFORE the static fallback map picks dumb-shit crypto. The static
      // map remains the safety net when the alpha source is cold.
      const spawnQueue = [
        ...(alphaRanked || []).map(e => e.symbol),
        ...Object.keys(MIN_ORDER_QTY_MAP),
      ];

      const candidateUniverse = currentHoldingCount < MAX_HOLDINGS
        ? [...new Set(spawnQueue.filter(_candidateFilter))]
        : [];
      let spawnPriceMap = priceMap || {};

      // Warm the public WS price spine in bulk before choosing a spawn target.
      // Do not discover prices by hammering getQuotes([sym]) one candidate at a time.
      // ticker_batch is the market-data transport; if no tick arrives, skip.
      if (candidateUniverse.length > 0 && typeof api?.waitForWsPriceMap === 'function') {
        const warmLimit = SNOWBALL_CONFIG.SPAWN_PRICE_WARMUP_LIMIT ?? 120;
        const warmSymbols = candidateUniverse.slice(0, warmLimit);
        const warmed = await api.waitForWsPriceMap(warmSymbols, 6_000, 1).catch(() => ({}));
        if (warmed && Object.keys(warmed).length > 0) {
          spawnPriceMap = { ...spawnPriceMap, ...warmed };
        }
      }

      const nextSym = currentHoldingCount < MAX_HOLDINGS
        ? (candidateUniverse.find(sym => spawnPriceMap?.[sym] > 0) || candidateUniverse[0] || null)
        : null;

      if (nextSym) {
        if (this.cashBalance >= crashFundUSD + spawnCost) {
          // Uniform spawn path — single code path regardless of executor. The router
          // is `_executeFill`, which selects sim vs live fill source internally but
          // is otherwise the same record-and-mutate spine for both modes. The audit
          // ringbuffer records every fill so calibration/state are identical.
          const hydrationCost = spawnCost;
          // Price source priority: explicit priceMap (test param) > WS-warmed price map > portfolioSummary > WS getQuotes wait.
          // getQuotes is WS-only; it must not fall back to per-symbol REST.
          const buyP = (priceMap && priceMap[nextSym] && priceMap[nextSym] > 0)
            ? priceMap[nextSym]
            : (spawnPriceMap && spawnPriceMap[nextSym] && spawnPriceMap[nextSym] > 0)
              ? spawnPriceMap[nextSym]
              : (portfolioSummary.find(r => r.Symbol === nextSym)?.Price)
                || ((await api?.getQuotes?.([nextSym]))?.[nextSym]);

          if (!buyP || buyP <= 0) {
            // Record failure for cooldown — avoid spamming the same symbol every cycle
            this._priceFetchFailures.set(nextSym, now);
            console.warn(`⚠️ [MITOSIS] Could not fetch price for ${nextSym}, skipping spawn (5min cooldown)`);
          } else {
            const buyQtyStr = roundQty(nextSym, hydrationCost / buyP);
            if (parseFloat(buyQtyStr) > 0 && checkMinQuantity(nextSym, buyQtyStr)) {
              try {
                const confirmedBuy = await this._placeBuy(api, `${nextSym}-USD`, buyQtyStr, buyP);
                if (confirmedBuy?.id) {
                  // The fill shape is identical regardless of executor (sim or live)
                  const rawQty = parseFloat(confirmedBuy.filled_asset_quantity);
                  const filledQty = (rawQty > 0) ? rawQty : parseFloat(buyQtyStr);
                  const effectivePrice = getEffectivePriceFromResp(confirmedBuy, buyP);

                  // baseline initialized to spawnCost regardless of mode
                  tokenBaselines[nextSym] = spawnCost;
                  lastActionTimestamps[nextSym] = now;
                  stateChanged = true;

                  // Reflect the new fill into internal holdings so subsequent cycles
                  // see the asset as held. In LIVE this matches Coinbase; in SIM this
                  // is the source of truth (no exchange to ask).
                  if (!this.holdings[nextSym]) this.holdings[nextSym] = { rawQuantity: 0 };
                  this.holdings[nextSym].rawQuantity = (parseFloat(this.holdings[nextSym].rawQuantity) || 0) + filledQty;

                  // slippage → ratchet → kalman observation (uniform)
                  const slippage = (effectivePrice - buyP) / buyP;
                  const sym = nextSym;
                  const clamped = clampSlippage(slippage);
                  this.ratchetState[sym] = {
                    harvestModifier: 0.0,
                    rebalanceModifier: 0.0,
                    lastSlippage: clamped,
                    lastTradeSide: 'BUY',
                    localCostBasis: effectivePrice,
                    localQty: filledQty,
                  };
                  _kalman.observe(sym, clamped);

                  // Cost basis init recorded above (ratchetState[sym] carries the cost basis).
                  const actualCost = filledQty * effectivePrice;
                  this._logTrade({ asset: nextSym, side: 'BUY', quantity: filledQty.toString(), price: effectivePrice.toString(), clientOrderId: confirmedBuy.client_order_id || confirmedBuy.id, note: 'Mitosis 100% Spawn Buy' });

                  anyTradesThisCycle = true;
                  this.cashBalance -= actualCost;
                  if (this.cashBalance < 0) this.cashBalance = 0;
                  if (this.mode === 'LIVE' && typeof globalThis.saveState === 'function') globalThis.saveState();
                  if (this.executor === 'live') {
                    console.log(`✅ [MITOSIS COMPLETE] Spawned ${nextSym} with baseline $${spawnCost.toFixed(2)}. Hydrated 100%: $${actualCost.toFixed(2)}.`);
                  } else {
                    // Same log line, different gate — engine actions identical.
                    console.log(`📄 [MITOSIS SIM] Spawned ${nextSym} with baseline $${spawnCost.toFixed(2)}. Hydrated 100%: $${actualCost.toFixed(2)}.`);
                  }
                }
              } catch (err) {
                console.error("❌ [MITOSIS] Failed to execute spawn:", err.message);
              }
            }
          }
        }
      }

      // Return state updates
      this.portfolioHarvestState = portfolioHarvestState;

      // Tier 1: Min Trade Enforcement (Counters)
      if (anyTradesThisCycle) {
        this.cyclesWithoutTrade = 0;
      } else {
        this.cyclesWithoutTrade++;
        // Tier 1 #5: Force Trade if > 250 cycles (Shadow Only for now?)
        // Instruction: "Add two counters per shadow... forcedTradeTimer... When > X cycles... force one minimal-size harvest"
        if (this.mode === 'SHADOW' && this.cyclesWithoutTrade > 250) {
          // Logic to force a trade - Pick a random asset and nudge it?
          // For now, simpler implementation: Just PENALIZE fitness if no trades.
          // The "Force Trade" logic is complex to inject here without access to full market context again.
          // We will handle the penalty in EvolutionManager.
        }
      }

      return {
        anyTradesThisCycle,
        harvestedAmount,
        tradedSymbols: this.cycleTrades || [],
        postMortemEvents: this.postMortemEvents
      };
    }

    // Fallthrough return (Critical for avoiding undefined)
    return {
      anyTradesThisCycle,
      harvestedAmount,
      tradedSymbols: this.cycleTrades || [],
      postMortemEvents: this.postMortemEvents
    };
  }
}
