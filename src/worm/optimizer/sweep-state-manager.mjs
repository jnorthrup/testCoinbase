import fs from 'fs';
import path from 'path';

class SweepStateManager {
  constructor(workerId = 0, totalWorkers = 1) {
    this.workerId = workerId;
    this.totalWorkers = totalWorkers;
    this.stateFile = path.join(process.cwd(), 'configs', `sweep_state_${workerId}.json`);
    this.state = {
      currentAssetIndex: 0,
      combinationsChecked: 0,
      mode: 'GRID',
      hIndex: 0,
      rIndex: 0,
      paramIndex: 0,
      val: null,
      swarmInit: false,
    };
  }

  load() {
    if (!fs.existsSync(this.stateFile)) return;
    try {
      this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
      console.log('   [Dreamer] 🧠 Memory Loaded: Continuing previous sweep...');
    } catch {}
  }

  save() {
    try {
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
    } catch {}
  }
}

export { SweepStateManager };
