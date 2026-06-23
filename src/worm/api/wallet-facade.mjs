// src/worm/api/wallet-facade.mjs
// Wallet facade: Coinbase market-data reads stay live. `--paper` explicitly
// selects simulated order/portfolio state; live Coinbase permission failures are
// observed and re-thrown. Exceptions never define simulation mode.

import crypto from 'crypto';

function normalizeProductId(symbol) {
  if (!symbol) throw new Error('Missing symbol');
  return String(symbol).includes('-') ? String(symbol).toUpperCase() : `${String(symbol).toUpperCase()}-USD`;
}

function bareSymbol(symbol) {
  return normalizeProductId(symbol).replace(/-USD$/, '');
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeHoldingRows(rows) {
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const sym = row?.asset_code || row?.symbol || row?.currency;
    const qty = asNumber(row?.total_quantity ?? row?.quantity ?? row?.rawQuantity, 0);
    if (sym && qty > 0) out[String(sym).toUpperCase()] = { rawQuantity: qty };
  }
  return out;
}

function normalizeHoldingMap(map) {
  const out = {};
  for (const [sym, value] of Object.entries(map || {})) {
    const qty = typeof value === 'object' && value !== null
      ? asNumber(value.rawQuantity ?? value.total_quantity ?? value.quantity, 0)
      : asNumber(value, 0);
    if (qty > 0) out[String(sym).toUpperCase()] = { rawQuantity: qty };
  }
  return out;
}

function errorStatus(err) {
  return err?.status || err?.response?.status || err?.cause?.status || err?.code || 0;
}

function errorMessage(err) {
  const data = err?.response?.data || err?.body || err?.cause?.body || null;
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  return [
    errors[0]?.detail,
    errors[0]?.message,
    data?.message,
    data?.error,
    err?.message,
    String(err || ''),
  ].filter(Boolean).join(' | ');
}

export function isTradePermissionError(err) {
  const status = Number(errorStatus(err));
  const msg = errorMessage(err);
  return status === 401 || status === 403
    || /\b(read[ _-]?only|view[ _-]?only|permission|permissions|scope|scopes|not authorized|unauthori[sz]ed|forbidden|transfer|trade)\b/i.test(msg);
}

export class SimulatedWalletFacade {
  constructor(coinbaseApi, options = {}) {
    if (!coinbaseApi) throw new Error('SimulatedWalletFacade requires a Coinbase API instance');
    this.coinbase = coinbaseApi;
    this.forceSimulated = Boolean(options.forceSimulated);
    this.startCapital = asNumber(options.startCapital, 10000);
    this.buyFeeRate = asNumber(options.buyFeeRate, 0.01);
    this.sellFeeRate = asNumber(options.sellFeeRate, 0);
    this.modeLabel = options.modeLabel || (this.forceSimulated ? 'simulated' : 'coinbase');
    this._simulatedActive = this.forceSimulated;
    this._simulatedReason = this.forceSimulated ? 'facade-selected' : null;
    this._seeded = false;
    this._cash = 0;
    this._holdings = {};
    this._orders = new Map();
    this.tradeRejections = [];
    this.lastSpawnCandidates = [];
  }

  get _ws() { return this.coinbase._ws; }
  set _ws(value) { this.coinbase._ws = value; }

  isSimulatedWallet() {
    return this._simulatedActive;
  }

  simulationReason() {
    return this._simulatedReason;
  }

  seedSimulationFromState(snapshot = {}) {
    const cash = snapshot.cashBalance ?? snapshot.cash ?? null;
    if (cash !== null && cash !== undefined && Number.isFinite(Number(cash))) {
      this._cash = Number(cash);
      this._seeded = true;
    }
    const holdings = normalizeHoldingMap(snapshot.holdings || {});
    if (Object.keys(holdings).length > 0) {
      this._holdings = holdings;
      this._seeded = true;
    }
    if (!this._seeded && snapshot.fallbackCash !== undefined) {
      this._cash = asNumber(snapshot.fallbackCash, this.startCapital);
      this._seeded = true;
    }
    return this.snapshot();
  }

