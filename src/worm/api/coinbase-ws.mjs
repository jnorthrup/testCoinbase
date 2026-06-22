// Coinbase Advanced Trade WebSocket Client
// Real-time market data via WS — eliminates per-symbol REST calls during cycles.
// Part 1: ticker_batch -> priceCache (replaces getQuotes bulk REST)
// Part 2: candleCache seeded from REST /candles on subscribe, extended by WS updates

import crypto from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const { sign } = require('jsonwebtoken');
const { createClient } = require('../../../coinbase-advanced.js');

const WS_URL = 'wss://advanced-trade-ws.coinbase.com';
const CANDLE_SEED_GRANULARITY = 300; // 5-minute candles; 300 candles = 25h of history
const CANDLE_SEED_COUNT = 300;
const STALE_PRICE_MS = 60_000; // fall back to REST if WS price older than 60s

export const WS_CHANNELS = {
  TICKER: 'ticker',
  TICKER_BATCH: 'ticker_batch',
  CANDLES: 'candles',
};

export const CANDLE_GRANULARITIES = {
  MINUTE_1: 60,
  MINUTE_5: 300,
  MINUTE_15: 900,
  HOUR_1: 3600,
  HOUR_6: 21600,
  DAY_1: 86400,
};

function buildJwt(keyName, keySecret) {
  const now = Math.floor(Date.now() / 1000);
  const uri = `GET ${WS_URL.replace('wss://', 'wss://')}`; // WS auth uses wss URI
  return sign(
    { iss: 'coinbase-cloud', sub: keyName, nbf: now, exp: now + 120, uri },
    keySecret,
    { algorithm: 'ES256', header: { kid: keyName, nonce: crypto.randomBytes(16).toString('hex') } },
  );
}

function normalizeProductId(sym) {
  return String(sym).includes('-') ? String(sym).toUpperCase() : `${String(sym).toUpperCase()}-USD`;
}

class CoinbaseWS {
  constructor(options = {}) {
    this.keyName   = options.keyName   || process.env.COINBASE_API_KEY_NAME   || '';
    this.keySecret = options.keySecret || process.env.COINBASE_API_KEY_SECRET || '';
    this.restClient = createClient(); // for candle seeding

    this.ws = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.baseReconnectDelay = options.reconnectDelay || 2000;
    this.heartbeatInterval = null;

    this._pendingSubs = []; // { channel, product_ids } queued before connect
    this._subscribed  = new Map(); // channel -> Set(product_id)

    // --- Public caches ---
    // priceCache: sym (no -USD) -> { price, bid, ask, ts }
    this.priceCache = {};
    // candleCache: `${productId}:${granularity}` -> candle[]
    // Each candle: { start, open, high, low, close, volume }
    this.candleCache = new Map();
  }

