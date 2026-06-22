// Lifted from robinhood-worm.js — Python array scissor.
// Full shared imports cloned. DCE later.

import dotenv from 'dotenv';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import os from 'os';
import { fileURLToPath } from 'url';
import { fork } from 'child_process';
import {
  minIncrementMap, SLIPPAGE_BUFFERS, HARVEST_EXCLUDE, REBALANCE_EXCLUDE,
  PRECISION_THRESHOLD, SNOWBALL_CONFIG, defaultGenome, getFallbackMinQty,
  LEGION_CONFIG,
} from '../config/constants.mjs';
import { roundQty, checkMinQuantity, setMinOrderQtyMap, getMinOrderQtyMap } from '../utils/quantity.mjs';
import {
  getEffectivePriceFromResp, getFilledQuantityFromResp, getSettledValueFromResp,
  getTotalFeesFromResp, getGrossValueFromResp, parseOptionalNumber, getGenomicParam,
} from '../utils/helpers.mjs';
import { TradeHistoryAnalyzer } from './trade-history-analyzer.mjs';
import { SweepStateManager } from '../legion/sweep-state-manager.mjs';
import { loadRecentMarketData, appendMarketData, pruneMarketDataFile } from '../utils/trade-logger.mjs';
import { TradingEngine } from '../engine/trading-engine.mjs';
const MIN_ORDER_QTY_MAP = new Proxy({}, {
  get(_, k)  { return getMinOrderQtyMap()[k]; },
  ownKeys()  { return Object.keys(getMinOrderQtyMap()); },
  has(_, k)  { return k in getMinOrderQtyMap(); },
  getOwnPropertyDescriptor(_, k) { return Object.getOwnPropertyDescriptor(getMinOrderQtyMap(), k); },
});

export class ScientificOptimizer {
  constructor() {
    this.marketDataFile = path.join(process.cwd(), 'market_data.jsonl');
    this.maxHistoryLines = 450000;
    this.WINDOW_24H = 15000;
    this.historyAnalyzer = new TradeHistoryAnalyzer();

    // Parse Swarm IDs
    this.workerId = 0;
    this.totalWorkers = 1;
    process.argv.forEach(arg => {
      if (arg.startsWith('--workerId=')) this.workerId = parseInt(arg.split('=')[1]);
      else if (arg.startsWith('--totalWorkers=')) this.totalWorkers = parseInt(arg.split('=')[1]);
    });

    this.sweepStateManager = new SweepStateManager(this.workerId, this.totalWorkers);

    // Cache for liveEngineState.json to avoid heavy synchronous disk reads
    this.lastLiveSnapshotLoad = 0;
    this.cachedLiveSnapshot = null;
    this.lastLiveSnapshotMtime = null;

    // 1. GRID SEARCH RANGES (The Matrix)
    // We test every combination of these two against each other
    this.GRID_RANGES = {
      HARVEST: { start: 0.02, end: 0.10, step: 0.005 }, // 2.0% to 10% (Min > 1% Fee)
      REBALANCE: { start: 0.02, end: 0.10, step: 0.005 }  // 2.0% to 10%
    };

    // 2. FINE TUNE RANGES (Sequential)
    // We test these one by one after the best grid pos is found
    this.FINE_TUNE_RANGES = {
      PARTIAL_RECOVERY_PERCENT: { start: 0.30, end: 1.00, step: 0.10 }
    };
  }