  async activateSimulatedWallet(reason = 'manual-facade-selection', seed = {}) {
    this._simulatedActive = true;
    this._simulatedReason = reason;
    if (Object.keys(seed).length > 0) this.seedSimulationFromState(seed);
    await this._ensureSeeded();
    return this.snapshot();
  }

  snapshot() {
    return {
      cashBalance: this._cash,
      holdings: JSON.parse(JSON.stringify(this._holdings)),
      simulated: this._simulatedActive,
      reason: this._simulatedReason,
    };
  }

  async _ensureSeeded() {
    if (this._seeded) return;
    let liveCash = null;
    let liveHoldings = null;
    try { liveCash = await this.coinbase.getBalance(); } catch (_) { liveCash = null; }
    try { liveHoldings = await this.coinbase.getHoldings(); } catch (_) { liveHoldings = null; }
    const holdings = normalizeHoldingRows(liveHoldings || []);
    // Require BOTH cash AND holdings to consider it "live state" — if cash is $0 but 
    // holdings exist (all crypto, no USD), fall back to seed capital instead of $0 cash.
    const hasLiveCash = Number.isFinite(Number(liveCash)) && Number(liveCash) > 0;
    const hasLiveHoldings = Object.keys(holdings).length > 0;
    const hasLiveState = hasLiveCash && hasLiveHoldings;
    this._cash = hasLiveState ? asNumber(liveCash, 0) : this.startCapital;
    this._holdings = hasLiveState ? holdings : {};
    this._seeded = true;
  }

  // Market-data/read passthroughs. These keep using real Coinbase while wallet
  // state may be simulated.
  async startWS(symbols) { return this.coinbase.startWS(symbols); }
  getWsPriceMap(symbols) { return this.coinbase.getWsPriceMap(symbols); }
  async waitForWsPriceMap(symbols, timeoutMs, minPrices) { return this.coinbase.waitForWsPriceMap(symbols, timeoutMs, minPrices); }
  getCandles(sym, granularity = 300) { return this.coinbase.getCandles(sym, granularity); }
  async getQuotes(assetCodes) { return this.coinbase.getQuotes(assetCodes); }
  async getProductBook(productId, limit = 50) { return this.coinbase.getProductBook(productId, limit); }
  async getGainersLosers(limit = 10) { return this.coinbase.getGainersLosers(limit); }
  async getShortTermMovers(...args) { return this.coinbase.getShortTermMovers(...args); }
  async getOutlierCandidates(...args) {
    const out = await this.coinbase.getOutlierCandidates(...args);
    this.lastSpawnCandidates = this.coinbase.lastSpawnCandidates || this.lastSpawnCandidates;
    return out;
  }

  async getBalance() {
    if (!this._simulatedActive) return this.coinbase.getBalance();
    await this._ensureSeeded();
    return this._cash;
  }

  async getHoldings() {
    if (!this._simulatedActive) return this.coinbase.getHoldings();
    await this._ensureSeeded();
    return Object.entries(this._holdings)
      .filter(([, h]) => asNumber(h.rawQuantity, 0) > 0)
      .map(([asset_code, h]) => ({ asset_code, total_quantity: String(h.rawQuantity) }));
  }

  async placeBuy(symbol, quantityStr) {
    return this._placeOrder('BUY', symbol, quantityStr);
  }

  async placeSell(symbol, quantityStr) {
    return this._placeOrder('SELL', symbol, quantityStr);
  }

