// test/quant/regime-canonical.test.mjs
// After the simplification pass, regime state is exposed through exactly one
// canonical channel: `engine.regimeState[sym].phase` (hysteresis-gated output
// of the createRegimeDetector). The legacy per-cycle raw classifier field
// `engine.volatilityRegime` MUST NOT exist anymore; this test pins that absence
// so a future addition of a parallel regime field is detected.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TradingEngine } from '../../src/worm/engine/trading-engine.mjs';
import { defaultGenome } from '../../src/worm/config/trading-config.mjs';

function makeEngine() {
  // sim mode; no api needed for regime-canonical checks (we drive
  // _detectPhaseTransition directly).
  return new TradingEngine(defaultGenome, 'sim', 10_000, {});
}

describe('regime canonical channel', () => {
  test('engine has regimeState field initialised as an empty object', () => {
    const e = makeEngine();
    assert.ok(e.regimeState, 'regimeState must exist on engine');
    assert.equal(typeof e.regimeState, 'object');
    assert.equal(Object.keys(e.regimeState).length, 0,
      'fresh engine starts with no per-symbol regime state');
  });

  test('engine does NOT expose a volatilityRegime field', () => {
    const e = makeEngine();
    assert.equal(e.volatilityRegime, undefined,
      'volatilityRegime must not exist on the engine; the canonical regime channel is regimeState[sym].phase');
  });

  test('_detectPhaseTransition populates engine.regimeState[sym] with .phase field', () => {
    const e = makeEngine();
    // First observation establishes initial phase.
    e._detectPhaseTransition('BTC', 'STABLE', 1_700_000_000_000);
    assert.ok(e.regimeState.BTC);
    assert.equal(typeof e.regimeState.BTC.phase, 'string');
    assert.ok(['STABLE', 'EXPANDING', 'COMPRESSING'].includes(e.regimeState.BTC.phase));
  });

  test('phase-transition hysteresis holds: 1 EXPANDING observation against STABLE does not transition', () => {
    const e = makeEngine();
    const t0 = 1_700_000_000_000;
    e._detectPhaseTransition('BTC', 'STABLE', t0);
    const initialPhase = e.regimeState.BTC.phase;
    // Single EXPANDING observation cannot transition (confirmK=4).
    e._detectPhaseTransition('BTC', 'EXPANDING', t0 + 60_000);
    assert.equal(e.regimeState.BTC.phase, initialPhase,
      'phase must remain STABLE after a single EXPANDING observation');
  });

  test('sustained EXPANDING observations trigger exactly one transition', () => {
    const e = makeEngine();
    const t0 = 1_700_000_000_000;
    // Establish STABLE residency beyond minResidencyMs (30s default).
    for (let i = 0; i < 3; i++) {
      e._detectPhaseTransition('BTC', 'STABLE', t0 + i * 60_000);
    }
    const stablePhase = e.regimeState.BTC.phase;
    // Push sustained EXPANDING. With confirmK=4 + residency satisfied, one transition.
    let transitions = 0;
    for (let i = 0; i < 10; i++) {
      const r = e._detectPhaseTransition('BTC', 'EXPANDING', t0 + 5 * 60_000 + i * 60_000);
      if (r.transitioned) transitions++;
    }
    assert.equal(transitions, 1, `expected exactly 1 transition, got ${transitions}`);
    assert.equal(e.regimeState.BTC.phase, 'EXPANDING');
    assert.equal(e.regimeState.BTC.prev, stablePhase);
    assert.equal(e.regimeState.BTC.transitionsCount, 1);
  });

  test('regimeState survives getStateSnapshot / loadPersistedState round-trip', () => {
    const a = makeEngine();
    a._detectPhaseTransition('BTC', 'EXPANDING', 1_700_000_000_000);
    // Force a transition so we have non-trivial state.
    for (let i = 0; i < 5; i++) a._detectPhaseTransition('BTC', 'EXPANDING', 1_700_000_000_000 + (i + 1) * 60_000);
    const before = JSON.parse(JSON.stringify(a.regimeState));

    const snap = a.getStateSnapshot();
    assert.ok(snap.regimeState, 'snapshot must include regimeState');
    assert.ok(snap.regimePhaseDetectorState, 'snapshot must include regimePhaseDetectorState');

    const b = makeEngine();
    b.loadPersistedState(snap);
    assert.deepEqual(b.regimeState, before,
      'regimeState must equal pre-snapshot state after loadPersistedState');
  });
});