  async run() {
    console.log("   [Dreamer] 🧮 Combinatorial Processor Active. Pid:", process.pid);
    this.sweepStateManager.load();

    // --- Persistence for Stats ---
    const counterPath = path.join(process.cwd(), 'dreamerSimCount.json');
    let totalSims = 0;
    if (fs.existsSync(counterPath)) try { totalSims = JSON.parse(fs.readFileSync(counterPath)).totalSimulations; } catch (e) { }

    let batchCounter = 0;
    while (true) {
      batchCounter++;

      // Periodic Status Log (Every ~5s)
      if (batchCounter % 500 === 0 && this.sweepStateManager?.state) {
        const s = this.sweepStateManager.state;
        const assets = this.getSweepAssets(this.cachedHistory);
        const loopAsset = assets[s.currentAssetIndex % assets.length] || "Waiting...";

        // Calculate Depth Mode (Grand Cycle)
        const passNum = Math.floor((s.currentAssetIndex || 0) / (assets.length || 1));
        const depthMode = ['SHORT', 'MEDIUM', 'LONG'][passNum % 3] || 'MEDIUM';

        console.log(`   [Dreamer] 🔄 Cycling: ${loopAsset} [${depthMode}] [${s.mode}] (Sim #${batchCounter})`);
      }

      // Cache Refresh Logic (Throttled from checking file size every 500 loops to purely memory load)
      if (batchCounter % 1500 === 0 || !this.cachedHistory) {
        this.cachedHistory = await this.loadMarketData();
      }

      try {
        const history = this.cachedHistory || [];
        if (history.length > 500) { // Require minimum data
          // Use ALL available history up to the max window (e.g. 7 days / 100k ticks)
          const recentHistory = history.slice(-Math.min(history.length, 150000));

          // === CORE LOGIC: GET NEXT COMBINATION ===
          const candidate = this.getNextCombinatorialCandidate(recentHistory);

          // --- Swarm Initalization (Asset Staggering) ---
          if (candidate && !this.sweepStateManager.state.swarmInit) {
            const assets = this.getSweepAssets(recentHistory);
            if (assets.length > 0) {
              const slice = Math.floor(assets.length / this.totalWorkers);
              const startIdx = slice * this.workerId;
              // Only jump if we are at 0 (Fresh Start), otherwise respect loaded state
              if (this.sweepStateManager.state.currentAssetIndex === 0) {
                this.sweepStateManager.state.currentAssetIndex = startIdx;
                console.log(`   [Dreamer #${this.workerId}] 🐝 Swarm Active. Starting at Asset Index ${startIdx}/${assets.length} (${assets[startIdx] || '?'}).`);
              }
              this.sweepStateManager.state.swarmInit = true;
            }
          }

          if (candidate) {
            // Hybrid Scan Logic
            const assets = this.getSweepAssets(recentHistory);
            const passNum = Math.floor((this.sweepStateManager.state.currentAssetIndex || 0) / (assets.length || 1));
            const depthMode = ['SHORT', 'MEDIUM', 'LONG'][passNum % 3] || 'MEDIUM';

            // Load LIVE snapshot for accurate baseline (throttled to check file mtime at most once every 5 seconds)
            let liveSnapshot = null;
            const nowTime = Date.now();
            if (!this.lastLiveSnapshotLoad || (nowTime - this.lastLiveSnapshotLoad > 5000)) {
              this.lastLiveSnapshotLoad = nowTime;
              try {
                if (fs.existsSync(STATE_FILE_PATH)) {
                  const stats = fs.statSync(STATE_FILE_PATH);
                  if (!this.lastLiveSnapshotMtime || stats.mtimeMs !== this.lastLiveSnapshotMtime || !this.cachedLiveSnapshot) {
                    this.lastLiveSnapshotMtime = stats.mtimeMs;
                    this.cachedLiveSnapshot = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf-8'));

                    const ageMinutes = (nowTime - stats.mtimeMs) / 60000;
                    if (ageMinutes > 10) {
                      console.warn(`⚠️ [Dreamer] Warning: Live State is ${ageMinutes.toFixed(1)}m old. Optimizations may be based on stale data.`);
                    }
                  }
                }
              } catch (e) { }
            }
            liveSnapshot = this.cachedLiveSnapshot;

            const result = await this.evaluateGenome(candidate.genome, recentHistory, liveSnapshot, candidate.focus, depthMode);
            totalSims++;

            // Scoring Logic: Subtractive Risk Penalty (Option A)
            let score = this.calculateFitnessScore(result, candidate.genome);

            // Track best score per asset AND depth mode
            if (liveSnapshot && liveSnapshot.lastBestScore) {
              global.lastBestScore = JSON.parse(JSON.stringify(liveSnapshot.lastBestScore));
            } else if (!global.lastBestScore || typeof global.lastBestScore !== 'object') {
              global.lastBestScore = { SUBTRACTIVE_V2: true };
            }

            // Namespace the score tracking so SHORT doesn't block LONG promotions
            const scoreKey = `${candidate.focus}_${depthMode}`;
            const currentBest = (global.lastBestScore && global.lastBestScore[scoreKey] !== undefined)
              ? global.lastBestScore[scoreKey]
              : -Infinity;

            // Heartbeat / Promotion Logic
            if (process.send) {
              if (score > currentBest) {
                // UNIFIED ARENA BATTLE (Method 1)
                // If it is the incumbent champion run, it passes automatically
                let passesArena = true;
                if (candidate.desc !== "CHAMPION" && candidate.valStr !== "INCUMBENT") {
                  // Fight on the longer of the candidate's timeframe and the incumbent's active timeframe
                  const incumbentTimeframe = (liveSnapshot && liveSnapshot.assetSourceTimeframe && liveSnapshot.assetSourceTimeframe[candidate.focus])
                    ? liveSnapshot.assetSourceTimeframe[candidate.focus]
                    : 'MEDIUM';
                  const timeframePriority = { 'SHORT': 1, 'MEDIUM': 2, 'LONG': 3 };
                  const candidatePriority = timeframePriority[depthMode] || 2;
                  const incumbentPriority = timeframePriority[incumbentTimeframe] || 2;
                  const standardizedTimeframe = candidatePriority >= incumbentPriority ? depthMode : incumbentTimeframe;

                  // 1. Run Candidate on standardized window (Unconstrained)
                  const candidateArenaResult = await this.evaluateGenome(candidate.genome, recentHistory, null, candidate.focus, standardizedTimeframe);
                  const candidateArenaScore = this.calculateFitnessScore(candidateArenaResult, candidate.genome);

                  // 2. Run Incumbent on standardized window (Unconstrained)
                  let incumbentGenome = JSON.parse(JSON.stringify(liveSnapshot && liveSnapshot.genome ? liveSnapshot.genome : defaultGenome));
                  const incumbentArenaResult = await this.evaluateGenome(incumbentGenome, recentHistory, null, candidate.focus, standardizedTimeframe);
                  const incumbentArenaScore = this.calculateFitnessScore(incumbentArenaResult, incumbentGenome);

                  // 3. Compare scores
                  if (candidateArenaScore <= incumbentArenaScore) {
                    passesArena = false;
                    if (process.env.DEBUG_ARENA) {
                      console.log(`   [Unified Arena] ${candidate.focus} candidate (${candidate.desc} [${depthMode}]) rejected: Arena Score ${candidateArenaScore.toFixed(3)}% <= incumbent ${incumbentArenaScore.toFixed(3)}% on ${standardizedTimeframe} timeframe.`);
                    }
                  } else {
                    console.log(`   [Unified Arena] ${candidate.focus} candidate (${candidate.desc} [${depthMode}]) WON: Arena Score ${candidateArenaScore.toFixed(3)}% > incumbent ${incumbentArenaScore.toFixed(3)}% on ${standardizedTimeframe} timeframe! Proposing promotion...`);
                  }
                }

                if (passesArena) {
                  global.lastBestScore[scoreKey] = score;
                  this.saveBrainScan(candidate.focus, result, candidate.genome); // <--- BRAIN SCAN
                  process.send({
                    type: 'OPTIMIZATION_FOUND',
                    genome: candidate.genome,
                    score: score,
                    focus: candidate.focus,
                    symbol: candidate.focus,
                    param: `${candidate.desc} [${depthMode}]`, // Tag the description
                    val: candidate.valStr
                  });

                  // Pause to allow main process to save the new genome to disk.
                  // Prevents spamming promotions against an outdated incumbent.
                  await new Promise(r => setTimeout(r, 1000));
                }
              }
              process.send({
                type: 'HEARTBEAT',
                batch: batchCounter,
                bestScore: score,
                focus: `[${candidate.mode}] ${candidate.focus} ${candidate.desc}`
              });
            }
          }

          // Save progress (Massively throttled to prevent HDD lockups during worker sweeps)
          if (totalSims % 5000 === 0) {
            try {
              fs.writeFileSync(counterPath, JSON.stringify({ totalSimulations: totalSims }));
            } catch (e) { }
          }
        }
      } catch (err) {
        console.error("   [Dreamer] Critical Error:", err);
        await new Promise(r => setTimeout(r, 5000));
      } finally {
        await new Promise(r => setTimeout(r, 10)); // Ultra-fast yield for grid search
      }
    }
  }

