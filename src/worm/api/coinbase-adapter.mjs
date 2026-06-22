import crypto from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createClient } = require('../../../coinbase-advanced.js');
import { createWSClient, WS_CHANNELS } from './coinbase-ws.mjs';

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeProductId(symbol) {
  if (!symbol) throw new Error('Missing symbol');
  return String(symbol).includes('-') ? String(symbol).toUpperCase() : `${String(symbol).toUpperCase()}-USD`;
}

function isSyntheticDollarAsset(symbol) {
  const code = String(symbol || '').toUpperCase().replace(/-USD$/, '');
  return code === 'USDC' || code === 'USDG' || code === 'USDT';
}

function normalizeOrderState(status) {
  const s = String(status || '').toUpperCase();
  if (!s) return 'unknown';
  if (s === 'FILLED') return 'filled';
  if (s === 'CANCELLED') return 'cancelled';
  if (s === 'FAILED') return 'failed';
  if (s === 'EXPIRED') return 'expired';
  if (s === 'REJECTED') return 'rejected';
  return s.toLowerCase();
}

class CoinbaseWormAPI {
  constructor(options = {}) {
    this.client = createClient();
    this.lastSpreads = {};
    this.readOnly = Boolean(options.readOnly);
    this.previewOnly = Boolean(options.previewOnly);
    this._ws = null; // set by startWS()
  }

  // Start WebSocket, subscribe ticker_batch for symbols, seed candle history.
  // Call once after holdings are known; call again with updated list as holdings change.
  async startWS(symbols) {
    const syms = Array.isArray(symbols) ? symbols : [];
    if (syms.length === 0) return;
    if (!this._ws) {
      try {
        this._ws = await createWSClient();
      } catch (err) {
        console.warn('[WS] Could not connect — falling back to REST:', err.message);
        return;
      }
    }
    // Only subscribe symbols not already in the ticker_batch subscription.
    // Avoids re-triggering _seedCandles for the entire holdings list every cycle.
    const already = this._ws._subscribed.get(WS_CHANNELS.TICKER_BATCH) || new Set();
    const newSyms  = syms.filter(s => !already.has(`${s.toUpperCase()}-USD`) && !already.has(s.toUpperCase()));
    if (newSyms.length > 0) await this._ws.subscribe(WS_CHANNELS.TICKER_BATCH, newSyms);
  }

  // Returns a price map from WS cache for symbols that are fresh (< 60s).
  // Caller should fill missing keys with a single bulk REST call.
  getWsPriceMap(symbols) {
    if (!this._ws) return {};
    return this._ws.getPriceMap(symbols);
  }

  // Candles for a symbol from WS cache (seeded from REST on subscribe).
  getCandles(sym, granularity = 300) {
    if (!this._ws) return [];
    return this._ws.getCandles(sym, granularity);
  }

  async getBalance() {
    const body = await this.client.listAccounts();
    const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
    const usd = accounts.find((a) => a.currency === 'USD');
    return asNumber(usd?.available_balance?.value || usd?.available_balance?.amount || 0);
  }

  async getHoldings() {
    const body = await this.client.listAccounts();
    const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
    return accounts
      .map((account) => ({
        asset_code: account.currency,
        total_quantity: String(asNumber(account?.available_balance?.value) + asNumber(account?.hold?.value)),
      }))
      .filter((row) => row.asset_code && row.asset_code !== 'USD' && asNumber(row.total_quantity) > 0);
  }

