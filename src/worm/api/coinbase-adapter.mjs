import crypto from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createClient } = require('../../../coinbase-advanced.js');
import { createWSClient, WS_CHANNELS } from './coinbase-ws.mjs';
import { BatchingAPI } from './batching-api.mjs';

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    this._batcher = new BatchingAPI(this.client, { windowMs: 250 });
    this.lastSpreads = {};
    this.readOnly = Boolean(options.readOnly);
    this.previewOnly = Boolean(options.previewOnly);
    this._ws = null; // set by startWS()
    this._productsCache = { ts: 0, products: [] };
    this._productsInflight = null;
    this._productsTtlMs = Number(process.env.COINBASE_PRODUCTS_TTL_MS || 60_000);
    this._accountsCache = { ts: 0, body: null };
    this._accountsInflight = null;
    this._accountsTtlMs = Number(process.env.COINBASE_ACCOUNTS_TTL_MS || 5_000);
  }

  async _getProductsCached(ttlMs = this._productsTtlMs) {
    const now = Date.now();
    if (this._productsCache.products.length > 0 && (now - this._productsCache.ts) < ttlMs) {
      return this._productsCache.products;
    }
    if (this._productsInflight) return this._productsInflight;

    this._productsInflight = this._batcher.get('products')
      .then((r) => {
        const products = Array.isArray(r?.products) ? r.products : Array.isArray(r) ? r : [];
        this._productsCache = { ts: Date.now(), products };
        return products;
      })
      .finally(() => { this._productsInflight = null; });
    return this._productsInflight;
  }

  async _listAccountsCached(ttlMs = this._accountsTtlMs) {
    const now = Date.now();
    if (this._accountsCache.body && (now - this._accountsCache.ts) < ttlMs) {
      return this._accountsCache.body;
    }
    if (this._accountsInflight) return this._accountsInflight;

    this._accountsInflight = this._batcher.get('accounts')
      .then((body) => {
        this._accountsCache = { ts: Date.now(), body };
        return body;
      })
      .finally(() => { this._accountsInflight = null; });
    return this._accountsInflight;
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

  async waitForWsPriceMap(symbols, timeoutMs = 6_000, minPrices = null) {
    const syms = Array.isArray(symbols) ? symbols.filter(Boolean) : [];
    if (syms.length === 0) return {};

    await this.startWS(syms);
    const deadline = Date.now() + timeoutMs;
    const required = Math.max(1, Math.min(syms.length, minPrices ?? syms.length));
    let prices = this.getWsPriceMap(syms);
    while (Date.now() < deadline && Object.keys(prices).length < required) {
      await sleep(100);
      prices = this.getWsPriceMap(syms);
    }
    return prices;
  }

  // Candles for a symbol from WS cache (seeded from REST on subscribe).
  getCandles(sym, granularity = 300) {
    if (!this._ws) return [];
    return this._ws.getCandles(sym, granularity);
  }

  async getBalance() {
    const body = await this._listAccountsCached();
    const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
    const usd = accounts.find((a) => a.currency === 'USD');
    return asNumber(usd?.available_balance?.value || usd?.available_balance?.amount || 0);
  }

  async getHoldings() {
    const body = await this._listAccountsCached();
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

    // WS-first quote spine. Do not use per-symbol REST here: MITOSIS calls
    // getQuotes([nextSym]) while searching spawn candidates, and a REST fallback
    // becomes the fastest possible quota-death loop. Public ticker_batch is the
    // bulk market-data transport; if it has not produced a fresh price, the
    // caller must skip the trade instead of burning REST quota.
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

    const wsPrices = await this.waitForWsPriceMap(toFetch);
    for (const code of toFetch) {
      const price = asNumber(wsPrices[code], 0);
      if (price <= 0) continue;
      out[code] = Number(price.toFixed(10));

      const quote = this._ws?.getPrice?.(code);
      const bid = asNumber(quote?.bid, NaN);
      const ask = asNumber(quote?.ask, NaN);
      if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
        this.lastSpreads[code] = {
          buy: Math.max(0, (ask - price) / price),
          sell: Math.max(0, (price - bid) / price),
        };
      }
    }
    return out;
  }

  async getProductBook(productId, limit = 50) {
    const normalizedProductId = normalizeProductId(productId);
    if (typeof this.client.getProductBook === 'function') {
      return this.client.getProductBook(normalizedProductId, limit);
    }

    const resp = await this.client.request({
      method: 'GET',
      requestPath: 'market/product_book',
      query: { product_id: normalizedProductId, limit },
    });
    const pricebook = resp?.body?.pricebook || resp?.body || {};
    const normalizeLevel = (level) => Array.isArray(level)
      ? [String(level[0]), String(level[1])]
      : [String(level?.price), String(level?.size)];

    return {
      product_id: pricebook.product_id || normalizedProductId,
      bids: (pricebook.bids || []).map(normalizeLevel).filter(([price, size]) => price !== 'undefined' && size !== 'undefined'),
      asks: (pricebook.asks || []).map(normalizeLevel).filter(([price, size]) => price !== 'undefined' && size !== 'undefined'),
      time: pricebook.time,
      raw: resp?.body,
    };
  }

  async getGainersLosers(limit = 10) {
    const products = await this._getProductsCached();
    
    const usd = products
      .filter(p => p.status === 'online' && p.id?.endsWith('-USD'))
      .map(p => ({
        symbol: p.id.split('-')[0],
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

  /**
   * Top N symbols by realized return over the last `lookbackMs` (default 5min)
   * computed from the WS price-history ringbuffer. When the WS is cold
   * (insufficient tick depth), falls back to the 24h gainers ranking.
   *
   * Each entry: { symbol, change5m, change24h, price, source }
   *   - change5m  = (now - oldest_in_window.price) / oldest_in_window.price
   *   - change24h = from getGainersLosers (or null if not in 24h list)
   *   - source    = 'ws-tape' | 'gainers-fallback'
   *
   * Sorted by absolute `change5m * 100` desc — both pumps and dumps are alpha-shape.
   */
  async getShortTermMovers(lookbackMs = 5 * 60 * 1000, limit = 10, minTicks = 4) {
    const out = [];
    if (this._ws && this._ws.priceHistory) {
      const cutoff = Date.now() - lookbackMs;
      for (const [sym, history] of Object.entries(this._ws.priceHistory)) {
        if (!Array.isArray(history) || history.length < minTicks) continue;
        // Find oldest entry within the lookback window
        let oldest = null;
        for (const h of history) {
          if (h.ts >= cutoff) { oldest = h; break; }
        }
        // If the buffer reaches back further than `lookbackMs`, use the oldest at-or-after cutoff.
        // If not, treat the entire buffer as the window.
        const oldestInWindow = oldest || history[0];
        const newest = history[history.length - 1];
        if (!oldestInWindow || !newest || oldestInWindow.price <= 0) continue;
        const change5m = (newest.price - oldestInWindow.price) / oldestInWindow.price;
        out.push({ symbol: sym, change5m, price: newest.price, source: 'ws-tape' });
      }
      if (out.length > 0) {
        out.sort((a, b) => Math.abs(b.change5m) - Math.abs(a.change5m));
        // Augment with 24h context where available, but do not block on it
        try {
          const movers = await this.getGainersLosers(20);
          const ctx = new Map(movers.all.map(m => [m.symbol, m.change24h]));
          for (const e of out) e.change24h = ctx.get(e.symbol) ?? null;
        } catch (_) { /* gainers unavailable, leave change24h as null */ }
        return out.slice(0, limit);
      }
    }
    // Fallback: 24h gainers ranked + recent anti-tail
    try {
      const movers = await this.getGainersLosers(limit);
      return [
        ...movers.gainers.map(m => ({ symbol: m.symbol, change5m: null, change24h: m.change24h, price: m.price, source: 'gainers-fallback' })),
        ...movers.losers.reverse().slice(0, Math.max(0, limit - movers.gainers.length))
          .map(m => ({ symbol: m.symbol, change5m: null, change24h: m.change24h, price: m.price, source: 'gainers-fallback' })),
      ];
    } catch (err) {
      return [];
    }
  }

  /**
   * Multi-dimensional outlier fusion: rank symbols across 5-minute WS tape,
   * 24-hour gainers/losers, and 24-hour volume-burst signals. The composite
   * score weights rarity in any direction (a great gainer with extreme volume
   * ranks above a great gainer that's been quiet). BSC/USD-style "stable
   * movers" — high-volume, low-momentum — also surface, because thin-volume
   * outliers on their own don't justify capital.
   *
   * Each entry: { symbol, change5m, change24h, volume24h, price, score, source }
   *   - score in [0, ∞) — higher is more alpha-shape. Score = composite burst.
   *
   * Default weights emphasize 5-min tape (the alpha we have the highest
   * resolution on) and 24h gainers (the proven sanity floor). Volume is a
   * smaller bonus — high volume without movement is interesting, low volume
   * pumps are not.
   *
   * HARVEST_EXCLUDE filtering happens at the spawn-gate, not here — the
   * candidate source should be broadest. Returning every observed outlier lets
   * downstream filters make the policy decision.
   */
  async getOutlierCandidates({
    lookbackMs = 5 * 60 * 1000,
    limit = 30,
    minTicks = 4,
    weights = { w5m: 1.0, w24h: 0.5, wVolume: 0.3 },
    volumePercentileCutoff = 0.95,
  } = {}) {
    const out = new Map();  // symbol -> { components, score }

    // Dimension 1: 5-min WS tape (highest resolution; native to engine)
    const tape = await this.getShortTermMovers(lookbackMs, limit * 2, minTicks).catch(() => []);
    for (const m of (Array.isArray(tape) ? tape : [])) {
      if (!m?.symbol) continue;
      const cur = out.get(m.symbol) || { symbol: m.symbol, change5m: 0, change24h: 0, volume24h: 0, price: 0, sources: [] };
      cur.change5m = Number.isFinite(m.change5m) ? m.change5m : 0;
      cur.sources.push('ws-tape');
      out.set(m.symbol, cur);
    }

    // Dimension 2: 24-hour REST gainers/losers (sanity floor across the full market)
    const gainersLosers = await this.getGainersLosers(50).catch(() => ({ gainers: [], losers: [], all: [] }));
    for (const m of [...(gainersLosers.gainers || []), ...(gainersLosers.losers || [])]) {
      if (!m?.symbol) continue;
      const cur = out.get(m.symbol) || { symbol: m.symbol, change5m: 0, change24h: 0, volume24h: 0, price: 0, sources: [] };
      cur.change24h = Number.isFinite(m.change24h) ? m.change24h : 0;
      cur.volume24h = Number.isFinite(m.volume24h) ? m.volume24h : 0;
      cur.price = Number.isFinite(m.price) ? m.price : m.price || 0;
      cur.sources.push('gainers24h');
      out.set(m.symbol, cur);
    }

    // Dimension 3: 24-hour volume-burst across the full product set.
    // Pulls /products directly so we surface "high-volume, low-momentum" STABLE_X
    // candidates that gainers/losers would miss. Rank-ceiling: only take symbols
    // whose `volume_24h` is in the top percentile across all USD products.
    try {
      const products = await this._getProductsCached();
      const online = products.filter(p => p.status === 'online' && p.id?.endsWith('-USD'));
      const volumes = online
        .map(p => ({ symbol: p.id.split('-')[0], volume24h: parseFloat(p.volume_24h || '0') }))
        .filter(p => p.volume24h > 0)
        .sort((a, b) => b.volume24h - a.volume24h);
      const cutoff = Math.max(1, Math.floor(volumes.length * volumePercentileCutoff));
      for (let i = 0; i < Math.min(cutoff, volumes.length); i++) {
        const m = volumes[i];
        const cur = out.get(m.symbol) || { symbol: m.symbol, change5m: 0, change24h: 0, volume24h: 0, price: 0, sources: [] };
        cur.volume24h = m.volume24h;
        if (!cur.price) cur.price = NaN;
        cur.sources.push('vol-burst');
        out.set(m.symbol, cur);
      }
    } catch (_) { /* volume source unavailable */ }

    // Compose scores: |change| weighted by configurable weights. Volume
    // contributes log-relative to itself so STABLE_X signal is bounded.
    // High-volume entries get a fixed bonus, low-volume pumps get penalized.
    const maxVol = Math.max(1, ...[...out.values()].map(v => v.volume24h || 0));
    for (const v of out.values()) {
      const c5 = Math.abs(v.change5m || 0);
      const c24 = Math.abs(v.change24h || 0);
      const volRatio = (v.volume24h || 0) / maxVol;
      // log compress volume to avoid volume dominating the score outright.
      const volScore = Math.log10(1 + 9 * volRatio);  // 0..1 scale
      v.score =
        (weights.w5m * c5) +
        (weights.w24h * c24) +
        (weights.wVolume * volScore);
    }

    const ranked = [...out.values()].sort((a, b) => b.score - a.score);
    return ranked.slice(0, limit);
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