  getNextCombinatorialCandidate(history) {
    const assets = this.getSweepAssets(history);
    if (assets.length === 0) return null;

    let st = this.sweepStateManager.state;
    st.combinationsChecked = (st.combinationsChecked || 0) + 1;
    const asset = assets[st.currentAssetIndex % assets.length];

    // Debug Cycle
    // console.log(`[Dreamer] Debug Cycle: ${asset} [${st.mode}] (Index ${st.currentAssetIndex} of ${assets.length})`);

    // Load Baseline Genome
    let base = defaultGenome;
    try {
      const f = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf-8'));
      if (f.genome) base = f.genome;
    } catch (e) { }

    const candidateGenome = JSON.parse(JSON.stringify(base));
    if (!candidateGenome.overrides) candidateGenome.overrides = {};
    if (!candidateGenome.overrides[asset]) candidateGenome.overrides[asset] = {};

    let result = { genome: candidateGenome, focus: asset, mode: st.mode };

    // === CHAMPION CHECK (New Feature) ===
    // Before starting a new GRID sweep, verify the CURRENT settings first.
    // This sets the "High Score" bar to beat. If the grid can't beat the current settings, nothing changes.
    if (st.mode === 'GRID' && st.hIndex === 0 && st.rIndex === 0 && (!st.championChecked)) {
      // We return the genome AS IS (with its current overrides for this asset).
      // This counts as the "Champion" run.
      st.championChecked = true;
      // Populate description so logs aren't "undefined"
      result.desc = "CHAMPION";
      result.valStr = "INCUMBENT";
      return result;
    }

    // === MODE 1: GRID SEARCH (Harvest x Rebalance) ===
    if (st.mode === 'GRID') {
      const hStart = this.GRID_RANGES.HARVEST.start;
      const hStep = this.GRID_RANGES.HARVEST.step;
      const rStart = this.GRID_RANGES.REBALANCE.start;
      const rStep = this.GRID_RANGES.REBALANCE.step;

      const hVal = hStart + (st.hIndex * hStep);
      const rVal = rStart + (st.rIndex * rStep);

      // SAFETY: Cap rebalance trigger at 15% (same as micro-grid)
      const MAX_REBALANCE_TRIGGER = 0.15;
      const constrainedRVal = Math.min(rVal, MAX_REBALANCE_TRIGGER);

      // Apply BOTH parameters
      candidateGenome.overrides[asset].FLAT_HARVEST_TRIGGER_PERCENT = parseFloat(hVal.toFixed(4));
      candidateGenome.overrides[asset].FLAT_REBALANCE_TRIGGER_PERCENT = parseFloat(constrainedRVal.toFixed(4));

      result.desc = `H:${(hVal * 100).toFixed(2)}% / R:${(constrainedRVal * 100).toFixed(2)}%`;
      result.valStr = "COMBINED";

      // Advance Counters
      if (rVal >= this.GRID_RANGES.REBALANCE.end) {
        st.rIndex = 0;
        st.hIndex++;
        if (hVal >= this.GRID_RANGES.HARVEST.end) {
          // Grid Complete -> Switch to MICRO_GRID (High Precision)
          st.hIndex = 0;
          st.rIndex = 0;
          st.mode = 'MICRO_GRID';

          // Load current winner to set anchors
          let currentH = 0.035;
          let currentR = 0.035;
          try {
            const f = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf-8'));
            if (f.genome && f.genome.overrides && f.genome.overrides[asset]) {
              currentH = f.genome.overrides[asset].FLAT_HARVEST_TRIGGER_PERCENT || 0.035;
              currentR = f.genome.overrides[asset].FLAT_REBALANCE_TRIGGER_PERCENT || 0.035;
            }
          } catch (e) { }

          st.anchorH = currentH;
          st.anchorR = currentR;
          console.log(`   [Dreamer] 🔬 ${asset} Grid Complete. Switching to Micro-Verification (Anchor H:${(st.anchorH * 100).toFixed(2)}% / R:${(st.anchorR * 100).toFixed(2)}%).`);
        }
      } else {
        st.rIndex++;
      }
    }

    // === MODE 3: MICRO-GRID (Verification) ===
    // === MODE 3: MICRO-GRID (Crosshair Verification) ===
    else if (st.mode === 'MICRO_GRID') {
      // Anchor values from the trade or Grid winner
      const anchorH = st.anchorH || 0.035;
      const anchorR = st.anchorR || 0.035;
      const range = 0.005; // +/- 0.5% Window (Tight Sniping)
      const step = 0.0001; // 0.01% Precision (High Fidelity)

      // Initialize Micro-State
      if (!st.microPhase) st.microPhase = 'SWEEP_H';
      if (st.mIndex === undefined) st.mIndex = 0;

      let hVal, rVal;
      const steps = Math.floor((range * 2) / step); // Total steps in one direction (approx 300)

      if (st.microPhase === 'SWEEP_H') {
        // Phase 1: Hold R constant (Anchor), Sweep H
        const start = Math.max(0.01, anchorH - range);
        hVal = start + (st.mIndex * step);
        rVal = anchorR;

        candidateGenome.overrides[asset].FLAT_HARVEST_TRIGGER_PERCENT = parseFloat(hVal.toFixed(4));
        candidateGenome.overrides[asset].FLAT_REBALANCE_TRIGGER_PERCENT = parseFloat(rVal.toFixed(4));
        result.desc = `µH:${(hVal * 100).toFixed(2)}% (R Fixed)`;
        result.valStr = "MICRO_H";

        st.mIndex++;
        if (st.mIndex > steps) {
          st.microPhase = 'SWEEP_R';
          st.mIndex = 0; // Reset for next phase
        }
      }
      else if (st.microPhase === 'SWEEP_R') {
        // Phase 2: Hold H constant (Anchor), Sweep R
        const start = Math.max(0.01, anchorR - range);
        hVal = anchorH;
        rVal = start + (st.mIndex * step);

        // SAFETY: Cap rebalance trigger at 15% to prevent extreme values
        // Without this, the optimizer can find local maxima at extreme triggers (e.g. 30%)
        // which are mathematically "better" in backtests but risky in real trading
        const MAX_REBALANCE_TRIGGER = 0.15; // 15% maximum
        rVal = Math.min(rVal, MAX_REBALANCE_TRIGGER);

        candidateGenome.overrides[asset].FLAT_HARVEST_TRIGGER_PERCENT = parseFloat(hVal.toFixed(4));
        candidateGenome.overrides[asset].FLAT_REBALANCE_TRIGGER_PERCENT = parseFloat(rVal.toFixed(4));
        result.desc = `µR:${(rVal * 100).toFixed(2)}% (H Fixed)`;
        result.valStr = "MICRO_R";

        st.mIndex++;
        if (st.mIndex > steps) {
          // Micro Grid Complete -> Go to Fine Tune
          st.microPhase = null;
          st.mIndex = 0;
          st.mode = 'FINE_TUNE';
          st.paramIndex = 0;
          st.val = null;
          console.log(`   [Dreamer] ✅ ${asset} Micro-Verification Complete.`);
        }
      }
    }


    else {
      // ... existing FINE_TUNE logic ...
      const keys = Object.keys(this.FINE_TUNE_RANGES);
      if (st.paramIndex < 0 || st.paramIndex >= keys.length) {
        console.warn(`   [Dreamer] ⚠️ Corrupted Param Index (${st.paramIndex}). Resetting to 0.`);
        st.paramIndex = 0;
      }

      const key = keys[st.paramIndex % keys.length];
      const range = this.FINE_TUNE_RANGES[key];

      if (!range) {
        console.error(`   [Dreamer] 🛑 CRITICAL: Range undefined for key '${key}'. Resetting system.`);
        st.paramIndex = 0;
        st.mode = 'GRID'; // Fallback to Grid
        return null;
      }

      let val = st.val;
      if (val === null) val = range.start;
      else val += range.step;

      candidateGenome.overrides[asset][key] = parseFloat(val.toFixed(4));
      result.desc = key;
      result.valStr = val.toFixed(2);
      result.param = key; // For compatibility
      result.value = val;

      // Advance Counters
      st.val = val;
      if (val >= range.end - 0.0001) {
        st.val = null;
        st.paramIndex++;
        if (st.paramIndex >= keys.length) {
          // Asset Complete -> Next Asset -> Back to Grid
          st.paramIndex = 0;
          st.currentAssetIndex++;
          st.mode = 'GRID';
          const sScore = global.lastBestScore?.[`${asset}_SHORT`] || 0;
          const mScore = global.lastBestScore?.[`${asset}_MEDIUM`] || 0;
          const lScore = global.lastBestScore?.[`${asset}_LONG`] || 0;
          console.log(`   [Dreamer] ✅ ${asset} FULLY OPTIMIZED. Scanned ${st.combinationsChecked} strategies. Best Alpha (S/M/L): ${sScore.toFixed(3)}% / ${mScore.toFixed(3)}% / ${lScore.toFixed(3)}%`);
          st.combinationsChecked = 0;

          // SOFT RESET SCORE for next cycle (Fixes "Dreamer Amnesia")
          // Instead of deleting (reset to 0), we decay the score.
          // This forces the next candidate to be at least 75% as good as the old champion,
          // preventing immediate downgrades to mediocre strategies while still allowing adaptation.
          if (global.lastBestScore) {
            const keys = [`${asset}_SHORT`, `${asset}_MEDIUM`, `${asset}_LONG`];
            keys.forEach(k => {
              if (global.lastBestScore[k] !== undefined) {
                global.lastBestScore[k] = global.lastBestScore[k] > 0
                  ? global.lastBestScore[k] * 0.75
                  : global.lastBestScore[k] * 1.25;
              }
            });

            // Notify main process to decay its thresholds too (Soft Reset)
            if (process.send) {
              process.send({
                type: 'RESET_SCORE',
                asset: asset,
                mode: 'SOFT' // New mode for main process to handle if needed, or just standard reset
              });
            }


          }

          // RESET CHAMPION CHECK
          st.championChecked = false;
        }
      }
    }


    // Throttle state saving to disk to prevent locking. (Saves roughly every 100 combination checks instead of every 1)
    if (this.sweepStateManager.state.combinationsChecked % 100 === 0) {
      this.sweepStateManager.save();
    }
    return result;
  }

