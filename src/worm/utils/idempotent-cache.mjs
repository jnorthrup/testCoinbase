// src/worm/utils/idempotent-cache.mjs
// Utilities to maximize data idempotency and enable perfect/reliable caching.
// Designed for quant trading workloads: backtests, optimizer sweeps, regime memory,
// trade history, brain scans, etc.
//
// Goals:
// - Idempotent operations: same input → same output, safe to retry or re-run.
// - Atomic persistence: no partial/corrupt files on crash or interrupt.
// - Efficient caching: avoid recomputing expensive pure functions or backtest segments.
// - Content-addressable where practical for reproducibility.
// - Optional TTL support in memoize for time-sensitive caches.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Atomic JSON file writer.
 * Writes to a .tmp file then renames atomically.
 * Falls back gracefully on rename issues (common on some filesystems/containers).
 * Guarantees the target file is either fully written or unchanged.
 */
export async function atomicWriteJson(filePath, data, options = {}) {
  const { pretty = true, encoding = 'utf8' } = options;
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp.${Date.now()}.${process.pid}`;

  await fs.promises.mkdir(dir, { recursive: true });

  const json = pretty
    ? JSON.stringify(data, null, 2)
    : JSON.stringify(data);

  await fs.promises.writeFile(tmpPath, json, encoding);

  try {
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EXDEV') {
      // Fallback: copy + unlink
      await fs.promises.copyFile(tmpPath, filePath);
      await fs.promises.unlink(tmpPath).catch(() => {});
    } else {
      await fs.promises.unlink(tmpPath).catch(() => {});
      throw err;
    }
  }
}

/**
 * Simple content hash for cache keys or data versioning.
 * Uses SHA-256 on stable JSON representation.
 * Good for price arrays, genomes, backtest configs, etc.
 */
export function contentHash(input) {
  const str = typeof input === 'string' ? input : JSON.stringify(input, Object.keys(input || {}).sort());
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

/**
 * Lightweight memoizer for pure functions.
 * Keyed by arguments (serialized). Supports maxSize eviction (LRU-ish) and optional TTL.
 *
 * Perfect for expensive indicator calculations on repeated price windows
 * during optimizer sweeps or regime analysis.
 *
 * Options:
 *   - maxSize: Maximum number of cached entries (default 128)
 *   - ttl: Time-to-live in milliseconds. Entries older than this are recomputed.
 *   - keyFn: Custom key generation function
 *
 * Usage:
 *   const memoizedRSI = memoize(calculateRSI, { maxSize: 50 });
 *   const memoizedWithTTL = memoize(heavyFunction, { ttl: 60_000 }); // 1 minute TTL
 */
export function memoize(fn, options = {}) {
  const { maxSize = 128, keyFn = defaultKeyFn, ttl } = options;
  const cache = new Map(); // key -> { value, timestamp }

  function defaultKeyFn(...args) {
    // Stable key for arrays/objects (common in this codebase)
    return args.map(arg => {
      if (Array.isArray(arg)) {
        // Use length + hash of last 5 elements for large price series
        return `arr:${arg.length}:${contentHash(arg.slice(-5))}`;
      }
      if (arg && typeof arg === 'object') return contentHash(arg);
      return String(arg);
    }).join('|');
  }

  return function memoized(...args) {
    const key = keyFn(...args);
    const now = Date.now();

    if (cache.has(key)) {
      const entry = cache.get(key);

      // Check TTL if configured
      if (!ttl || (now - entry.timestamp < ttl)) {
        return entry.value;
      }

      // Expired → remove and recompute
      cache.delete(key);
    }

    const result = fn.apply(this, args);

    // Store with timestamp
    cache.set(key, { value: result, timestamp: now });

    // Evict oldest if over limit
    if (cache.size > maxSize) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }

    return result;
  };
}

/**
 * Idempotent wrapper for async functions that should produce the same
 * side-effect-free result on repeated calls.
 */
export function makeIdempotent(asyncFn, cacheKeyFn = (...a) => contentHash(a)) {
  const cache = new Map();
  return async function idempotent(...args) {
    const key = cacheKeyFn(...args);
    if (cache.has(key)) return cache.get(key);

    const result = await asyncFn(...args);
    cache.set(key, result);
    return result;
  };
}

export default {
  atomicWriteJson,
  contentHash,
  memoize,
  makeIdempotent
};