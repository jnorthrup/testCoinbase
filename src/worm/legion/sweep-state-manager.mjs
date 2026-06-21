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

export class SweepStateManager {
  constructor(workerId = 0, totalWorkers = 1) {
    this.workerId = workerId;
    this.totalWorkers = totalWorkers;
    this.stateFile = path.join(process.cwd(), 'configs', `sweep_state_${workerId}.json`);
    this.state = {
      currentAssetIndex: 0,
      combinationsChecked: 0,
      mode: 'GRID', // 'GRID' (Harvest+Rebal) or 'FINE_TUNE' (Cycles, Recovery)
      hIndex: 0, // Harvest Index
      rIndex: 0, // Rebalance Index
      paramIndex: 0, // For fine-tuning
      val: null,
      swarmInit: false
    };
  }

  load() {
    if (fs.existsSync(this.stateFile)) {
      try {
        this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
        console.log("   [Dreamer] 🧠 Memory Loaded: Continuing previous sweep...");
      } catch (e) { }
    }
  }

  save() {
    try {
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
    } catch (e) { }
  }
}