  getSweepAssets(history) {
    if (!history || history.length === 0) return [];
    const allAssets = Object.keys(history[history.length - 1].p).sort().filter(s => !HARVEST_EXCLUDE.includes(s));
    // 🧱 SHARDING: Distribute work among workers
    return allAssets.filter((_, i) => i % this.totalWorkers === this.workerId);
  }

  async loadMarketData() {
    // Highly optimized backward-chunk reading for HDD/performance comfort
    return loadRecentMarketData(150000);
  }

  async pruneData(history) {
    if (history.length <= this.maxHistoryLines) return;
    const kept = history.slice(history.length - this.maxHistoryLines);
    const lines = kept.map(x => JSON.stringify(x)).join('\n');
    fs.writeFileSync(this.marketDataFile, lines + '\n');
  }


  handleFeedback(msg) {
    // "Micro-Tune" Injection:
    // A Shadow Scout has found a winning value (e.g. 7.52%) that beats our Grid (7.50%).
    // We accept this victory and update our best score.
    if (!global.lastBestScore) global.lastBestScore = {};
    const scoreKey = `${msg.focus}_SHADOW`;
    const currentBest = global.lastBestScore[scoreKey] || 0.0;

    if (msg.score > currentBest) {
      global.lastBestScore[scoreKey] = msg.score;

      // Re-broadcast to Main so it can be promoted to Live Engine & Saved
      // (Only Main can write to the actual liveEngineState.json)
      if (process.send) {
        process.send({
          type: 'OPTIMIZATION_FOUND',
          genome: msg.genome,
          score: msg.score,
          focus: msg.focus,
          symbol: msg.focus,
          param: "FINE_TUNE_FEEDBACK",
          val: "ADAPTIVE"
        });
      }
      // console.log(`   [Dreamer] 🧠 Absorbed Micro-Tune Feedback for ${msg.focus}: Score ${msg.score.toFixed(2)}%`);
    }
  }