  async _placeOrder(side, symbol, quantityStr) {
    const productId = normalizeProductId(symbol);
    if (this._simulatedActive) {
      return this._simulateOrder(side, productId, quantityStr, this._simulatedReason || 'simulated-wallet');
    }

    try {
      const fn = side === 'BUY' ? this.coinbase.placeBuy : this.coinbase.placeSell;
      return await fn.call(this.coinbase, productId, quantityStr);
    } catch (err) {
      if (!isTradePermissionError(err)) throw err;
      const msg = errorMessage(err) || `Coinbase rejected ${side} ${productId}`;
      this.tradeRejections.push({ ts: Date.now(), side, productId, quantity: String(quantityStr), status: errorStatus(err), reason: msg });
      console.warn(`⚠️ [LIVE REJECTED] Coinbase rejected ${side} ${productId}: ${msg}. Simulation mode is NOT activated; use --paper to trade the simulated wallet.`);
      throw err;
    }
  }

  async _priceFor(productId) {
    const sym = bareSymbol(productId);
    const quotes = await this.coinbase.getQuotes([sym]).catch(() => ({}));
    const price = asNumber(quotes?.[sym], 0);
    if (price > 0) return price;
    throw new Error(`No simulated fill price for ${productId}`);
  }

  async _simulateOrder(side, productId, quantityStr, reason) {
    await this._ensureSeeded();
    const sym = bareSymbol(productId);
    const qty = asNumber(quantityStr, 0);
    if (qty <= 0) throw new Error(`Invalid simulated ${side} quantity for ${productId}: ${quantityStr}`);
    const price = await this._priceFor(productId);
    const feeRate = side === 'BUY' ? this.buyFeeRate : this.sellFeeRate;
    const id = `sim_${side.toLowerCase()}_${Date.now()}_${crypto.randomUUID()}`;
    let filledQty = qty;
    let grossFilled = filledQty * price;
    let fee = grossFilled * feeRate;

    if (side === 'BUY') {
      const spend = grossFilled + fee;
      if (this._cash < grossFilled) {
        const rejected = {
          id,
          client_order_id: `sim_reject_${crypto.randomUUID()}`,
          state: 'rejected',
          simulated: true,
          reason: `simulated wallet cash ${this._cash.toFixed(8)} < order gross ${grossFilled.toFixed(8)}`,
          product_id: productId,
        };
        this._orders.set(id, rejected);
        return rejected;
      }
      this._cash = Math.max(0, this._cash - spend);
      const holding = this._holdings[sym] || { rawQuantity: 0 };
      holding.rawQuantity = asNumber(holding.rawQuantity, 0) + qty;
      this._holdings[sym] = holding;
    } else {
      const holding = this._holdings[sym] || { rawQuantity: 0 };
      filledQty = Math.min(asNumber(holding.rawQuantity, 0), qty);
      grossFilled = filledQty * price;
      fee = grossFilled * feeRate;
      holding.rawQuantity = Math.max(0, asNumber(holding.rawQuantity, 0) - filledQty);
      this._holdings[sym] = holding;
      this._cash += Math.max(0, grossFilled - fee);
    }

    const net = side === 'SELL' ? Math.max(0, grossFilled - fee) : grossFilled + fee;
    const order = {
      id,
      order_id: id,
      client_order_id: `sim_${crypto.randomUUID()}`,
      product_id: productId,
      state: 'filled',
      status: 'FILLED',
      average_price: String(price),
      average_filled_price: String(price),
      filled_asset_quantity: String(filledQty),
      filled_size: String(filledQty),
      filled_quantity: String(filledQty),
      filled_value: String(grossFilled),
      total_fees: String(fee),
      total_value_after_fees: String(net),
      simulated: true,
      simulation_reason: reason,
      raw: { simulated: true, side, productId, quantity: String(quantityStr), price, fee, reason },
    };
    this._orders.set(id, order);
    return order;
  }

  async getOrderStatus(orderId) {
    if (this._orders.has(orderId)) return this._orders.get(orderId);
    return this.coinbase.getOrderStatus(orderId);
  }
}

export function createWalletFacade(coinbaseApi, options = {}) {
  return new SimulatedWalletFacade(coinbaseApi, options);
}