  async getQuotes(assetCodes) {
    const codes = Array.isArray(assetCodes) ? assetCodes : [];
    if (codes.length === 0) return {};

    // Batch: one /products call, index by symbol — avoids N parallel per-product 429s.
    // Falls back to per-symbol only for small single-asset lookups (e.g. spawn price check).
    const out = {};
    const toFetch = [];
    for (const code of codes) {
      if (isSyntheticDollarAsset(code)) {
        out[code] = 1;
        this.lastSpreads[code] = { buy: 0, sell: 0 };
      } else {
        toFetch.push(code);
      }
    }

    if (toFetch.length === 0) return out;

    if (toFetch.length === 1) {
      // Single asset: use per-product endpoint (no overhead of full catalogue)
      const code = toFetch[0];
      try {
        const product = await this.client.getProduct(normalizeProductId(code));
        const price = asNumber(product?.price || product?.mid_market_price || product?.best_bid_price || product?.best_ask_price);
        if (price > 0) out[code] = Number(price.toFixed(10));
        const bid = asNumber(product?.best_bid_price, NaN);
        const ask = asNumber(product?.best_ask_price, NaN);
        if (price > 0 && Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
          this.lastSpreads[code] = {
            buy: Math.max(0, (ask - price) / price),
            sell: Math.max(0, (price - bid) / price),
          };
        }
      } catch (_) { /* price stays missing */ }
      return out;
    }

    // Multiple assets: one bulk /products call
    try {
      const resp = await this.client.request({ method: 'GET', requestPath: 'products' });
      const products = resp?.body?.products || [];
      const wantSet = new Set(toFetch.map(c => normalizeProductId(c)));
      for (const p of products) {
        if (!wantSet.has(p.product_id)) continue;
        const code = p.product_id.replace(/-USD$/, '');
        const price = asNumber(p.price || p.mid_market_price || p.best_bid_price || p.best_ask_price);
        if (price > 0) out[code] = Number(price.toFixed(10));
        const bid = asNumber(p.best_bid_price, NaN);
        const ask = asNumber(p.best_ask_price, NaN);
        if (price > 0 && Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
          this.lastSpreads[code] = {
            buy: Math.max(0, (ask - price) / price),
            sell: Math.max(0, (price - bid) / price),
          };
        }
      }
    } catch (err) {
      console.error('getQuotes bulk fetch failed:', err.message);
    }
    return out;
  }

  async getGainersLosers(limit = 10) {
    const resp = await this.client.request({ method: 'GET', requestPath: 'products' });
    const products = resp?.body?.products || [];
    
    const usd = products
      .filter(p => p.status === 'online' && p.product_id?.endsWith('-USD'))
      .map(p => ({
        symbol: p.product_id.split('-')[0],
        change24h: parseFloat(p.price_percentage_change_24h || '0'),
        volume24h: parseFloat(p.volume_24h || '0'),
        price: parseFloat(p.price || '0'),
      }))
      .filter(p => p.change24h !== 0 && p.volume24h > 0);
    
    usd.sort((a, b) => b.change24h - a.change24h);
    
    return {
      gainers: usd.slice(0, limit),
      losers: usd.slice(-limit).reverse(),
      all: usd,
    };
  }

  async getOrderStatus(orderId) {
    const body = await this.client.getOrder(orderId);
    const order = body?.order || body;
    return {
      id: order?.order_id || orderId,
      client_order_id: order?.client_order_id || null,
      state: normalizeOrderState(order?.status),
      average_price: order?.average_filled_price || order?.average_price || null,
      filled_asset_quantity: order?.filled_size || order?.filled_quantity || null,
      filled_value: order?.filled_value || null,
      total_fees: order?.total_fees || null,
      total_value_after_fees: order?.total_value_after_fees || null,
      raw: body,
    };
  }

  async placeBuy(symbol, quantityStr) {
    return this.#placeMarketOrder('BUY', symbol, quantityStr);
  }

  async placeSell(symbol, quantityStr) {
    return this.#placeMarketOrder('SELL', symbol, quantityStr);
  }

  async #placeMarketOrder(side, symbol, quantityStr) {
    const productId = normalizeProductId(symbol);
    const baseSize = String(quantityStr);
    const previewRequest = {
      productId,
      side,
      orderConfiguration: {
        marketMarketIoc: {
          baseSize,
        },
      },
    };
    const preview = await this.client.previewOrder(previewRequest);
    const previewId = preview?.preview_id || preview?.previewId;
    if (!previewId) {
      throw new Error(`Preview failed for ${side} ${productId}`);
    }
    if (this.previewOnly) {
      return {
        id: previewId,
        client_order_id: null,
        state: 'preview',
        average_price: preview?.est_average_filled_price || preview?.price || null,
        filled_asset_quantity: preview?.base_size || baseSize,
        filled_value: null,
        total_fees: null,
        total_value_after_fees: null,
        preview_only: true,
        preview,
        raw: preview,
      };
    }
    if (this.readOnly) {
      throw new Error(`[READ_ONLY] Refusing ${side} order for ${productId}`);
    }
    const orderRequest = {
      ...previewRequest,
      clientOrderId: crypto.randomUUID(),
      previewId,
    };
    const body = await this.client.createOrder(orderRequest);
    const orderId = body?.success_response?.order_id || body?.successResponse?.orderId || body?.order_id || body?.orderId;
    return {
      id: orderId,
      client_order_id: orderRequest.clientOrderId,
      average_price: null,
      filled_value: null,
      total_fees: null,
      total_value_after_fees: null,
      raw: body,
    };
  }
}

export { CoinbaseWormAPI };
