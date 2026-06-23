// src/worm/estimation/technical-indicators.mjs
// Technical analysis indicators for generating additional alpha signals.
// These can be used to filter, modulate, or confirm harvest/rebalance/spawn decisions
// in the trading engine, regime detection, and scientific optimizer.
// Pure functions, no external dependencies. Suitable for both batch backtests and streaming.
//
// Caching note: For maximum performance in optimizer sweeps, wrap heavy calls with
// memoize from '../utils/idempotent-cache.mjs' (or use the exported memoized variants
// in future versions). The functions are already idempotent by design.