  prioritize(symbol, baseGenome) {
    // "Verify & Fine-Tune" Logic:
    // 1. Accept the exact parameters that just executed the trade (baseGenome).
    // 2. Skip the coarse Grid Search.
    // 3. Jump straight to FINE_TUNE mode centered on these parameters.
    try {
      const overrides = baseGenome.overrides?.[symbol];
      if (overrides) {
        // Determine starting indices for Fine Tuning based on current values
        // This allows us to "sweep around" the current value
        // For now, we simply reset the state but inject the values into the candidate generation logic
        // via a temporary "focus" or by explicitly setting the mode.

        // CRITICAL: We need to ensure the next 'getNextCombinatorialCandidate' picks this up.
        // We'll reset the state for this asset to FINE_TUNE start.
        this.sweepStateManager.state.currentAssetIndex = this.getSweepAssets(this.cachedHistory).indexOf(symbol);
        if (this.sweepStateManager.state.currentAssetIndex === -1) this.sweepStateManager.state.currentAssetIndex = 0;

        this.sweepStateManager.state.mode = 'MICRO_GRID';
        this.sweepStateManager.state.microPhase = 'SWEEP_H';
        this.sweepStateManager.state.mIndex = 0;

        // Set Anchors based on the trade execution parameters
        this.sweepStateManager.state.anchorH = overrides.FLAT_HARVEST_TRIGGER_PERCENT || 0.035;
        this.sweepStateManager.state.anchorR = overrides.FLAT_REBALANCE_TRIGGER_PERCENT || 0.035;

        // Reset val/paramIndex just in case
        this.sweepStateManager.state.val = null;
        this.sweepStateManager.state.paramIndex = 0;

        // We also need to SAVE this specific baseGenome as the "Anchor" for this run.
        // We'll write it to a temporary "priority_anchor.json" or similar that getNext... reads?
        // Or simpler: Just rely on liveEngineState.json which Main updates immediately?
        // Main calls saveEngineState() right before sending this request if a trade happened (stateChanged=true).

        // console.log(`   [Dreamer] ⚡ PRIORITIZING ${symbol}: Verification & Fine-Tuning Sequence Initiated.`);
        this.sweepStateManager.save();
      }
    } catch (err) { console.error("Error in prioritize:", err); }
  }

