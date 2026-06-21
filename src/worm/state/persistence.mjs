// src/worm/state/persistence.mjs
// Engine state persistence with atomic writes

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE_PATH = path.join(__dirname, '../../../liveEngineState.json');

export function saveEngineState(liveEngine) {
  try {
    if (!liveEngine) return;
    const stateToSave = liveEngine.getStateSnapshot();
    const tempFilePath = STATE_FILE_PATH + '.tmp';
    fs.writeFileSync(tempFilePath, JSON.stringify(stateToSave, null, 2));

    try {
      fs.renameSync(tempFilePath, STATE_FILE_PATH);
    } catch (renameErr) {
      if (renameErr.code === 'EPERM' || renameErr.code === 'EBUSY') {
        try {
          fs.copyFileSync(tempFilePath, STATE_FILE_PATH);
          fs.unlinkSync(tempFilePath);
        } catch (copyErr) {
          console.error('🚨 RETRY SAVE FAILED:', copyErr.message);
        }
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    console.error('🚨 CRITICAL ERROR: Failed to save state:', err.message);
  }
}

export function loadEngineState() {
  try {
    if (!fs.existsSync(STATE_FILE_PATH)) {
      return { loadedBaselines: {}, loadedTrailingState: {}, loadedLastActionTimestamps: {}, loadedGenome: null, loadedData: null, loadedAssetSourceTimeframe: null };
    }
    const raw = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf-8'));
    return {
      loadedBaselines: raw.baselines || {},
      loadedTrailingState: raw.trailingState || {},
      loadedLastActionTimestamps: raw.lastActionTimestamps || {},
      loadedGenome: raw.genome || null,
      loadedData: raw,
      loadedAssetSourceTimeframe: raw.assetSourceTimeframe || null,
    };
  } catch (err) {
    console.error('❌ Failed to load state:', err.message);
    return { loadedBaselines: {}, loadedTrailingState: {}, loadedLastActionTimestamps: {}, loadedGenome: null, loadedData: null, loadedAssetSourceTimeframe: null };
  }
}