// Cryptobot Token Flex (ESM style) - v4.0.0 "Hyper-Evolutionary" - All Parameters Evolvable

import dotenv from "dotenv";
import readline from "readline";
import fs from 'fs';
import path from "path";
import { fileURLToPath } from 'url';
import { fork } from 'child_process';
import { CoinbaseWormAPI } from './src/worm/api/coinbase-adapter.mjs';
import { createClient, buildMinOrderQtyMap } from './coinbase-advanced.js';
import {
  minIncrementMap,
  SLIPPAGE_BUFFERS,
  HARVEST_EXCLUDE,
  REBALANCE_EXCLUDE,
  SNOWBALL_CONFIG,
  defaultGenome,
} from './src/worm/config/constants.mjs';
import { setMinOrderQtyMap } from './src/worm/utils/quantity.mjs';
import { getGenomicParam } from './src/worm/utils/helpers.mjs';

dotenv.config();

// ─── Lifted submodules ───────────────────────────────────────────────────────
import { TradingEngine } from './src/worm/engine/trading-engine.mjs';
import { printTable } from './src/worm/utils/format.mjs';
import { loadRecentMarketData, pruneMarketDataFile, appendMarketData } from './src/worm/utils/trade-logger.mjs';
import { parsePreviewOrderArgs, parseStrategyPreviewArgs, parseStrategyPlaceArgs } from './src/worm/cli/args.mjs';
import { runPreviewOrderOnce } from './src/worm/cli/run-preview.mjs';
import { runStrategyPreviewOnce } from './src/worm/cli/run-strategy-preview.mjs';
import { runStrategyPlaceOnce } from './src/worm/cli/run-strategy-place.mjs';
// ─────────────────────────────────────────────────────────────────────────────


// Dynamic MIN_ORDER_QTY_MAP fetched from Coinbase products
let MIN_ORDER_QTY_MAP = {};

async function initMinOrderQtyMap() {
  try {
    const client = createClient();
    const map = await buildMinOrderQtyMap(client);
    if (Object.keys(map).length === 0) throw new Error('Empty map returned');
    setMinOrderQtyMap(map);
    console.log(`📦 Dynamic MIN_ORDER_QTY_MAP loaded: ${Object.keys(map).length} assets`);
  } catch (err) {
    console.warn(`⚠️ Failed to load dynamic MIN_ORDER_QTY_MAP, using $0.50 min order fallback: ${err.message}`);
    console.log(`📦 Using $0.50 minimum order value fallback`);
  }
}



// ============== Config/Maps and Constants ==============

// --- Asset Specific ---
// (minIncrementMap and SLIPPAGE_BUFFERS imported from ./src/worm/config/constants.mjs)

// Exclude BTC/ETH/USDC/USDG from automatic actions
// (HARVEST_EXCLUDE, REBALANCE_EXCLUDE, PRECISION_THRESHOLD imported from constants.mjs)

// --- Hybrid Stablecoin Snowball Bank & Spawner Config ---
// (SNOWBALL_CONFIG imported from constants.mjs)

// --- Genome Definition (Hyper-Evolutionary Core) ---
// (defaultGenome imported from constants.mjs)

// --- Active Genome State ---
let currentGenome = { ...defaultGenome };

// --- Persistence ---
const STATE_FILE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'liveEngineState.json');
const BASELINE_LOAD_TOLERANCE_PERCENT = 0.50;

// --- COMPOUNDING CONFIG (The Alpha Tithe) ---
const ENABLE_AUTO_COMPOUND = true;
const COMPOUND_THRESHOLD_USD = 50.00; // Only invest if we have > $50 spare cash
const COMPOUND_ALLOCATION_PCT = 0.01; // Use 1% of total cash (The Tithe)
const GROWTH_INTERVAL = 4 * 60 * 60 * 1000; // Every 4 hours


// --- Global State ---
let priceHistory = loadRecentMarketData(500); // Hydrate on startup: 200 for Adaptive, 500 for Dreamer start
// --- Auto-Config Safety Net ---
function autoConfigMinQuantities(history) {
  if (!history || history.length === 0) return;
  const latest = history[history.length - 1];
  if (!latest || !latest.p) return;

  Object.entries(latest.p).forEach(([symbol, price]) => {
    if (MIN_ORDER_QTY_MAP[symbol] === undefined) {
      // Target $1.00 Value for Safety
      const safeQty = 1.0 / price;
      // Round to sensible precision (e.g. 1 sig fig)
      const magnitude = Math.pow(10, Math.floor(Math.log10(safeQty)));
      const rounded = Math.ceil(safeQty / magnitude) * magnitude;

      MIN_ORDER_QTY_MAP[symbol] = rounded;
      // console.warn(`⚠️ [SafetyNet] Auto-configured MinQty for ${symbol}: ${rounded} (Price: $${price})`);
    }
  });
}
autoConfigMinQuantities(priceHistory);


const INITIAL_ONE_TIME_BUY_USD = 100.00; // Small threshold for float comparisons

// ==================================================
// Sanity check allocation percentages
if (Math.abs(defaultGenome.HARVEST_ALLOC_BTC_PERCENT + defaultGenome.HARVEST_ALLOC_ETH_PERCENT + defaultGenome.HARVEST_ALLOC_REINVEST_PERCENT + defaultGenome.HARVEST_ALLOC_CASH_PERCENT - 1.0) > 0.001) {
  console.warn("Configuration Warning: Harvest allocation percentages (Genome) do not sum precisely to 1.0 (100%).");
}
// ==================================================


// ============== Trading Engine (The Brain) ==============

// ============== Global State ==============
let liveEngine;
let harvestedAmount = 0;        // Tracks USD harvested within a single cycle
// (getEffectivePriceFromResp, getFilledQuantityFromResp, getTotalFeesFromResp, getGrossValueFromResp, getSettledValueFromResp imported from helpers.mjs)


function loadState() {
  let loadedBaselines = {};
  let loadedTrailingState = {};
  let loadedLastActionTimestamps = {};
  let loadedGenome = null;
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const data = fs.readFileSync(STATE_FILE_PATH, 'utf-8');
      const loadedData = JSON.parse(data);
      loadedBaselines = loadedData.baselines || {};
      loadedTrailingState = loadedData.trailingState || {};
      loadedLastActionTimestamps = loadedData.lastActionTimestamps || {};
      loadedGenome = loadedData.genome; // Load genome but don't set global yet
      const loadedAssetSourceTimeframe = loadedData.assetSourceTimeframe || {};
      // oracleState will be extracted in main()
      console.log(`✅ Loaded state from ${STATE_FILE_PATH}.`);
      return { loadedBaselines, loadedTrailingState, loadedLastActionTimestamps, loadedGenome, loadedData, loadedAssetSourceTimeframe };
    } else {
      console.log(`ℹ️ ${STATE_FILE_PATH} not found, starting with fresh state.`);
    }
  } catch (err) {
    console.error(`❌ Error loading state from ${STATE_FILE_PATH}:`, err);
  }
  return { loadedBaselines, loadedTrailingState, loadedLastActionTimestamps, loadedGenome, loadedData: {} };
}
function saveState() {
  try {
    if (!liveEngine) return;
    const stateToSave = liveEngine.getStateSnapshot(); // Save from Engine
    const tempFilePath = STATE_FILE_PATH + '.tmp';
    fs.writeFileSync(tempFilePath, JSON.stringify(stateToSave, null, 2));

    // EPERM Safe Rename
    try {
      fs.renameSync(tempFilePath, STATE_FILE_PATH);
    } catch (renameErr) {
      if (renameErr.code === 'EPERM' || renameErr.code === 'EBUSY') {
        // Retry once after small delay or fallback to copy
        try {
          fs.copyFileSync(tempFilePath, STATE_FILE_PATH);
          fs.unlinkSync(tempFilePath);
        } catch (copyErr) {
          console.error("🚨 RETRY SAVE FAILED:", copyErr.message);
        }
      } else {
        throw renameErr;
      }
    }
  } catch (err) { console.error("🚨 CRITICAL ERROR: Failed to save state:", err.message); }
}
// ============== Main Application Logic ==============
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