  // ── Connection ─────────────────────────────────────────────────────────────

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_URL);

      this.ws.on('open', () => {
        console.log('[WS] Connected to Coinbase Advanced Trade');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this._flushPending();
        this._startHeartbeat();
        resolve();
      });

      this.ws.on('message', (raw) => {
        try { this._handleMessage(JSON.parse(raw)); }
        catch (e) { /* ignore parse errors */ }
      });

      this.ws.on('error', (err) => {
        console.error('[WS] Error:', err.message);
        if (!this.isConnected) reject(err);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[WS] Disconnected (${code}): ${reason}`);
        this.isConnected = false;
        this._stopHeartbeat();
        this._scheduleReconnect();
      });
    });
  }

  disconnect() {
    this._stopHeartbeat();
    if (this.ws) { this.ws.close(); this.ws = null; }
    this.isConnected = false;
  }

  // ── Subscriptions ───────────────────────────────────────────────────────────

  // Subscribe to ticker_batch for real-time prices (main use case).
  // Also seeds candleCache from REST for each new symbol.
  async subscribe(channel, symbols) {
    const ids = (Array.isArray(symbols) ? symbols : [symbols]).map(normalizeProductId);
    if (ids.length === 0) return;

    // Seed candle cache from REST before subscribing (so WS updates extend history)
    if (channel === WS_CHANNELS.TICKER_BATCH || channel === WS_CHANNELS.CANDLES) {
      await this._seedCandles(ids);
    }

    const msg = { type: 'subscribe', channel, product_ids: ids };
    if (this.keyName && this.keySecret) {
      msg.jwt = buildJwt(this.keyName, this.keySecret);
    }

    if (this.isConnected) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this._pendingSubs.push(msg);
    }

    if (!this._subscribed.has(channel)) this._subscribed.set(channel, new Set());
    ids.forEach(id => this._subscribed.get(channel).add(id));
  }

  // Update subscriptions when holdings change mid-run
  async updateSubscriptions(channel, symbols) {
    const newIds = new Set((Array.isArray(symbols) ? symbols : [symbols]).map(normalizeProductId));
    const current = this._subscribed.get(channel) || new Set();

    const toAdd = [...newIds].filter(id => !current.has(id));
    const toDrop = [...current].filter(id => !newIds.has(id));

    if (toDrop.length > 0 && this.isConnected) {
      this.ws.send(JSON.stringify({ type: 'unsubscribe', channel, product_ids: toDrop }));
      toDrop.forEach(id => current.delete(id));
    }
    if (toAdd.length > 0) {
      await this.subscribe(channel, toAdd.map(id => id.replace(/-USD$/, '')));
    }
  }

  // ── Price access ────────────────────────────────────────────────────────────

  // Returns { price, bid, ask, ts } or null if stale / missing
  getPrice(sym) {
    const entry = this.priceCache[sym] || this.priceCache[normalizeProductId(sym)];
    if (!entry) return null;
    if (Date.now() - entry.ts > STALE_PRICE_MS) return null; // stale
    return entry;
  }

  // Build a price map for a list of symbols — used as drop-in replacement for getQuotes()
  getPriceMap(symbols) {
    const out = {};
    for (const sym of symbols) {
      const entry = this.getPrice(sym);
      if (entry && entry.price > 0) out[sym] = entry.price;
    }
    return out;
  }

  // ── Candle access ───────────────────────────────────────────────────────────

  getCandles(sym, granularity = CANDLE_SEED_GRANULARITY) {
    return this.candleCache.get(`${normalizeProductId(sym)}:${granularity}`) || [];
  }

  // ── Internal message handler ─────────────────────────────────────────────────

  _handleMessage(msg) {
    if (msg.type === 'subscriptions') {
      console.log('[WS] Subscribed:', (msg.channels || []).map(c => `${c.name}(${(c.product_ids||[]).length})`).join(', '));
      return;
    }
    if (msg.type === 'error') {
      console.error('[WS] Server error:', msg.message, msg.preview_message || '');
      return;
    }

    const events = msg.events || [];

    if (msg.channel === 'ticker' || msg.channel === 'ticker_batch') {
      for (const ev of events) {
        const tickers = ev.tickers || (ev.product_id ? [ev] : []);
        for (const t of tickers) {
          const productId = t.product_id;
          if (!productId) continue;
          const sym = productId.replace(/-USD$/, '');
          const price = parseFloat(t.price || t.close || 0);
          const bid   = parseFloat(t.best_bid  || t.bid  || 0);
          const ask   = parseFloat(t.best_ask  || t.ask  || 0);
          if (price > 0) {
            this.priceCache[sym] = { price, bid, ask, ts: Date.now() };
          }
        }
      }
    }

    if (msg.channel === 'candles') {
      for (const ev of events) {
        const candles = ev.candles || (ev.start ? [ev] : []);
        for (const c of candles) {
          const productId = c.product_id || ev.product_id;
          const gran      = c.granularity || ev.granularity || CANDLE_SEED_GRANULARITY;
          if (!productId) continue;
          const key = `${productId}:${gran}`;
          if (!this.candleCache.has(key)) this.candleCache.set(key, []);
          const arr = this.candleCache.get(key);
          // Merge by start time — avoid duplicates
          const start = Number(c.start);
          const existing = arr.findIndex(x => x.start === start);
          const candle = {
            start,
            open:   parseFloat(c.open),
            high:   parseFloat(c.high),
            low:    parseFloat(c.low),
            close:  parseFloat(c.close),
            volume: parseFloat(c.volume),
          };
          if (existing >= 0) arr[existing] = candle;
          else arr.push(candle);
          // Keep sorted, cap at 1000
          if (arr.length > 1000) arr.shift();
        }
      }
    }
  }

  // ── Candle seeding ──────────────────────────────────────────────────────────

  async _seedCandles(productIds) {
    const now   = Math.floor(Date.now() / 1000);
    const start = now - CANDLE_SEED_GRANULARITY * CANDLE_SEED_COUNT;
    const gran  = CANDLE_SEED_GRANULARITY;

    await Promise.allSettled(productIds.map(async (productId) => {
      const key = `${productId}:${gran}`;
      if (this.candleCache.has(key)) return; // already seeded or previously attempted

      // Mark attempted BEFORE the request — prevents retry storm on Unauthorized
      this.candleCache.set(key, []);

      try {
        const body = await this.restClient.getCandles(productId, gran, start, now);
        const raw  = body?.candles || [];
        if (raw.length === 0) return;

        const candles = raw.map(c => ({
          start:  Number(c.start),
          open:   parseFloat(c.open),
          high:   parseFloat(c.high),
          low:    parseFloat(c.low),
          close:  parseFloat(c.close),
          volume: parseFloat(c.volume),
        })).sort((a, b) => a.start - b.start);

        this.candleCache.set(key, candles);
        console.log(`[WS] Seeded ${candles.length} candles for ${productId} (${gran}s)`);
      } catch (err) {
        // Non-fatal — sentinel [] already set above, won't retry
        console.warn(`[WS] Candle seed failed for ${productId}: ${err.message}`);
      }
    }));
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  _flushPending() {
    for (const msg of this._pendingSubs) {
      if (this.keyName && this.keySecret) msg.jwt = buildJwt(this.keyName, this.keySecret);
      this.ws.send(JSON.stringify(msg));
    }
    this._pendingSubs = [];
  }

  _startHeartbeat() {
    // Coinbase Advanced Trade WS stays alive via subscription activity.
    // Send a lightweight ping by re-subscribing heartbeats channel.
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Just send a no-op JSON ping that keeps the TCP connection alive
        try { this.ws.ping(); } catch (_) { }
      }
    }, 25_000);
  }

  _stopHeartbeat() {
    if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
  }

  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WS] Max reconnect attempts reached — giving up');
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(this.baseReconnectDelay * 2 ** (this.reconnectAttempts - 1), 30_000);
    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    setTimeout(() => this.connect().then(() => {
      // Re-subscribe all channels after reconnect
      for (const [channel, ids] of this._subscribed.entries()) {
        if (ids.size === 0) continue;
        const msg = { type: 'subscribe', channel, product_ids: [...ids] };
        if (this.keyName && this.keySecret) msg.jwt = buildJwt(this.keyName, this.keySecret);
        this.ws.send(JSON.stringify(msg));
      }
    }).catch(() => {}), delay);
  }
}

export async function createWSClient(options = {}) {
  const ws = new CoinbaseWS(options);
  await ws.connect();
  return ws;
}

export default CoinbaseWS;
