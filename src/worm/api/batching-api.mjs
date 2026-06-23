// src/worm/api/batching-api.mjs
// 250 ms coalescing batcher for Coinbase REST API calls.
//
// Design:
//   - In-flight map keyed by `${method}:${path}?${sortedQuery}` — collapses
//     concurrent duplicates so simultaneous getBalance + getHoldings only
//     open one HTTPS connection instead of two.
//   - Pending queue per key collects callers over a 250 ms T-window; when
//     the timer fires all waiting callers share one network round-trip.
//   - Write methods (POST/PUT/DELETE) pass through immediately — we never
//     want to delay or batch trades.
//   - The raw HTTP client (coinbase-advanced.js) already handles 429
//     exponential-backoff retries; this layer sits above it and does not
//     interfere.
//
// Usage:
//   import { BatchingAPI } from './batching-api.mjs';
//   const batcher = new BatchingAPI(client, { windowMs: 250 });
//   // All calls with the same method+path+q are automatically batched:
//   const [balance, holdings] = await Promise.all([
//     batcher.get('accounts'),
//     batcher.get('accounts'),
//   ]);

export class BatchingAPI {
  /**
   * @param {object} client  — coinbase-advanced.js createClient() instance
   * @param {{ windowMs?: number }} options
   */
  constructor(client, { windowMs = 250 } = {}) {
    if (!client) throw new Error('BatchingAPI requires a client');
    this._client = client;
    this._windowMs = windowMs;

    // in-flight: key -> Promise (shared by all callers that arrive during a batch window)
    this._inflight = new Map();

    // pending: key -> { timer, resolvers, rejecter, args }
    this._pending = new Map();

    // metrics for observability
    this._stats = { batches: 0, deduped: 0, passthrough: 0 };
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * GET with automatic 250 ms batching.  Concurrent calls with the same
   * path+query within the window share one network round-trip.
   *
   * @param {string} requestPath  e.g. 'accounts'
   * @param {object} [query]
   * @returns {Promise<unknown>} resolved with the parsed response body
   */
  get(requestPath, query) {
    return this._batch('GET', requestPath, query, undefined);
  }

  /**
   * POST — NOT batched, passes straight through.  Trade operations must not
   * be delayed or retried as a batch.
   *
   * @param {string} requestPath
   * @param {object} [body]
   * @returns {Promise<unknown>}
   */
  post(requestPath, body) {
    return this._passthrough('POST', requestPath, undefined, body);
  }

  /**
   * DELETE — NOT batched.
   */
  delete(requestPath, query) {
    return this._passthrough('DELETE', requestPath, query, undefined);
  }

  // ── Passthrough (writes) ────────────────────────────────────────────────────

  _passthrough(method, requestPath, query, body) {
    this._stats.passthrough++;
    return this._client.request({ method, requestPath, query, body })
      .then(r => r.body)
      .catch(err => { throw err; });
  }

  // ── Batching (reads) ────────────────────────────────────────────────────────

  _batch(method, requestPath, query, body) {
    const key = this._key(method, requestPath, query);

    // Case 1: a request for this key is already in-flight (N concurrent callers)
    if (this._inflight.has(key)) {
      this._stats.deduped++;
      return this._inflight.get(key);
    }

    // Case 2: a window is already running — register this caller
    if (this._pending.has(key)) {
      const pending = this._pending.get(key);
      this._stats.deduped++;
      return new Promise((resolve, reject) => {
        pending.resolvers.push(resolve);
        pending.rejecter && pending.rejecter.push(reject);
      });
    }

    // Case 3: open a new 250 ms window
    let timer;
    const resolvers = [];
    const rejecter = [];

    const promise = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        this._pending.delete(key);
        this._inflight.delete(key);
        this._dispatch(key, method, requestPath, query, body)
          .then(results => {
            this._stats.batches++;
            for (const res of resolvers) res(results);
          })
          .catch(err => {
            for (const rej of rejecter) rej(err);
          });
      }, this._windowMs);

      resolvers.push(resolve);
      if (reject) rejecter.push(reject);
    });

    this._inflight.set(key, promise);
    this._pending.set(key, { timer, resolvers, rejecter, args: { method, requestPath, query, body } });

    return promise;
  }

  async _dispatch(key, method, requestPath, query, body) {
    // Wait for the first concurrent caller to populate _inflight before
    // we actually fire — all callers in this window share the same promise.
    // The setTimeout above gives subsequent callers ~0 ms to register.
    return this._client.request({ method, requestPath, query, body })
      .then(r => r.body);
  }

  _key(method, requestPath, query) {
    // Canonicalise: stable key regardless of key insertion order
    let q = '';
    if (query && Object.keys(query).length > 0) {
      const sorted = Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`)
        .join('&');
      q = sorted ? `?${sorted}` : '';
    }
    return `${method}:${requestPath}${q}`;
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────────

  /** Returns { batches, deduped, passthrough } counters since construction. */
  stats() {
    return { ...this._stats };
  }
}
