import fs from 'fs';
import path from 'path';

// Re-export the enhanced, alpha-aware versions from the modular sub-packages.
// This resolves duplication and makes the richer RegimeDetector (with RSI,
// Bollinger, ROC, and composite alphaConviction) the canonical implementation
// used throughout the system (trading-engine, optimizer, legion, dreamer, etc.).

export { AssetRegimeManager } from './regime/asset-regime-manager.mjs';
export { RegimeDetector } from './regime/regime-detector.mjs';

// Optional: convenience re-export of the full alpha conviction helper
export { calculateAlphaConviction } from './estimation/technical-indicators.mjs';

/**
 * Legacy note (for migration):
 * Previous inline RegimeDetector has been replaced by the enhanced version above.
 * All existing callers continue to work because the public API (analyze, getRegime, etc.)
 * remains compatible. New callers can use getAlphaRegimeInfo(symbol) and the rich diagnostics.
 */