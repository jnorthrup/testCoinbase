// test/quant/regime-phase-transitions.test.mjs
// Regime shifts as phase transitions. Validates that the detector (a) escalates
// only when the confirmation window is satisfied, (b) fires exactly once per
// sustained regime change, (c) gates on min residency to reject fast spikes,
// (d) ignores alternating noise, and (e) survives serialize → restore across
// a fresh detector instance without double-firing on edge observations.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRegimeDetector } from '../../src/worm/estimation/markov-regime.mjs';

describe('Phase transition detector: noise rejection', () => {
  test('a single stale label does not transition (1-of-8 confirm insufficient)', () => {
    const d = createRegimeDetector({ confirmK: 4, windowN: 8, minResidencyMs: 30_000 });
    // First observation establishes STABLE.
    const t0 = 1_700_000_000_000;
    d.observe('SYM', 'STABLE', t0);
    // One EXPANDING observation, then back to STABLE for the rest of the
    // confirmation window. Detector should NOT fire.
    d.observe('SYM', 'EXPANDING', t0 + 1_000);
    for (let i = 0; i < 6; i++) d.observe('SYM', 'STABLE', t0 + 2_000 + i * 1_000);
    assert.equal(d.phaseFor('SYM'), 'STABLE', 'phase must remain STABLE after only 1 EXPANDING');
    assert.equal(d.stateFor('SYM').transitionsCount, 0);
  });

  test('alternating label every cycle stabilises quickly and does not whip-saw', () => {
    const d = createRegimeDetector({ confirmK: 4, windowN: 8, minResidencyMs: 30_000 });
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 30; i++) {
      d.observe('X', i % 2 === 0 ? 'EXPANDING' : 'STABLE', t0 + i * 60_000);
    }
    // Once a transition fires, the post-transition alternating sequence has
    // confirmK=4 of the new phase only every 8-cycle run, so the detector will
    // settle to a stable phase within the window. We assert: at most 3 transitions
    // in 30 alternating observations (not 23 as before fix); typically 1-2.
    const transitions = d.stateFor('X').transitionsCount;
    assert.ok(transitions <= 3,
      `alternating noise should not flip regime more than ~once; got ${transitions} transitions`);
  });
});

describe('Phase transition detector: confirmed transitions', () => {
  test('sustained EXPANDING for ≥ confirmK observations transitions exactly once', () => {
    const d = createRegimeDetector({ confirmK: 4, windowN: 8, minResidencyMs: 30_000 });
    const t0 = 1_700_000_000_000;
    // Establish STABLE residency for > minResidencyMs.
    for (let i = 0; i < 3; i++) d.observe('BTC', 'STABLE', t0 + i * 60_000);
    // Now push sustained EXPANDING. confirmK=4 + minResidency satisfied => one transition.
    let transitions = 0;
    for (let i = 0; i < 10; i++) {
      const r = d.observe('BTC', 'EXPANDING', t0 + 5 * 60_000 + i * 60_000);
      if (r.transitioned) transitions++;
    }
    assert.equal(transitions, 1, `expected exactly 1 transition across 10 sustained EXPANDING, got ${transitions}`);
    assert.equal(d.phaseFor('BTC'), 'EXPANDING');
    assert.equal(d.stateFor('BTC').prev, 'STABLE');
    assert.equal(d.stateFor('BTC').transitionsCount, 1);
  });

  test('minResidencyMs rejects fast spikes even when confirmK satisfied', () => {
    // confirmK=2 makes confirmation easy; minResidencyMs=1h makes transition
    // impossible unless the prior phase has been resident >= 1h of observations.
    const d = createRegimeDetector({ confirmK: 2, windowN: 8, minResidencyMs: 60 * 60 * 1000 });
    const t0 = 1_700_000_000_000;
    // Establish STABLE for only 30 minutes.
    for (let i = 0; i < 3; i++) d.observe('ETH', 'STABLE', t0 + i * 10 * 60 * 1000);
    // Burst EXPANDING; confirmation is satisfied (count >= 2) BUT residency (30 min) < 1h.
    let transitions = 0;
    for (let i = 0; i < 10; i++) {
      const r = d.observe('ETH', 'EXPANDING', t0 + 30 * 60 * 1000 + i * 60_000);
      if (r.transitioned) transitions++;
    }
    assert.equal(transitions, 0, `expected zero transitions when residency < minResidencyMs, got ${transitions}`);
    assert.notEqual(d.phaseFor('ETH'), 'EXPANDING');
  });
});

describe('Phase transition detector: persistence', () => {
  test('serialize -> restore into a fresh detector preserves phase and resumes without double-fire', () => {
    const a = createRegimeDetector({ confirmK: 4, windowN: 8, minResidencyMs: 30_000 });
    const t0 = 1_700_000_000_000;
    // Take detector `a` through one confirmed transition.
    for (let i = 0; i < 3; i++) a.observe('BTC', 'STABLE', t0 + i * 60_000);
    for (let i = 0; i < 10; i++) a.observe('BTC', 'EXPANDING', t0 + 5 * 60_000 + i * 60_000);
    const snap = a.serialize();

    // Restore into a fresh detector `b`.
    const b = createRegimeDetector({ confirmK: 4, windowN: 8, minResidencyMs: 30_000 });
    b.restore(snap);
    assert.equal(b.phaseFor('BTC'), 'EXPANDING');
    assert.equal(b.stateFor('BTC').transitionsCount, 1);
    assert.equal(b.stateFor('BTC').prev, 'STABLE');

    // Subsequent observations must NOT re-fire a transition (we're already in EXPANDING).
    let reFire = 0;
    for (let i = 0; i < 5; i++) {
      const r = b.observe('BTC', 'EXPANDING', t0 + 30 * 60_000 + i * 60_000);
      if (r.transitioned) reFire++;
    }
    assert.equal(reFire, 0, `detector re-fired after restore; got ${reFire} unexpected transitions`);
    assert.equal(b.stateFor('BTC').transitionsCount, 1, 'transitionsCount must remain 1 across continued EXPANDING observations');
  });
});