  // --- BRAIN SCAN DIAGNOSTIC ---
  // --- BRAIN SCAN DIAGNOSTIC ---
  saveBrainScan(asset, result, genome) {
    const scanFile = path.join(process.cwd(), 'dreamer_brain_scan.json');

    // Calculate Fee Impact for verification
    // Result.totalValue is net of fees.
    const feesPaidEst = result.totalTrades * (10000 * 0.01); // Approx $100 per trade on $10k base (rough estimate)

    const scanData = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toISOString(),
      asset: asset,
      logic_verification: {
        msg: "TRUST BUT VERIFY",
        method: "Scientific Combinatorial Sweep",
        fee_model: "1.0% per Trade (Real-time deduction)",
        min_threshold_enforced: "2.0%"
      },
      winner: {
        config: {
          Harvest: genome.overrides?.[asset]?.FLAT_HARVEST_TRIGGER_PERCENT || "N/A",
          Rebalance: genome.overrides?.[asset]?.FLAT_REBALANCE_TRIGGER_PERCENT || "N/A"
        },
        performance: {
          alpha: `${result.relativeROI.toFixed(4)}%`,
          roi: `${result.roi.toFixed(4)}%`,
          market_roi: `${result.marketROI.toFixed(4)}%`,
          trades: result.totalTrades,
          final_value: `$${result.totalValue.toFixed(2)}`
        },
        sanity_check: {
          did_it_beat_holding: result.relativeROI > 0 || (result.totalTrades > 0 && result.relativeROI >= 0),
          is_net_profitable: result.roi > 0
        }
      }
    };