let globalSaveEngineState = null;


async function mainLoop() {
  globalSaveEngineState = saveEngineState;
  pruneMarketDataFile(); // Run HDD-safe pruning once on startup
  console.log("🚀 Initializing Cryptobot Token Flex (v4.0.0 - Shadow Engine Architecture)...");

  // Initialize dynamic asset map from Coinbase products
  await initMinOrderQtyMap();

  const dryRunOnce = process.argv.includes('--dry-run-once');
  const previewOrder = parsePreviewOrderArgs(process.argv);
  const strategyPreview = parseStrategyPreviewArgs(process.argv);
  const strategyPlace = parseStrategyPlaceArgs(process.argv);
  const previewMode = Boolean(previewOrder || strategyPreview);
  const readOnly = dryRunOnce || process.env.WORM_READ_ONLY === '1';

  if (strategyPlace && process.env.ALLOW_LIVE_TRADE !== '1') {
    throw new Error('Refusing --place-strategy without ALLOW_LIVE_TRADE=1');
  }
  if (strategyPlace && !strategyPlace.confirm) {
    throw new Error('Refusing --place-strategy without --yes confirmation');
  }

  let rh;
  try {
    const baseCoinbaseApi = new CoinbaseWormAPI({ readOnly, previewOnly: previewMode });
    const modeLabel = strategyPlace ? ' [STRATEGY-LIVE]' : strategyPreview ? ' [STRATEGY-PREVIEW]' : previewOrder ? ' [PREVIEW-ONLY]' : readOnly ? ' [READ-ONLY-FACADE]' : '';
    rh = baseCoinbaseApi;
    console.log(`🔑 Coinbase API Initialized${modeLabel}.`);
  }
  catch (error) { console.error("❌ FATAL: API initialization failed:", error.message); rl.close(); return; }

  // --- Initialize Engine ---
  // Engine is live-action shaped in every runtime.
  const engineMode = 'live';
  liveEngine = new TradingEngine(defaultGenome, engineMode);

  // Load State (for genome, promotion thresholds, etc.)
  const { loadedBaselines, loadedTrailingState, loadedLastActionTimestamps, loadedGenome, loadedData, loadedAssetSourceTimeframe } = loadState();
  if (loadedData) {
    liveEngine.loadPersistedState(loadedData);
    if (loadedData.overflowTarget) {
      SNOWBALL_CONFIG.OVERFLOW_TARGET = loadedData.overflowTarget;
      console.log(`🎯 [Worm Config] Restored dynamic overflow target: ${SNOWBALL_CONFIG.OVERFLOW_TARGET}`);
    }
  }
  if (loadedGenome) {
    liveEngine.genome = { ...defaultGenome, ...loadedGenome };
    if (loadedGenome.overrides) {
      liveEngine.genome.overrides = { ...loadedGenome.overrides };
    }
  }

  // Initialize promotion threshold from saved state — sanitize blowout scores on EVERY boot
  if (loadedData && loadedData.lastBestScore !== undefined) {
    const raw = loadedData.lastBestScore;
    const sanitized = { SUBTRACTIVE_V2: true };
    let purged = 0;
    if (typeof raw === 'object' && raw !== null) {
      Object.entries(raw).forEach(([key, val]) => {
        if (key === 'SUBTRACTIVE_V1' || key === 'SUBTRACTIVE_V2') return;
        // Keep scores in a sane range. Anything below -500% or above 500% is a backtest blowout/glitch.
        // Shadow thresholds represent dollar values (often > 500) and should be excluded from the upper bound check.
        const isShadowKey = key.endsWith('_SHADOW');
        const isSane = typeof val === 'number' && !isNaN(val) && val >= -500 && (isShadowKey || val <= 500);
        if (isSane) {
          sanitized[key] = val;
        } else {
          purged++;
          console.log(`   🧹 Purging blowout/glitched threshold: ${key} = ${typeof val === 'number' ? val.toFixed(2) : val}% → reset to open`);
        }
      });
    }
    if (purged > 0) console.log(`   ✅ Purged ${purged} blowout threshold(s). Those assets are now open for promotion.`);
    global.lastBestScore = sanitized;

    const assetCount = Object.keys(global.lastBestScore).filter(k => k !== 'SUBTRACTIVE_V2').length;
    if (assetCount > 0) {
      const summary = Object.entries(global.lastBestScore)
        .filter(([k]) => k !== 'SUBTRACTIVE_V2')
        .map(([asset, score]) => `${asset}=${score.toFixed(2)}%`)
        .join(', ');
      console.log(`🎯 Restored promotion thresholds (Subtractive Scale V2): ${summary}`);
    } else {
      console.log(`🎯 Initialized promotion thresholds: (empty, will populate per-asset)`);
    }
  } else {
    global.lastBestScore = { SUBTRACTIVE_V2: true };
    console.log(`🎯 Initialized promotion thresholds: (empty, will populate per-asset)`);
  }

  console.log("🧬 Live Engine Genome Loaded.");

  if (previewOrder) {
    await runPreviewOrderOnce(liveEngine, rh, previewOrder);
    rl.close();
    return;
  }

  if (strategyPlace) {
    console.log('⚠️ Guarded live strategy mode enabled. One strategy-selected live order will be allowed this run.');
  }

  // Inject Global Price History into Live Engine for Shadows to share
  if (typeof priceHistory !== 'undefined') {
    liveEngine.priceHistoryBuffer = priceHistory;
    console.log(`🔗 Linked Global Price History to Live Engine (${priceHistory.length} ticks).`);
  }

  // --- Display Genome Personality (Hyper-Evolutionary Config) ---
  console.log("\n╔═══════════════════════════════════════════════════╗");
  console.log("║       🧬 Live Bot Genome Personality 🧬          ║");
  console.log("╠═══════════════════════════════════════════════════╣");
  const g = liveEngine.genome;
  console.log(`║ Allocation Mode: ${g.ALLOCATION_MODE === 0 ? 'BALANCED' : g.ALLOCATION_MODE === 1 ? 'GROWTH' : 'DEFENSIVE'}                                  ║`);
  console.log(`║ PHYSICS:                                          ║`);
  console.log(`║   Baseline Drag (Reality): ${(g.SPAR_DRAG_COEFFICIENT || 0.999968).toFixed(6)}              ║`);
  console.log(`║   Baseline Drag (Grace):   ${(g.SPAR_DRAG_GRACE_COEFFICIENT || 0.999998).toFixed(6)}              ║`);
  console.log(`║   Price Memory: ${(g.PRICE_HISTORY_WINDOW_SIZE || 200)} ticks                           ║`);
  console.log(`║   Volatility Threshold: ${((g.ADAPTIVE_VOLATILITY_THRESHOLD || 0.015) * 100).toFixed(2)}%                  ║`);
  console.log(`║ TIMING:                                           ║`);
  console.log(`║   Harvest Timeout: ${Math.round((g.FORCED_HARVEST_TIMEOUT || 1200000) / 60000)}m                      ║`);
  console.log(`║   Rebalance Cooldown: ${Math.round((g.REBALANCE_COOLDOWN || 1800000) / 60000)}m                   ║`);
  console.log(`║   Forced Rebalance: ${Math.round((g.FORCE_REBALANCE_TIMEOUT || 1500000) / 60000)}m                    ║`);
  console.log(`║ RISK:                                             ║`);
  console.log(`║   Max Rebalance Attempts: ${g.MAX_REBALANCE_ATTEMPTS || 3}                     ║`);
  console.log(`║   Crash Trigger: ${((g.CP_TRIGGER_MIN_NEGATIVE_DEV_PERCENT || -0.07) * 100).toFixed(1)}%                       ║`);
  console.log(`║ EVOLUTION:                                        ║`);
  console.log(`║   Min Trades for Promotion: ${g.MIN_TRADES_FOR_PROMOTION || 2}                  ║`);
  console.log(`║   Required Win Streak: ${g.EVOLUTION_CONSISTENCY_COUNT || 3}                       ║`);
  console.log(`║   Oracle Trend Threshold: ${g.ORACLE_TREND_THRESHOLD || 0.8}                     ║`);
  console.log(`║   Oracle Volatility Threshold: ${(g.ORACLE_VOLATILITY_THRESHOLD || 2.0).toFixed(1)}%                  ║`);
  console.log(`║   Oracle Flash Threshold: ${(liveEngine.genome.FLASH_THRESHOLD || 0.05).toFixed(2)}% (Tick-to-Tick)       ║`);
  console.log("╚═══════════════════════════════════════════════════╝\n");

  let initialized = false;
  let lastEngineHoldings = {}; // Track engine's holdings from previous cycle for display

  // Dreamer grid and Legion orchestration were removed in the paper/shadow/dreamer burn-down.
  // Genome evolution is now static — live engine reads defaultGenome from disk and applies
  // loaded overrides only; no external optimizer pipeline.

  let lastStateSaveTime = 0; // Fix: Initialize variable to prevent ReferenceError
  let lastHistoryRefreshTime = Date.now(); // Track when we last refreshed history
  let lastOptimizationTime = Date.now(); // Track when we last triggered optimizations
  const HOURLY_REFRESH_INTERVAL = 60 * 60 * 1000; // 1 hour
  const STATE_SAVE_INTERVAL = 5 * 60 * 1000; // Save every 5 minutes

  // State save function - ROBUST VERSION
  function saveEngineState() {
    try {
      if (!liveEngine) return;
      const stateToSave = liveEngine.getStateSnapshot();
      const scriptDir = path.dirname(fileURLToPath(import.meta.url));
      const tempFilePath = path.join(scriptDir, 'liveEngineState.json.tmp');
      const finalFilePath = path.join(scriptDir, 'liveEngineState.json');

      // Write to temp file first
      fs.writeFileSync(tempFilePath, JSON.stringify(stateToSave, null, 2));

      // Retry loop for rename (Windows EPERM fix)
      let saved = false;
      let attempts = 0;
      while (!saved && attempts < 3) {
        try {
          // Try to rename
          if (fs.existsSync(finalFilePath)) {
            try { fs.unlinkSync(finalFilePath); } catch (e) { /* ignore unlink fail */ }
          }
          fs.renameSync(tempFilePath, finalFilePath);
          saved = true;
        } catch (err) {
          attempts++;
          if (attempts >= 3) throw err; // Throw on final failure

          // Simple synchronous delay (busy wait) to allow file lock to clear
          const start = Date.now();
          while (Date.now() - start < 100);
        }
      }
    } catch (err) {
      console.error("🚨 CRITICAL ERROR: Failed to save state (Retried 3x):", err.message);
    }
  }


  // 4. The Legion Manager (removed in paper/shadow/dreamer burn-down).
  // The live engine reads defaultGenome + loaded overrides directly. No shadow dispatcher,
  // no per-asset optimization queue.

  let previousCycleValues = {}; // Restoration of missing UI state

  // --- Growth Timer ---
  let lastGrowthTime = Date.now();

  // --- Terminal Commands CLI Listener ---
  rl.on('line', (line) => {
    const input = line.trim();
    if (input.toLowerCase().startsWith('target ')) {
      const parts = input.split(/\s+/);
      const newTarget = parts[1]?.toUpperCase();
      if (newTarget) {
        SNOWBALL_CONFIG.OVERFLOW_TARGET = newTarget;
        console.log(`🎯 [Worm Config] Overflow target changed dynamically to: ${newTarget}`);
        saveEngineState();
      } else {
        console.log(`❌ Invalid target symbol. Usage: target <SYMBOL> (e.g., target ETH)`);
      }
    } else if (input.toLowerCase() === 'target') {
      console.log(`🎯 [Worm Config] Current Overflow Target: ${SNOWBALL_CONFIG.OVERFLOW_TARGET}`);
    } else if (input.toLowerCase() === 'help') {
      console.log(`\n📌 Available CLI Commands:`);
      console.log(`   👉 target <SYMBOL>  : Change the dynamic overflow target (e.g., target SOL)`);
      console.log(`   👉 target           : Display the current overflow target`);
      console.log(`   👉 status           : Display bot status details`);
      console.log(`   👉 help             : Show this help message\n`);
    } else if (input.toLowerCase() === 'status') {
      console.log(`\nℹ️ [Bot Status]`);
      console.log(`   👉 Current Overflow Target: ${SNOWBALL_CONFIG.OVERFLOW_TARGET}`);
      console.log(`   👉 Cash Balance: $${(liveEngine?.cashBalance || 0).toFixed(2)}`);
      if (liveEngine) {
        const activeBaselines = Object.entries(liveEngine.baselines).filter(([_, v]) => v > 0);
        console.log(`   👉 Active Baselines count: ${activeBaselines.length}`);
        console.log(`   👉 Active Baselines: ${activeBaselines.map(([k, v]) => `${k}($${v.toFixed(2)})`).join(', ')}`);

        // Compute and display dynamic critical mass escalator target
        const dummySummary = activeBaselines.map(([k, v]) => ({ Symbol: k, Value: v })); // approximate values using baselines
        const currentCrit = liveEngine._getDynamicCriticalMass(dummySummary, liveEngine.holdings || {});
        console.log(`   👉 Dynamic Escalator Target: $${currentCrit.toFixed(2)}`);
      }
      console.log("");
    }
  });

  while (true) {
    const startTime = Date.now();
    console.log(`\n----- Cycle Start: ${new Date().toISOString()} -----`);

    // --- THE ALPHA TITHE (Systematic Growth) ---
    if (ENABLE_AUTO_COMPOUND && startTime - lastGrowthTime > GROWTH_INTERVAL) {
      console.log("\n🌱 [GROWTH] Checking for Organic Growth opportunities...");

      // 1. Check Cash
      let currentCash = 0;
      try { currentCash = await rh.getBalance(); } catch (e) { console.warn("   ⚠️ Could not fetch balance for Growth check."); }

      if (currentCash > COMPOUND_THRESHOLD_USD) {
        // 2. Find the #1 Asset (Highest Alpha)
        let kingAsset = null;
        let kingScore = -Infinity;
        let kingTimeframe = 'MEDIUM'; // Default

        if (global.lastBestScore) {
          Object.keys(global.lastBestScore).forEach(key => {
            const score = global.lastBestScore[key];
            // key format: ASSET_TIMEFRAME (e.g. BTC_LONG)
            const parts = key.split('_');
            const asset = parts[0];

            // Filter: Must be tracked by Live Engine
            if (liveEngine.baselines[asset] && !REBALANCE_EXCLUDE.includes(asset)) {
              if (score > kingScore) {
                kingScore = score;
                kingAsset = asset;
                kingTimeframe = parts[1] || 'MEDIUM';
              }
            }
          });
        }

        // 3. Calculate Tithe (1% or $1.00 min)
        let titheAmount = currentCash * COMPOUND_ALLOCATION_PCT;
        if (titheAmount < 1.05) titheAmount = 1.05; // Enforce Robinhood minimum (slightly padded)

        // 4. Verification & Execution
        if (kingAsset && kingScore > 0) {
          // Check Live Trend (Don't buy a crashing asset)
          // utilize latest quote from previous cycle if available, or fetch new?
          // We will fetch new quotes in the main logic anyway. Let's do a quick focused fetch or use previous cycle data?
          // Using previous cycle data is safer for rate limits.
          // But we are at the START of the loop. 'previousCycleValues' holds VALUE, not Price/Deviation.
          // Let's just let it ride on Alpha confidence + Deviation check after quote fetch?
          // No, let's just fetch the single quote.
          try {
            const q = await rh.getQuotes([kingAsset]);
            if (q[kingAsset]) {
              const price = q[kingAsset];
              const baseline = liveEngine.baselines[kingAsset];
              const dev = baseline > 0 ? (price * (holdingDetails[kingAsset]?.rawQuantity || 0) - baseline) / baseline : 0;

              // FILTER: Only buy if Deviation > -1% (Not crashing)
              // Actually, let's use a simpler logic: Is it active?
              if (dev > -0.01) {
                console.log(`👑 [GROWTH] The King is ${kingAsset} (${kingTimeframe} Alpha: ${kingScore.toFixed(3)}%). Trend OK (${(dev * 100).toFixed(2)}%). Executing Tithe: $${titheAmount.toFixed(2)}...`);

                const qty = titheAmount / price; // Raw calc
                // We rely on API wrapper or rounding. API wrapper passes string.
                // We need to round it precisely.
                // Helper:
                const decimals = minIncrementMap[kingAsset] < 0.01 ? 6 : 2; // Rough heuristic or use minIncrementMap
                // actually use logic from TradingEngine (not accessible here easily).
                // Let's use string formatting safe enough.
                const fmtQty = qty.toFixed(decimals === 6 ? 6 : 2); // conservative

                // Check Buying Power again? API handles it.
                if (titheAmount <= currentCash) {
                  const res = await rh.placeBuy(`${kingAsset}-USD`, fmtQty);
                  if (res) {
                    console.log(`   ✅ Growth Buy Placed. Adjusting Baseline...`);
                    liveEngine.baselines[kingAsset] += titheAmount;
                    console.log(`   📈 Baseline for ${kingAsset} increased by $${titheAmount.toFixed(2)} (New: $${liveEngine.baselines[kingAsset].toFixed(2)}).`);
                    lastGrowthTime = Date.now();
                  } else {
                    console.warn("   ❌ Growth Buy Failed (API Error).");
                  }
                }
              } else {
                console.log(`   📉 [GROWTH] Skipped ${kingAsset}. Alpha is high (${kingScore.toFixed(2)}%), but currently crashing (Dev: ${(dev * 100).toFixed(2)}%). Saving cash.`);
              }
            }
          } catch (err) { console.error("   ⚠️ Growth check error:", err.message); }
        } else {
          console.log("   🤷 [GROWTH] No suitable King Asset found (or Alpha negative).");
        }

        // Reset timer anyway to avoid spamming loop if checks fail
        lastGrowthTime = Date.now();

      } else {
        console.log(`   💤 [GROWTH] Cash too low ($${currentCash.toFixed(2)} < $${COMPOUND_THRESHOLD_USD}). Sleeping.`);
        lastGrowthTime = Date.now();
      }
    }

    // --- Hourly History Refresh & Re-Optimization ---
    if (startTime - lastHistoryRefreshTime >= HOURLY_REFRESH_INTERVAL) {
      console.log("\n🔄 [HOURLY REFRESH] Reloading 24-hour price history...");
      // The history is loaded per-worker, so we signal a restart would be needed.
      // For now, we'll just flag that it's time and let the Dreamer workers use fresh data on next optimization.
      // In practice, we should reload the history here or restart workers.
      // Since workers load history on optimization start, triggering optimization will use fresh data.
      lastHistoryRefreshTime = startTime;
      lastOptimizationTime = 0; // Force immediate optimization after history refresh
      console.log("   ✅ History refresh scheduled. Will trigger optimization...");
    }

    if (startTime - lastOptimizationTime >= HOURLY_REFRESH_INTERVAL) {
      // Hourly scientific optimization was Legion-driven; removed in burn-down.
      lastOptimizationTime = startTime;
    }

    // --- Status Display ---
    // LEGION status display removed (no shadowLegion / assetHeatMap).


    // --- Use Engine State References for Convenience (Refactoring Step) ---
    // This allows us to keep the rest of the loop largely unchanged for this step
    // while relying on the class's storage.
    // We will eventually move the logic INTO the class.
    let tokenBaselines = liveEngine.baselines;
    let trailingState = liveEngine.trailingState;
    let lastActionTimestamps = liveEngine.lastActionTimestamps;
    let rebalanceState = liveEngine.rebalanceState;
    let portfolioHarvestState = liveEngine.portfolioHarvestState;
    const currentGenome = liveEngine.genome; // Use the engine's genome

    harvestedAmount = 0;
    let anyTradesThisCycle = false;
    let stateChanged = false;

    // Fetch Balance, Holdings, Quotes through the wallet facade. Coinbase market
    // reads stay live; portfolio/order state may be simulated when --paper was
    // selected or Coinbase rejected trade scope on a read-only key.
    let cashBalance = 0; try { cashBalance = await rh.getBalance(); liveEngine.cashBalance = cashBalance; console.log(`💰 Available Cash Balance: $${cashBalance.toFixed(2)}`); } catch (err) { console.error("❌ FATAL: Could not fetch balance:", err.message); rl.close(); return; }
    let holdings = [];
    let holdingDetails = {};
    let codes = [];
    let rhPrices = {};

    try { holdings = await rh.getHoldings(); if (holdings.length === 0) console.log("ℹ️ No crypto holdings found."); } catch (err) { console.error("❌ FATAL: Could not fetch holdings:", err.message); rl.close(); return; }
    if (holdings.length > 0) { holdings.forEach(h => { const code = h.asset_code; const qty = parseFloat(h.total_quantity) || 0; const minQtyThreshold = minIncrementMap[code] ? (minIncrementMap[code] / 10) : 1e-10; if (code && qty > minQtyThreshold) { if (!holdingDetails[code]) { holdingDetails[code] = { rawQuantity: 0 }; codes.push(code); } holdingDetails[code].rawQuantity += qty; } }); if (codes.length > 0) console.log(`📊 Holdings: ${codes.join(', ')}`); else console.log("ℹ️ No significant crypto holdings found after filtering."); }
    if (codes.length > 0) { try {
      await rh.startWS(codes);
      const wsPrices = rh.getWsPriceMap(codes);
      const missing = codes.filter(s => !wsPrices[s]);
      const restPrices = missing.length > 0 ? await rh.getQuotes(missing) : {};
      rhPrices = { ...wsPrices, ...restPrices };
    } catch (err) { console.error("❌ FATAL: Could not fetch quotes:", err.message); rl.close(); return; } } else { console.log("ℹ️ Skipping quote fetch."); }

    // Calculate Portfolio Summary & Initialize/Verify Baselines & State (Unchanged)
    let totalHoldingsValue = 0; const portfolioSummary = []; const currentSymbols = new Set(); let baselinesVerifiedOrSetThisCycle = false;
    codes.forEach((sym) => {
      currentSymbols.add(sym); const details = holdingDetails[sym]; const price = rhPrices[sym];
      if (price === undefined || price === null || isNaN(price) || price <= 0) { console.warn(`⚠️ Warn: Invalid price for ${sym}. Skipping calculations & state checks.`); if (trailingState[sym]) delete trailingState[sym].previousDeviation; if (rebalanceState[sym]) delete rebalanceState[sym].previousDeviation; return; }
      const totalQty = details.rawQuantity; const currentHoldingValue = price * totalQty; totalHoldingsValue += currentHoldingValue;
      if (!initialized) {
        const existingBaseline = tokenBaselines[sym];
        if (existingBaseline !== undefined && typeof existingBaseline === 'number' && existingBaseline > 0.01) {
          const savedQty = loadedData?.holdings?.[sym]?.rawQuantity || 0;

          // CRITICAL FIX: Removed proportional quantity alignment startup sync completely.
          // Startup should not mess with baselines for minor quantity differences.
          // Only if there is a major deviation (exceeding tolerance) does it reset to the current holdings value.

          const diff = Math.abs(currentHoldingValue - existingBaseline);
          const diffPercent = existingBaseline === 0 ? Infinity : diff / existingBaseline;
          if (diffPercent <= BASELINE_LOAD_TOLERANCE_PERCENT) {
            /* keep baseline log */
          } else {
            tokenBaselines[sym] = currentHoldingValue;
            console.log(`⚠️ ${sym}: Baseline reset to current value $${currentHoldingValue.toFixed(2)} (Diff: ${(diffPercent * 100).toFixed(2)}% > ${BASELINE_LOAD_TOLERANCE_PERCENT * 100}% tolerance).`);
            stateChanged = true;
          }
          baselinesVerifiedOrSetThisCycle = true;
        } else if (!tokenBaselines[sym] && currentHoldingValue > 0.01) {
          tokenBaselines[sym] = currentHoldingValue;
          console.log(`✨ Initialized baseline ${sym}: $${tokenBaselines[sym].toFixed(2)}.`);
          baselinesVerifiedOrSetThisCycle = true;
          stateChanged = true;
        }
      }
      if (!tokenBaselines[sym] && currentHoldingValue > 0.01) { tokenBaselines[sym] = currentHoldingValue; console.log(`✨ Initialized baseline ${sym} (post-init): $${tokenBaselines[sym].toFixed(2)}.`); stateChanged = true; }
      if (!lastActionTimestamps[sym] && tokenBaselines[sym] > 0.01) { console.log(`✨ Initialized last action timestamp for ${sym}.`); lastActionTimestamps[sym] = Date.now(); stateChanged = true; }
      portfolioSummary.push({ Symbol: sym, Quantity: totalQty, Price: price, Value: currentHoldingValue, Baseline: tokenBaselines[sym], usdValueNum: currentHoldingValue });
    });

    // --- Data Recorder (Black Box) ---
    // Save tick data for "Time Machine" simulations
    if (portfolioSummary.length > 0) {
      appendMarketData(Date.now(), portfolioSummary);
    }

    const walletIsSimulated = Boolean(rh?.isSimulatedWallet?.());

    // Simulated wallet facade can trade from cash even with no starting holdings.
    if (!initialized && walletIsSimulated && liveEngine.cashBalance > 0) {
      console.log("✅ Simulated wallet facade initialized: ready to spawn assets.");
      initialized = true;
      if (stateChanged) { saveState(); stateChanged = false; }
    }
    else if (!initialized && baselinesVerifiedOrSetThisCycle) {
      console.log("✅ Baselines & Timestamps init/verify complete.");
      initialized = true;
      // Capture initial capital on first successful initialization
      if (liveEngine.initialCapital <= 0 && portfolioSummary.length > 0) {
        const initialValue = portfolioSummary.reduce((sum, r) => sum + r.Value, 0) + liveEngine.cashBalance;
        if (initialValue > 0) {
          liveEngine.initialCapital = initialValue;
          liveEngine.peakTotalValue = initialValue;
          console.log(`💰 Initial Capital recorded: $${initialValue.toFixed(2)}`);
        }
      }
      if (stateChanged) { saveState(); stateChanged = false; }
    } else if (!initialized && holdings.length > 0 && codes.length === 0) { console.log("⏳ Waiting for valid prices to initialize baselines..."); }

    // --- Clean up persistent state for EXCLUDED assets that are still held ---
    currentSymbols.forEach(sym => {
      if (HARVEST_EXCLUDE.includes(sym)) {
        if (trailingState[sym]) {
          console.log(`🗑️ Clearing persistent trailing (harvest) state for EXCLUDED asset: ${sym}`);
          delete trailingState[sym];
          stateChanged = true;
        }
      }
      if (REBALANCE_EXCLUDE.includes(sym) && rebalanceState[sym]) {
        delete rebalanceState[sym];
      }
    });

    // --- STARTUP OPTIMIZATION TRIGGER ---
    // Startup optimization removed (Legion-driven). The live engine starts cold; the
    // operator loads a tuned genome via disk before boot.
    // --- End EXCLUDED asset state cleanup ---

    let deletedKeys = false;
    Object.keys(tokenBaselines).forEach(sym => {
      if (!currentSymbols.has(sym)) {
        const lastAction = lastActionTimestamps[sym] || 0;
        const timeSinceLastAction = Date.now() - lastAction;
        if (timeSinceLastAction < 15 * 60 * 1000) {
          console.log(`⏳ Holding baseline for recently acted/spawned asset: ${sym} (Pending settlement/API refresh, last action: ${Math.round(timeSinceLastAction / 1000)}s ago).`);
          return;
        }
        console.log(`🗑️ Clearing state for sold/removed asset: ${sym}`);
        delete tokenBaselines[sym];
        delete trailingState[sym];
        delete rebalanceState[sym];
        delete lastActionTimestamps[sym];
        deletedKeys = true;
      }
    });
    Object.keys(trailingState).forEach(sym => {
      if (!tokenBaselines[sym]) {
        console.log(`🗑️ Clearing trailing state for ${sym} (no baseline).`);
        delete trailingState[sym];
        deletedKeys = true;
      }
    });
    Object.keys(lastActionTimestamps).forEach(sym => {
      if (!tokenBaselines[sym]) {
        console.log(`🗑️ Clearing last action timestamp for ${sym} (no baseline).`);
        delete lastActionTimestamps[sym];
        deletedKeys = true;
      }
    });
    Object.keys(rebalanceState).forEach(sym => {
      if (!tokenBaselines[sym]) {
        delete rebalanceState[sym];
      }
    });
    if (deletedKeys) { stateChanged = true; } if (stateChanged) { saveState(); stateChanged = false; }

    // Calculate Portfolio Deviation (Only needed for display now)
    let totalBaselineDifference = 0; let totalManagedBaselineValue = 0;
    portfolioSummary.forEach(row => { if (row.Baseline && typeof row.Baseline === 'number' && row.Baseline > 0 && !REBALANCE_EXCLUDE.includes(row.Symbol)) { totalBaselineDifference += (row.Value - row.Baseline); totalManagedBaselineValue += row.Baseline; } });
    let currentPortfolioDeviationPercent = 0; if (totalManagedBaselineValue > 0) { currentPortfolioDeviationPercent = (totalBaselineDifference / totalManagedBaselineValue) * 100; }

    // Display Portfolio Table & Financial Overview (Unchanged)
    if (portfolioSummary.length > 0) {
      portfolioSummary.sort((a, b) => { let devA = NaN; if (a.Baseline && a.Baseline > 0) devA = (a.Value - a.Baseline) / a.Baseline; let devB = NaN; if (b.Baseline && b.Baseline > 0) devB = (b.Value - b.Baseline) / b.Baseline; if (isNaN(devA) && isNaN(devB)) return 0; if (isNaN(devA)) return 1; if (isNaN(devB)) return -1; return devB - devA; }); const displayData = portfolioSummary.map(row => {
        const deviation = (row.Baseline && row.Baseline > 0) ? ((row.Value - row.Baseline) / row.Baseline) * 100 : NaN;

        // Tier 3: Deviation Arrows (↑/↓)
        let arrow = "";
        const tState = trailingState[row.Symbol];
        if (tState && typeof tState.previousDeviation === 'number') {
          const currentDev = (row.Value - row.Baseline) / row.Baseline;
          if (currentDev > tState.previousDeviation) arrow = "↑";
          else if (currentDev < tState.previousDeviation) arrow = "↓";
        }

        const color = (!isNaN(deviation) && deviation < 0) ? '\x1b[31m' : '\x1b[32m'; // Red if neg, Green if pos
        const reset = '\x1b[0m';
        const coloredDeviation = isNaN(deviation) ? 'N/A' : `${color}${arrow}${deviation.toFixed(2)}%${reset}`;

        // --- High-Fidelity Trigger Visualization ---
        let triggerStr = "-";
        let activeH = 0;
        let activeR = 0;

        if (!HARVEST_EXCLUDE.includes(row.Symbol) && !REBALANCE_EXCLUDE.includes(row.Symbol)) {
          const rSt = liveEngine.ratchetState ? liveEngine.ratchetState[row.Symbol] : null;
          const hMod = rSt ? (rSt.harvestModifier || 0.0) : 0.0;
          const rMod = rSt ? (rSt.rebalanceModifier || 0.0) : 0.0;

          const flatH = getGenomicParam(liveEngine.genome, 'FLAT_HARVEST_TRIGGER_PERCENT', row.Symbol);
          const flatR = getGenomicParam(liveEngine.genome, 'FLAT_REBALANCE_TRIGGER_PERCENT', row.Symbol);

          const slipConfig = SLIPPAGE_BUFFERS[row.Symbol] || SLIPPAGE_BUFFERS.DEFAULT;
          const lastBuySlip = rSt && rSt.lastSlippage !== undefined && rSt.lastSlippage !== null ? rSt.lastSlippage : slipConfig.buy;
          const lastSellSlip = rSt && rSt.lastSlippage !== undefined && rSt.lastSlippage !== null ? rSt.lastSlippage : slipConfig.sell;

          const apiBuySlip = (rh && rh.lastSpreads && rh.lastSpreads[row.Symbol]) ? rh.lastSpreads[row.Symbol].buy : null;
          const apiSellSlip = (rh && rh.lastSpreads && rh.lastSpreads[row.Symbol]) ? rh.lastSpreads[row.Symbol].sell : null;
          const effectiveBuySlip = (apiBuySlip !== null) ? Math.max(apiBuySlip, lastBuySlip) : lastBuySlip;
          const effectiveSellSlip = (apiSellSlip !== null) ? Math.max(apiSellSlip, lastSellSlip) : lastSellSlip;

          activeH = flatH + hMod + effectiveSellSlip;
          activeR = flatR + rMod;

          if (liveEngine.isGlobalRiskSignalActive) {
            activeR = (flatR + rMod) * (liveEngine.genome.CRASH_PROTECTION_THRESHOLD_INCREASE || 2);
          }
          activeR += effectiveBuySlip;

          // Colorize Optimized Values (Compare to Default)
          const defH = defaultGenome.FLAT_HARVEST_TRIGGER_PERCENT;
          const defR = defaultGenome.FLAT_REBALANCE_TRIGGER_PERCENT;

          // COLOR CODING: Visual indicator for Timeframe
          let colorCode = '\x1b[37m'; // Default White for Optimized (unknown timeframe)
          const timeframe = liveEngine.assetSourceTimeframe ? liveEngine.assetSourceTimeframe[row.Symbol] : null;

          if (timeframe === 'SHORT') colorCode = '\x1b[36m'; // Cyan
          else if (timeframe === 'MEDIUM') colorCode = '\x1b[33m'; // Yellow
          else if (timeframe === 'LONG') colorCode = '\x1b[35m'; // Magenta

          const reset = '\x1b[0m';

          const hStr = Math.abs(activeH - defH) > 0.000001 ? `${colorCode}${(activeH * 100).toFixed(2)}%${reset}` : `${(activeH * 100).toFixed(2)}%`;
          const rStr = Math.abs(activeR - defR) > 0.000001 ? `${colorCode}${(activeR * 100).toFixed(2)}%${reset}` : `${(activeR * 100).toFixed(2)}%`;

          triggerStr = `${hStr} / ${rStr}`;
        }

        // Value Colorization (Tick-to-Tick)
        let valueColor = "";
        const prevVal = previousCycleValues[row.Symbol];
        if (prevVal !== undefined) {
          if (row.Value > prevVal) valueColor = '\x1b[32m'; // Green (Up)
          else if (row.Value < prevVal) valueColor = '\x1b[31m'; // Red (Down)
        }
        previousCycleValues[row.Symbol] = row.Value; // Update for next cycle

        // --- Baseline Colorization (Status Indicator) ---
        let baselineColor = "";
        if (!HARVEST_EXCLUDE.includes(row.Symbol) && !REBALANCE_EXCLUDE.includes(row.Symbol)) {
          const isHarvestFlagged = tState && tState.flagged;
          const isRebalanceFlagged = rebalanceState && rebalanceState[row.Symbol] && rebalanceState[row.Symbol].triggered;

          if (isHarvestFlagged) {
            baselineColor = `\x1b[32m`; // Green (Active Trailing Harvest)
          } else if (isRebalanceFlagged) {
            baselineColor = `\x1b[31m`; // Red (Active Rebalance)
          } else if (!isNaN(deviation)) {
            if (deviation >= activeH * 100) {
              baselineColor = `\x1b[32m`; // Green (Pre-flagged Harvest Trigger)
            } else if (deviation <= -(activeR * 100)) {
              baselineColor = `\x1b[31m`; // Red (Pre-flagged Rebalance Trigger)
            }
          }
        }

        return {
          Symbol: row.Symbol,
          Quantity: row.Quantity.toLocaleString(undefined, { maximumFractionDigits: 8 }),
          Price: row.Price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 10 }),
          Value: `${valueColor}${row.Value.toLocaleString(undefined, { style: 'currency', currency: 'USD' })}${reset}`,
          Baseline: row.Baseline ? `${baselineColor}$${row.Baseline.toFixed(2)}${reset}` : 'N/A',
          Deviation: coloredDeviation,
          Triggers: triggerStr
        };
      });
      console.log("\n--- Portfolio Summary (Sorted by Deviation %) ---");
      // console.table(displayData); // Disabled due to ANSI escaping issues

      const headers = ["Index", "Symbol", "Quantity", "Price", "Value", "Baseline", "Deviation", "H/R Trig"];
      const tableRows = displayData.map((d, i) => [
        i + 1,
        d.Symbol,
        d.Quantity,
        d.Price,
        d.Value,
        d.Baseline,
        d.Deviation,
        d.Triggers
      ]);
      printTable(headers, tableRows);

    } else { if (holdings.length > 0) console.log("ℹ️ No displayable portfolio data (likely waiting on valid prices)."); }
        console.log("--- Financial Overview ---");
        console.log(`Total Holdings Value:   $${totalHoldingsValue.toFixed(2)}`);
        console.log(`Cash Balance:           $${cashBalance.toFixed(2)}`);
        const totalPortfolioValue = totalHoldingsValue + cashBalance;
        console.log(`Total Portfolio Value:  $${totalPortfolioValue.toFixed(2)}`);

        // PnL / Drawdown metrics
        if (liveEngine.initialCapital > 0) {
          const pnl = totalPortfolioValue - liveEngine.initialCapital;
          const pnlPct = (pnl / liveEngine.initialCapital) * 100;
          const currentDD = liveEngine.peakTotalValue > 0 ? ((liveEngine.peakTotalValue - totalPortfolioValue) / liveEngine.peakTotalValue) * 100 : 0;
          const maxDD = liveEngine.maxDrawdownPercent * 100;
          const pnlColor = pnl >= 0 ? '\x1b[32m' : '\x1b[31m';
          const resetColor = '\x1b[0m';
          console.log(`Val: $${totalPortfolioValue.toFixed(2)}  ${pnlColor}PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)${resetColor}  DD: ${currentDD.toFixed(2)}%  MaxDD: ${maxDD.toFixed(2)}%`);
        }

        const diffPrefix = totalBaselineDifference >= 0 ? '+' : '';
        const diffColor = totalBaselineDifference >= 0 ? '\x1b[32m' : '\x1b[31m';
        const resetColor = '\x1b[0m';
        console.log(`Deviation (Managed):    ${diffColor}${diffPrefix}$${totalBaselineDifference.toFixed(2)} (${currentPortfolioDeviationPercent.toFixed(2)}%)${resetColor}`);

    console.log("--------------------------\n");



    if (strategyPreview) {
      await runStrategyPreviewOnce(liveEngine, rh, strategyPreview, portfolioSummary, holdingDetails, cashBalance);
      break;
    }

    if (strategyPlace) {
      await runStrategyPlaceOnce(liveEngine, rh, strategyPlace, portfolioSummary, holdingDetails, cashBalance);
      break;
    }

    // --- Auto Trading Logic ---
    // Simulated wallet facade may run with empty holdings (spawner needs cash).
    const shouldRunEngine = walletIsSimulated
      ? (liveEngine.cashBalance > 0 && initialized)
      : (portfolioSummary.length > 0 && initialized);
      
    if (!shouldRunEngine) {
      console.log("⏳ Skipping trading actions (Portfolio empty or not initialized).\n");
    }
    else {
      console.log("🚦 Baselines ready. Delegating to Live Engine...");

      const engineResult = await liveEngine.update(portfolioSummary, rh, cashBalance, holdingDetails);

      // Store engine's holdings for next cycle's display (especially paper mode)
      if (engineResult.holdings) {
        lastEngineHoldings = engineResult.holdings;
      }

      // --- Legion Heartbeat --- removed in paper/shadow/dreamer burn-down.


      anyTradesThisCycle = engineResult.anyTradesThisCycle;
      if (engineResult.stateChanged) stateChanged = true;

      // --- Post-Trade "Dream Replay" Trigger ---
      // Post-trade Legion re-optimization removed in burn-down.

      // Refresh Local State References (Aliases) for Display Logic
      // This ensures we display the *post-update* state, especially if objects were reassigned.
      tokenBaselines = liveEngine.baselines;
      trailingState = liveEngine.trailingState;
      lastActionTimestamps = liveEngine.lastActionTimestamps;
      rebalanceState = liveEngine.rebalanceState;
      portfolioHarvestState = liveEngine.portfolioHarvestState;

      // Save state if any persistent changes occurred (with optimized throttling)
      if (stateChanged || anyTradesThisCycle) {
        if (anyTradesThisCycle || (Date.now() - lastStateSaveTime > 5 * 60 * 1000)) {
          saveState();
          lastStateSaveTime = Date.now();
        }
      }
    } // End Auto Trading Logic Block

    // --- Display Active States --- // *** Simplified format ***
    try {
      if (portfolioHarvestState.flagged) { console.log(`📈 Portfolio Harvest Flagged: Count ${portfolioHarvestState.cycleCount}/${currentGenome.PORTFOLIO_HARVEST_CONFIRMATION_CYCLES}, Prev Port. Dev: ${portfolioHarvestState.previousDeviationPercent?.toFixed(2)}%`); }

      const flaggedForHarvest = Object.entries(trailingState)
        .filter(([sym, s]) => s?.flagged && tokenBaselines[sym])
        .map(([sym, s]) => `${sym}:${s.harvestCycleCount}`);
      if (flaggedForHarvest.length > 0) console.log(`🚩 Flagged Harvest: [${flaggedForHarvest.join(", ")}]`);

      const activeRebalancing = Object.entries(rebalanceState)
        .filter(([sym, s]) => s?.triggered && Date.now() >= (s.cooldownUntil || 0) && tokenBaselines[sym])
        .map(([sym, s]) => `${sym}:${s.rebalancePosCycleCount}`);
      const inCooldown = Object.entries(rebalanceState)
        .filter(([sym, s]) => s?.triggered && Date.now() < (s.cooldownUntil || 0) && tokenBaselines[sym])
        .map(([sym, s]) => `${sym}:${Math.ceil(((s.cooldownUntil || 0) - Date.now()) / 60000)}m`);
      if (activeRebalancing.length > 0) console.log(`⚖️ Active Rebalance: [${activeRebalancing.join(", ")}]`);
      if (inCooldown.length > 0) console.log(`⏸️ Rebalance Cooldown: [${inCooldown.join(", ")}]`);

      // Cleaned legacy displays

      if (!anyTradesThisCycle && !portfolioHarvestState.flagged && flaggedForHarvest.length === 0 && activeRebalancing.length === 0 && inCooldown.length === 0 && portfolioSummary.length > 0 && initialized) {
        console.log("🧘 No trading actions or adaptive states triggered this cycle.");
      }
    } catch (displayError) { console.error("⚠️ Error displaying states:", displayError); }


    // --- Periodic & Immediate State Save ---
    // Persist facade-backed simulated state too; --paper is no longer a throwaway agent.
    if (stateChanged || (startTime - lastStateSaveTime >= STATE_SAVE_INTERVAL)) {
      saveEngineState();
      stateChanged = false;
      lastStateSaveTime = startTime;
    }

    // --- Cycle Timing (Unchanged) ---
    const endTime = Date.now(); const elapsed = endTime - startTime; const delay = Math.max(0, currentGenome.REFRESH_INTERVAL - elapsed);
    if (dryRunOnce || strategyPreview || strategyPlace) {
      const completionLabel = strategyPlace ? 'Strategy live cycle' : strategyPreview ? 'Strategy preview cycle' : 'Dry run cycle';
      const completionReason = strategyPlace ? 'Exiting after one guarded strategy-selected live Coinbase order.' : strategyPreview ? 'Exiting after one strategy-selected Coinbase preview.' : 'Exiting after one read-only Coinbase cycle.';
      console.log(`----- ${completionLabel} end: Took ${elapsed}ms. ${completionReason} -----`);
      break;
    }
    console.log(`----- Cycle End: Took ${elapsed}ms. Waiting ${delay}ms... -----`);
    await new Promise((res) => setTimeout(res, delay));

  } // End Main Loop

  console.log(strategyPlace ? "🛑 Strategy live run complete." : strategyPreview ? "🛑 Strategy preview complete." : dryRunOnce ? "🛑 Read-only dry run complete." : "🛑 Main loop exited unexpectedly."); rl.close();
} // End mainLoop Function

