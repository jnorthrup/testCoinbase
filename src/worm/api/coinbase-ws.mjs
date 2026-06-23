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
    this._manualDisconnect = false;
    this._sendQueue = [];
    this._drainingSendQueue = false;
    this._nextControlSendAt = 0;
    this.CONTROL_MIN_INTERVAL_MS = 125; // Coinbase WS control limit: 8 messages/sec

    this._pendingSubs = []; // { channel, product_ids } queued before connect
    this._subscribed  = new Map(); // channel -> Set(product_id)

    // --- Public caches ---
    // priceCache: sym (no -USD) -> { price, bid, ask, ts }
    this.priceCache = {};
    // candleCache: `${productId}:${granularity}` -> candle[]
    // Each candle: { start, open, high, low, close, volume }
    this.candleCache = new Map();
    // priceHistory: sym -> [{ts, price, bid, ask, volume?}, ...] bounded ringbuffer.
    // Used by getShortTermMovers() to compute realized return over lookbackMs.
    // Bounded to ~5min of ticks at ~1Hz; entries older than PRICE_HISTORY_TTL are trimmed.
    this.priceHistory = {};
    this.PRICE_HISTORY_TTL = 10 * 60 * 1000;       // 10 minutes
    this.PRICE_HISTORY_MAX_ENTRIES = 1024;         // per-symbol cap
  }

  // ── Connection ─────────────────────────────────────────────────────────────

  connect() {
    return new Promise((resolve, reject) => {
      this._manualDisconnect = false;
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
        if (this._manualDisconnect) return;
        this._scheduleReconnect();
      });
    });
  }

  disconnect() {
    this._manualDisconnect = true;
    this._stopHeartbeat();
    if (this.ws) { this.ws.close(); this.ws = null; }
    this.isConnected = false;
  }

  // ── Subscriptions ───────────────────────────────────────────────────────────

  // Subscribe to ticker_batch for real-time prices (main use case).
  // Note: ticker_batch is a PUBLIC channel — no JWT required.
  // We skip candle seeding since it requires authenticated endpoints.
  async subscribe(channel, symbols) {
    const ids = (Array.isArray(symbols) ? symbols : [symbols]).map(normalizeProductId);
    if (ids.length === 0) return;

    // Skip candle seeding — candles endpoint requires marketdata scope (authenticated).
    // WS ticker_batch provides real-time prices without any auth.

    const msg = { type: 'subscribe', channel, product_ids: ids };
    // Note: we intentionally DON'T add JWT here — ticker_batch is public.
    // Only add JWT for private channels if needed.

    if (this.isConnected) {
      await this._sendControl(msg);
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
      await this._sendControl({ type: 'unsubscribe', channel, product_ids: toDrop });
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
            // Append to per-symbol price-history ringbuffer for short-term momentum
            if (!this.priceHistory[sym]) this.priceHistory[sym] = [];
            const arr = this.priceHistory[sym];
            const now = Date.now();
            arr.push({ ts: now, price, bid, ask });
            // bound: drop entries older than TTL OR keep size under cap
            const cutoff = now - this.PRICE_HISTORY_TTL;
            while (arr.length > 0 && (arr[0].ts < cutoff || arr.length > this.PRICE_HISTORY_MAX_ENTRIES)) arr.shift();
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
      this._sendControl(msg).catch(() => {});
    }
    this._pendingSubs = [];
  }

  _sendControl(msg) {
    return new Promise((resolve, reject) => {
      this._sendQueue.push({ msg, resolve, reject });
      this._drainSendQueue().catch(() => {});
    });
  }

  async _drainSendQueue() {
    if (this._drainingSendQueue) return;
    this._drainingSendQueue = true;
    try {
      while (this._sendQueue.length > 0) {
        const item = this._sendQueue.shift();
        const waitMs = Math.max(0, this._nextControlSendAt - Date.now());
        if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          item.reject(new Error('WebSocket is not open'));
          continue;
        }
        this.ws.send(JSON.stringify(item.msg));
        this._nextControlSendAt = Date.now() + this.CONTROL_MIN_INTERVAL_MS;
        item.resolve();
      }
    } finally {
      this._drainingSendQueue = false;
    }
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
        this._sendControl(msg).catch(() => {});
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
