// Coinbase Advanced Trade WebSocket Client
// Real-time market data via WebSocket to avoid REST rate limits

import { createClient } from './coinbase-advanced.js';

export const WS_CHANNELS = {
  TICKER: 'ticker',
  TICKER_BATCH: 'ticker_batch',
  CANDLES: 'candles',
  LEVEL2: 'level2',
  MARKET_TRADES: 'market_trades',
  STATUS: 'status',
};

export const CANDLE_GRANULARITIES = {
  MINUTE_1: 60,
  MINUTE_5: 300,
  MINUTE_15: 900,
  HOUR_1: 3600,
  HOUR_6: 21600,
  DAY_1: 86400,
};

class CoinbaseWS {
  constructor(options = {}) {
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.passphrase = options.passphrase;
    this.wsUrl = options.wsUrl || 'wss://advanced-trade-ws.coinbase.com';
    
    this.ws = null;
    this.subscriptions = new Map(); // channel -> Set(product_ids)
    this.messageHandlers = new Map(); // channel -> handler fn
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.reconnectDelay = options.reconnectDelay || 1000;
    this.isConnected = false;
    this.authenticated = false;
    this.pendingSubscriptions = [];
    this.heartbeatInterval = null;
    
    // Price cache for real-time access
    this.priceCache = new Map(); // product_id -> { price, bid, ask, volume_24h, timestamp }
    this.candleCache = new Map(); // product_id -> { granularity -> candles[] }
  }

  // Generate JWT for WebSocket authentication
  _buildAuthMessage() {
    const timestamp = Math.floor(Date.now() / 1000);
    const channel = 'level2'; // Use any channel for auth
    const products = Array.from(this.subscriptions.keys()).flatMap(c => Array.from(this.subscriptions.get(c) || []));
    const productIds = [...new Set(products)].filter(Boolean);
    
    // We'll use the REST client's JWT builder pattern
    const requestPath = '/users/self/verify'; // dummy path for signing
    const method = 'GET';
    
    // This would need proper JWT signing - for now return basic auth
    return {
      type: 'subscribe',
      channel: 'level2',
      product_ids: productIds.length > 0 ? productIds : ['BTC-USD'],
      api_key: this.apiKey,
      timestamp: timestamp.toString(),
      // signature would go here
    };
  }

  connect() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.wsUrl);
        
        this.ws.onopen = () => {
          console.log('[WS] Connected to Coinbase Advanced Trade WebSocket');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this._sendPendingSubscriptions();
          this._startHeartbeat();
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            this._handleMessage(message);
          } catch (err) {
            console.error('[WS] Parse error:', err.message);
          }
        };

        this.ws.onerror = (err) => {
          console.error('[WS] Error:', err.message);
        };

        this.ws.onclose = (event) => {
          console.log('[WS] Disconnected:', event.code, event.reason);
          this.isConnected = false;
          this.authenticated = false;
          this._stopHeartbeat();
          this._scheduleReconnect();
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  _handleMessage(message) {
    if (message.type === 'subscriptions') {
      console.log('[WS] Subscription confirmed:', message.channels);
      this.authenticated = true;
      return;
    }

    if (message.channel && this.messageHandlers.has(message.channel)) {
      const handler = this.messageHandlers.get(message.channel);
      if (message.events) {
        message.events.forEach(event => handler(event));
      } else {
        handler(message);
      }
    }

    // Default ticker handler - update price cache
    if (message.channel === 'ticker' || message.channel === 'ticker_batch') {
      const events = message.events || [message];
      events.forEach(event => {
        const productId = event.product_id || event.product_ids?.[0];
        if (productId) {
          this.priceCache.set(productId, {
            price: parseFloat(event.price || event.close),
            bid: parseFloat(event.best_bid || event.bid),
            ask: parseFloat(event.best_ask || event.ask),
            volume_24h: parseFloat(event.volume_24h || event.volume),
            timestamp: Date.now(),
          });
        }
      });
    }

    // Candle handler
    if (message.channel === 'candles') {
      const events = message.events || [message];
      events.forEach(event => {
        const productId = event.product_id;
        const granularity = event.granularity;
        if (productId && granularity) {
          const key = `${productId}:${granularity}`;
          if (!this.candleCache.has(key)) this.candleCache.set(key, []);
          const candles = this.candleCache.get(key);
          candles.push({
            start: event.start,
            low: parseFloat(event.low),
            high: parseFloat(event.high),
            open: parseFloat(event.open),
            close: parseFloat(event.close),
            volume: parseFloat(event.volume),
          });
          // Keep last 500 candles
          if (candles.length > 500) candles.shift();
        }
      });
    }
  }

  _sendPendingSubscriptions() {
    this.pendingSubscriptions.forEach(sub => this._sendSubscription(sub));
    this.pendingSubscriptions = [];
  }

  _sendSubscription({ channel, product_ids }) {
    if (!this.isConnected) {
      this.pendingSubscriptions.push({ channel, product_ids });
      return;
    }
    
    const msg = {
      type: 'subscribe',
      channel,
      product_ids,
    };
    
    this.ws.send(JSON.stringify(msg));
    
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());
    }
    product_ids.forEach(id => this.subscriptions.get(channel).add(id));
  }

  subscribe(channel, productIds) {
    const ids = Array.isArray(productIds) ? productIds : [productIds];
    this._sendSubscription({ channel, product_ids: ids });
    
    // Register default handler for price cache
    if (!this.messageHandlers.has(channel)) {
      this.messageHandlers.set(channel, () => {});
    }
  }

  unsubscribe(channel, productIds) {
    const ids = Array.isArray(productIds) ? productIds : [productIds];
    const msg = {
      type: 'unsubscribe',
      channel,
      product_ids: ids,
    };
    
    if (this.isConnected) {
      this.ws.send(JSON.stringify(msg));
    }
    
    if (this.subscriptions.has(channel)) {
      ids.forEach(id => this.subscriptions.get(channel).delete(id));
    }
  }

  // Subscribe to ticker for real-time prices
  subscribeTicker(productIds) {
    this.subscribe('ticker', productIds);
  }

  // Subscribe to batch ticker (more efficient for many products)
  subscribeTickerBatch(productIds) {
    this.subscribe('ticker_batch', productIds);
  }

  // Subscribe to candles
  subscribeCandles(productIds, granularity = 60) {
    const ids = Array.isArray(productIds) ? productIds : [productIds];
    ids.forEach(id => {
      this.subscribe('candles', [{ product_id: id, granularity }]);
    });
  }

  // Get real-time price from cache
  getPrice(productId) {
    return this.priceCache.get(productId);
  }

  // Get cached candles
  getCandles(productId, granularity) {
    return this.candleCache.get(`${productId}:${granularity}`) || [];
  }

  // Get all current prices
  getAllPrices() {
    const result = {};
    this.priceCache.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  _startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'heartbeat' }));
      }
    }, 30000);
  }

  _stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WS] Max reconnect attempts reached');
      return;
    }
    
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    
    setTimeout(() => this.connect(), delay);
  }

  disconnect() {
    this._stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.authenticated = false;
  }
}

// Factory function with credentials
export async function createWSClient(credentials = {}) {
  const restClient = createClient();
  // We could get credentials from restClient but for now use env
  const ws = new CoinbaseWS({
    apiKey: process.env.COINBASE_API_KEY_NAME,
    apiSecret: process.env.COINBASE_API_KEY_SECRET,
    passphrase: process.env.COINBASE_API_PASSPHRASE,
  });
  
  await ws.connect();
  return ws;
}

export default CoinbaseWS;