    try {
      let history = [];
      if (fs.existsSync(scanFile)) {
        try {
          const content = JSON.parse(fs.readFileSync(scanFile, 'utf8'));
          if (Array.isArray(content)) history = content;
          else if (typeof content === 'object') history = [content]; // Migrate legacy single-object
        } catch (e) { }
      }

      // Prepend new scan (Newest First)
      history.unshift(scanData);

      // Keep last 50 entries to prevent bloat
      if (history.length > 50) history = history.slice(0, 50);

      fs.writeFileSync(scanFile, JSON.stringify(history, null, 2));
    } catch (err) { console.error("Error saving brain scan:", err); }
  }

  calculateFitnessScore(result, genome) {
    if (!result || result.totalValue === undefined || result.totalValue <= -1 || result.relativeROI === undefined || isNaN(result.relativeROI)) return -Infinity;
    const clampedDrawdown = Math.min(1.0, Math.max(0.0, result.drawdown || 0.0));
    const drawdownPercent = clampedDrawdown * 100;
    const penalty = drawdownPercent * (genome.FITNESS_DRAWDOWN_PENALTY || 1.0);

    // Add a tiny micro-bonus (0.05% per trade) to encourage action without overcoming real losses.
    // This correctly scores '0 trades' on its mathematical merit rather than punishing it with -Infinity.
    const actionBonus = (result.totalTrades || 0) * 0.05;

    return result.relativeROI - penalty + actionBonus;
  }

  async evaluateGenome(genome, history, snapshot, focusAsset, depthMode = 'MEDIUM') {
    // [Logic: Hybrid Time Windows]
    // SHORT: 24h (15k) - Fast, Responsive
    // MEDIUM: 3d (45k) - Balanced, Robust (Default)
    // LONG: 14 Days (Stress Test)

    let historySlice;
    if (depthMode === 'SHORT') historySlice = history.slice(-15000);
    else if (depthMode === 'MEDIUM') historySlice = history.slice(-45000);
    else historySlice = history.slice(-150000);

    // Safety: Ensure we have data
    if (!historySlice.length) return { roi: 0, totalTrades: 0 };
    const simStartPrice = historySlice[0].p[focusAsset];
    if (!simStartPrice) return { roi: 0, totalTrades: 0 };

    let startCapital = 10000;
    let initialHoldings = {};
    let engine;
    let initialCash = 0;

    // --- LAST KNOWN PRICE CACHE ---
    const lastKnownPrices = {};

    // 1. Seed with snapshot's lastCyclePrices if available
    if (snapshot && snapshot.lastCyclePrices) {
      Object.entries(snapshot.lastCyclePrices).forEach(([sym, p]) => {
        if (p > 0) lastKnownPrices[sym] = p;
      });
    }

    // 2. Seed with first tick's prices
    if (historySlice[0] && historySlice[0].p) {
      Object.entries(historySlice[0].p).forEach(([sym, p]) => {
        if (p > 0) lastKnownPrices[sym] = p;
      });
    }

    // 3. Guarantee focus asset price is seeded
    lastKnownPrices[focusAsset] = simStartPrice;

    // --- REALITY INJECTION ---
    // Use actual portfolio state if available to train on "Getting out of the hole"
    if (snapshot && snapshot.holdings && snapshot.holdings[focusAsset]) {
      const h = snapshot.holdings[focusAsset];
      let realQty = 0;
      if (typeof h === 'object' && h.rawQuantity !== undefined) realQty = h.rawQuantity;
      else if (typeof h === 'number') realQty = h;

      if (realQty > 0) {
        // 1. Set Holdings to Real Quantity
        initialHoldings = { [focusAsset]: { rawQuantity: realQty } };

        // 2. Set Cash proportional to this asset's share of the portfolio
        // (Estimating: If this asset is 10% of portfolio, give it 10% of available cash)
        // Simplified: Just give it a pro-rated chunk of the $211 cash you have.
        // Assuming ~20 assets, share is ~1/20th.
        const totalAssets = Object.keys(snapshot.holdings).length || 1;
        startCapital = (snapshot.cashBalance || 0) / totalAssets;
        initialCash = startCapital;

        engine = new TradingEngine(genome, 'SHADOW', startCapital, initialHoldings);

        // 3. CRITICAL: Reconstruct the "Pain" (Baseline Deviation)
        // We calculate what the baseline SHOULD be in the simulation to match the
        // real-world deviation % at the start of the simulation period.
        const livePrice = snapshot.lastCyclePrices?.[focusAsset] || simStartPrice;
        const liveBaseline = snapshot.baselines?.[focusAsset] || (realQty * livePrice);

        // Ratio: How far off is the baseline from the price? (e.g., 1.05 = Baseline is 5% above price)
        const deviationsRatio = liveBaseline > 0 ? (liveBaseline / (realQty * livePrice)) : 1.0;

        // Apply this ratio to the simulation start price
        // If real portfolio is down 5%, simulation starts "down 5%" relative to tick 0.
        engine.baselines[focusAsset] = (realQty * simStartPrice) * deviationsRatio;
      } else {
        // We don't hold it, simulate fresh start
        const startQty = startCapital / simStartPrice;
        initialHoldings = { [focusAsset]: { rawQuantity: startQty } };
        initialCash = 0;
        engine = new TradingEngine(genome, 'SHADOW', 0, initialHoldings);
        engine.baselines[focusAsset] = startCapital;
      }
    } else {
      // Fallback: Generic 50/50 Split ($5k cash, $5k focusAsset) to allow bidirectional trading
      const halfCapital = startCapital / 2;
      const startQty = halfCapital / simStartPrice;
      initialHoldings = { [focusAsset]: { rawQuantity: startQty } };
      initialCash = halfCapital;
      engine = new TradingEngine(genome, 'SHADOW', halfCapital, initialHoldings);
      engine.baselines[focusAsset] = halfCapital;
    }

    const dummyApi = { placeBuy: async () => { return { id: 1 } }, placeSell: async () => { return { id: 1 } } };

    // Run Simulation
    for (const tick of historySlice) {
      // Update last known prices from this tick
      if (tick.p) {
        Object.entries(tick.p).forEach(([sym, price]) => {
          if (price > 0) lastKnownPrices[sym] = price;
        });
      }

      const port = [];
      Object.entries(engine.holdings).forEach(([sym, h]) => {
        let qty = 0;
        if (typeof h === 'object' && h.rawQuantity !== undefined) qty = h.rawQuantity;
        else if (typeof h === 'number') qty = h;

        if (qty > 0) {
          const price = sym === 'USDC' ? 1.00 : (tick.p[sym] || lastKnownPrices[sym] || 0);
          if (price > 0) {
            port.push({
              Symbol: sym,
              Price: price,
              Value: qty * price,
              Baseline: engine.baselines[sym] || 0
            });
          }
        }
      });

      // Guarantee focusAsset is always represented so baseline adapts even if quantity is 0
      if (!port.some(r => r.Symbol === focusAsset)) {
        const price = tick.p[focusAsset] || lastKnownPrices[focusAsset] || 0;
        if (price > 0) {
          port.push({
            Symbol: focusAsset,
            Price: price,
            Value: 0,
            Baseline: engine.baselines[focusAsset] || 0
          });
        }
      }

      await engine.update(port, dummyApi, engine.cashBalance, engine.holdings, tick.t, tick.p);
    }

    const finalTick = historySlice[historySlice.length - 1];

    // Update last known prices from final tick
    if (finalTick && finalTick.p) {
      Object.entries(finalTick.p).forEach(([sym, price]) => {
        if (price > 0) lastKnownPrices[sym] = price;
      });
    }

    const finalPrice = lastKnownPrices[focusAsset];
    let finalHoldingsVal = 0;
    Object.entries(engine.holdings).forEach(([sym, h]) => {
      let qty = 0;
      if (typeof h === 'object' && h.rawQuantity !== undefined) qty = h.rawQuantity;
      else if (typeof h === 'number') qty = h;

      const price = sym === 'USDC' ? 1.00 : (finalTick.p[sym] || lastKnownPrices[sym] || 0);
      finalHoldingsVal += qty * price;
    });
    const finalVal = engine.cashBalance + finalHoldingsVal;

    // ROI Calculation based on Total Equity (Cash + Asset)
    const initialTotalEquity = initialCash + ((initialHoldings[focusAsset]?.rawQuantity || 0) * simStartPrice);
    const roi = ((finalVal - initialTotalEquity) / initialTotalEquity) * 100;

    const marketROI = ((finalPrice - simStartPrice) / simStartPrice) * 100;
    const relativeROI = roi - marketROI;

    return { roi, relativeROI, marketROI, drawdown: engine.maxDrawdownPercent, totalTrades: engine.totalTrades, totalValue: finalVal };
  }
}
