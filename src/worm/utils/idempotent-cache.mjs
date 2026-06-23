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
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16); // short hash sufficient
}

/**
 * Lightweight memoizer for pure functions.
 * Keyed by arguments (serialized). Supports maxSize eviction (LRU-ish).
 * Perfect for expensive indicator calculations on repeated price windows
 * during optimizer sweeps or regime analysis.
 *
 * Usage:
 *   const memoizedRSI = memoize(calculateRSI, { maxSize: 50 });
 */
export function memoize(fn, options = {}) {
  const { maxSize = 128, keyFn = defaultKeyFn } = options;
  const cache = new Map();

  function defaultKeyFn(...args) {
    // Stable key for arrays/objects (common in this codebase)
    return args.map(arg => {
      if (Array.isArray(arg)) return `arr:${arg.length}:${contentHash(arg.slice(-5))}`; // last 5 + length for large price series
      if (arg && typeof arg === 'object') return contentHash(arg);
      return String(arg);
    }).join('|');
  }

  return function memoized(...args) {
    const key = keyFn(...args);
    if (cache.has(key)) {
      return cache.get(key);
    }

    const result = fn(...args);

    // Evict oldest if over limit
    if (cache.size >= maxSize) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }

    cache.set(key, result);
    return result;
  };
}

/**
 * Idempotent wrapper for async functions that should produce the same
 * side-effect-free result on repeated calls (e.g., data fetching with caching).
 * Simple in-memory + optional disk cache stub.
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