// --- Entry Point ---
// Pure live engine: no worker subprocess, no IPC, no shadow dispatch.
// All Legion / dreamer / scientific-optimizer subsystems were removed.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const gracefulShutdown = () => {
    console.log("\n🛑 [Shutdown] Saving final engine state before exit...");
    if (typeof globalSaveEngineState === 'function') {
      globalSaveEngineState();
    } else {
      console.warn("⚠️ Warning: globalSaveEngineState is not initialized yet.");
    }
    process.exit(0);
  };
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  mainLoop()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error("❌ Fatal Error in Main Loop:", err);
      rl.close();
      process.exit(1);
    });
}

export { TradingEngine, CoinbaseWormAPI, defaultGenome };
// v4.0.0: "Hyper-Evolutionary" (Current Version)
// - **MAJOR ARCHITECTURE CHANGE**: Migrated 11 hard-coded constants into evolving genome
// - Added Physics Genes: SPAR_DRAG_COEFFICIENT (0.80-0.999999), PRICE_HISTORY_WINDOW_SIZE (20-2000), ADAPTIVE_VOLATILITY_THRESHOLD (0.001-0.10)
// - Added Time Genes: FORCED_HARVEST_TIMEOUT, REBALANCE_COOLDOWN, FORCE_REBALANCE_TIMEOUT, ADAPTIVE_DZ_INACTIVITY_TIMEOUT (1min-24hrs)
// - Added Risk Genes: MAX_REBALANCE_ATTEMPTS (1-20), CP_TRIGGER_MIN_NEGATIVE_DEV_PERCENT (-50% to -1%)
// - Added Evolution Genes: EVOLUTION_TRADE_THRESHOLD (2 trades min), EVOLUTION_CONSISTENCY_COUNT (3 wins required)
// - Implemented comprehensive mutation bounds checking in _applyMutation to prevent catastrophic parameter drift
// - Removed SPAR_DRAG_COEFFICIENT filter exclusion from mutateGenome - all numeric parameters now evolvable
// - Updated EvolutionManager promotion logic to use genome-based thresholds instead of global constants
// - Added startup "Genome Personality" display showing key evolved parameters
// - Fixed variable name bug in asset specialization mutation (targetAsset -> targetSymbol)
// - Bot now autonomously optimizes its physics (baseline weight, memory), timing (patience), risk tolerance (panic threshold), and promotion criteria
// v3.23.7:
// - Added automatic ETH allocation from harvest proceeds (currentGenome.HARVEST_ALLOC_ETH_PERCENT).
// - Adjusted default allocation percentages: BTC 10%, ETH 10%, Reinvest 70%, Cash 10%.
// - Added ETH auto-buy execution block.
// v3.23.6:
// - Refined Harvest/Rebalance cycle counting logic to only increment/decrement on *strict* deviation changes, ignoring stagnant values (within a small float precision threshold).
// v3.23.5:
// - Prevented Adaptive Dead Zone activation/deactivation from incorrectly resetting existing Harvest/Rebalance cycle counters. Counters are now only reset on trade execution or when the asset leaves the trigger zone.
// v3.23.4:
// - Corrected Adaptive Dead Zone activation/deactivation logic to handle boundary conditions precisely.
//   - Deactivation now occurs if deviation is ON or OUTSIDE the original +/- trigger bounds.
//   - Activation now only occurs if deviation is STRICTLY INSIDE the original +/- trigger bounds AND inactivity timeout is met.
// v3.23.3:
// - Restored detailed console logging for Harvest/Rebalance cycle count increments/decrements based on deviation changes.
// v3.23.2:
// - Added currentGenome.ADAPTIVE_CONFIRMATION_CYCLE_INCREMENT constant.
// - Added currentGenome.ADAPTIVE_SKIP_BASELINE_ADJUST constant.
// - Updated Harvest logic to use currentGenome.ADAPTIVE_CONFIRMATION_CYCLE_INCREMENT for required cycles.
// - Updated Rebalance logic to use currentGenome.ADAPTIVE_CONFIRMATION_CYCLE_INCREMENT for required cycles.
// - Updated Harvest (Standard & Forced) logic to conditionally skip baseline adjustment based on currentGenome.ADAPTIVE_SKIP_BASELINE_ADJUST when adaptive mode is active.
// - Updated Rebalance (Standard & Forced) logic to conditionally skip baseline adjustment based on currentGenome.ADAPTIVE_SKIP_BASELINE_ADJUST when adaptive mode is active.
// - Simplified console display format for active harvest/rebalance/cooldown states.
// v3.23.1:
// - Revised Crash Protection (CP) trigger:
//   - Removed trigger based on overall portfolio average deviation.
//   - CP now activates *only* if a high percentage (`currentGenome.CP_TRIGGER_ASSET_PERCENT`) of *all* assets with baselines simultaneously drop below a minimum negative deviation (`currentGenome.CP_TRIGGER_MIN_NEGATIVE_DEV_PERCENT`).
//   - Added `currentGenome.CP_TRIGGER_ASSET_PERCENT` and `currentGenome.CP_TRIGGER_MIN_NEGATIVE_DEV_PERCENT` constants.
//   - Updated the CP check logic block accordingly.
// v3.23.0:
// - Added Adaptive Dead Zone Mode.
//   - Activates per-asset using +/-2% triggers if inactive (configurable timeout based on last trade) AND within original DZ bounds.
//   - Requires +1 confirmation cycle for adaptive trades & skips baseline adjustments. Deactivates instantly if price moves outside original DZ bounds.
//   - Added related constants, `lastActionTimestamps` (persistent state), `adaptiveDeadZoneState` (transient state).
//   - Updated `loadState`, `saveState`, trade success blocks, harvest/rebalance logic, and state display.
// v3.22.1:
// - Restored original cycle counter logic.
// v3.22.0:
// - Added Harvest Proceeds Allocation system. Adjusted currentGenome.PARTIAL_RECOVERY_PERCENT.
// ... (Previous logs unchanged) ...
// =====================================================
