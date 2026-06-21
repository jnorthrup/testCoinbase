import crypto from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createClient } = require('../../../coinbase-advanced.js');

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
    const out = {};
    await Promise.all(codes.map(async (code) => {
      if (isSyntheticDollarAsset(code)) {
        out[code] = 1;
        this.lastSpreads[code] = { buy: 0, sell: 0 };
        return;
      }
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
    }));
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
