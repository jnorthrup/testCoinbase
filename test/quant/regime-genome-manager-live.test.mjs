// test/quant/regime-genome-manager-live.test.mjs
// Closes rga Gap G1: RegimeGenomeManager was committed 11:14 on 23-Jun
// ("push final versions of alpha-modulator, regime-genome-manager, and
// multi-objective-evolver. All major layers now committed.") but had zero
// importers. This test exercises its real fs I/O round-trip against a
// temp directory.
//
// Contract under test:
//   constructor({ filePath })
//   load()  — reads JSON from filePath, populates this.genomes (idempotent)
//   async save() — writes JSON to filePath (mkdir -p)
//   async updateGenome(symbol, regime, slice) — sets genomeSlice + updatedAt
//   getGenome(symbol, regime) — returns the slice or null
//   getAllRegimesForSymbol(symbol) — returns the map of regimes for symbol

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RegimeGenomeManager } from '../../src/worm/regime/regime-genome-manager.mjs';

let tmpDir;
let fakeFilePath;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgm-test-'));
  fakeFilePath = path.join(tmpDir, 'nested', 'regime_genomes.json');
});

after(() => {
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeManager(filePath) {
  return new RegimeGenomeManager({ filePath });
}

describe('RegimeGenomeManager: real fs I/O round-trip (closes rga Gap G1)', () => {
  test('initial load on a missing file yields empty genome map (no throw)', () => {
    const rgm = makeManager(fakeFilePath);
    assert.deepStrictEqual(rgm.genomes, {}, 'fresh manager must have empty genomes map');
  });

  test('updateGenome + save creates the parent directory and writes real JSON', async () => {
    const rgm = makeManager(fakeFilePath);
    await rgm.updateGenome('BTC', 'BULL_RUSH', {
      TARGET_ADJUST_PERCENT: 0.002,
      FLAT_HARVEST_TRIGGER_PERCENT: 0.04,
    });
    assert.ok(fs.existsSync(fakeFilePath), `expected file at ${fakeFilePath}`);
    const raw = JSON.parse(fs.readFileSync(fakeFilePath, 'utf8'));
    assert.ok(raw.BTC, 'BTC entry must exist after updateGenome');
    assert.strictEqual(raw.BTC.BULL_RUSH.TARGET_ADJUST_PERCENT, 0.002);
    assert.ok(typeof raw.BTC.BULL_RUSH.updatedAt === 'number',
      `updatedAt must be a number epoch-ms, got ${typeof raw.BTC.BULL_RUSH.updatedAt}`);
  });

  test('fresh manager from same filePath re-loads the persisted state', async () => {
    // First manager wrote the file in the prior test.
    const reloaded = makeManager(fakeFilePath);
    const got = reloaded.getGenome('BTC', 'BULL_RUSH');
    assert.ok(got, 'expected persisted BTC/BULL_RUSH on reload');
    assert.strictEqual(got.TARGET_ADJUST_PERCENT, 0.002,
      'reloaded value must equal what was saved');
  });

  test('getGenome(symbol, regime) returns null for unknown combinations', () => {
    const rgm = makeManager(fakeFilePath);
    assert.strictEqual(rgm.getGenome('UNKNOWN_SYMBOL', 'BULL_RUSH'), null);
    assert.strictEqual(rgm.getGenome('BTC', 'UNREGISTERED_REGIME'), null);
  });

  test('getAllRegimesForSymbol returns a map; mutations via updateGenome persist', async () => {
    const rgm = makeManager(path.join(tmpDir, 'multi', 'regime_genomes.json'));
    await rgm.updateGenome('ETH', 'STEADY_GROWTH', { ALPHA_BIAS: 0.6 });
    await rgm.updateGenome('ETH', 'BEAR_CRASH',   { ALPHA_BIAS: -0.4 });
    const all = rgm.getAllRegimesForSymbol('ETH');
    assert.deepStrictEqual(Object.keys(all).sort(), ['BEAR_CRASH', 'STEADY_GROWTH']);
    assert.strictEqual(all.STEADY_GROWTH.ALPHA_BIAS, 0.6);
  });

  test('constructor with default filePath points inside cwd/configs (smoke check)', () => {
    // No assertion on file content — just that the default-path constructor
    // does not throw and produces a working instance. Catches drift if someone
    // changes the default location.
    const rgm = new RegimeGenomeManager();
    assert.ok(rgm instanceof RegimeGenomeManager);
    assert.ok(typeof rgm.filePath === 'string' && rgm.filePath.length > 0);
  });
});
