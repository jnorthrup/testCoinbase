// src/worm/estimation/markov-regime.mjs
// Regime shifts as phase transitions.
//
// `MultiAssetKalman.classifyRegime` produces a per-cycle label (STABLE / EXPANDING /
// COMPRESSING) from the variance-ratio test. That output alone is too noisy to act on:
// a single noisy observation can flip the label without the system actually transitioning.
//
// This detector sits one layer above the classifier. It tracks a fixed-size ringbuffer of
// raw per-cycle labels per symbol and confirms a transition only when at least K of the
// most recent N observations agree on a new phase AND the prior phase has been resident
// for at least minResidencyMs. The result is a discrete regime label that flips on
// sustained phase boundaries and is stable on transient spikes.
//
// Two metaphors that drive the design:
//   1. The detector is a phase boundary, not a barometer. A spike that decays in two cycles
//      is not a phase change; ten sustained EXPANDING observations are.
//   2. State and detector are decoupled. The detector is pure — no engine coupling. The
//      engine owns the state map and forwards observations; the detector decides what
//      "phase" means.
//
// Public API:
//   createRegimeDetector({ confirmK, windowN, minResidencyMs, transitionBandRatio })
//     .observe(sym, suggestedRegime, now)
//     .phaseFor(sym)
//     .stateFor(sym)
//     .serialize()
//     .restore(state)

const DEFAULT_CONFIRM_K = 4;
const DEFAULT_WINDOW_N = 8;
const DEFAULT_MIN_RESIDENCY_MS = 30_000;
const VALID_PHASES = new Set(['STABLE', 'EXPANDING', 'COMPRESSING']);

function canonicalize(regime) {
  return VALID_PHASES.has(regime) ? regime : 'STABLE';
}

export function createRegimeDetector(opts = {}) {
  const confirmK = opts.confirmK ?? DEFAULT_CONFIRM_K;
  const windowN = opts.windowN ?? DEFAULT_WINDOW_N;
  const minResidencyMs = opts.minResidencyMs ?? DEFAULT_MIN_RESIDENCY_MS;
  const transitionBandRatio = opts.transitionBandRatio ?? 1.5;

  if (confirmK < 1 || confirmK > windowN) {
    throw new Error(`createRegimeDetector: confirmK (${confirmK}) must satisfy 1 <= confirmK <= windowN (${windowN})`);
  }
  if (windowN < 2) {
    throw new Error(`createRegimeDetector: windowN (${windowN}) must be >= 2`);
  }

  const buf = {}; // sym -> [{phase, ts}, ...] of length up to windowN
  const state = {}; // sym -> { phase, prev, transitionedAt, transitionsCount, inTransitionSince, lastObservedAt }

  function pushBuf(sym, phase, now) {
    if (!buf[sym]) buf[sym] = [];
    buf[sym].push({ phase, ts: now });
    if (buf[sym].length > windowN) buf[sym].shift();
  }

  function countPhase(sym, phase) {
    const b = buf[sym];
    if (!b) return 0;
    let c = 0;
    for (const o of b) if (o.phase === phase) c++;
    return c;
  }

  function ensureState(sym, initialPhase, now) {
    if (state[sym]) return state[sym];
    state[sym] = {
      phase: initialPhase,
      prev: null,
      transitionedAt: now,
      transitionsCount: 0,
      inTransitionSince: null,
      lastObservedAt: now,
    };
    return state[sym];
  }

  /**
   * Observe a suggested regime label for `sym` at time `now`.
   * Updates the per-symbol buffer. If the suggestion confirms against the current
   * phase (no transition needed), this is a no-op for state. If the suggestion
   * represents a new phase that meets the confirmation rules AND the prior phase
   * has been resident >= minResidencyMs, fire exactly one transition: update
   * `state[sym].phase`, set `prev` to the prior, increment transitionsCount,
   * record `transitionedAt`, and clear `inTransitionSince`.
   *
   * Returns `{ phase, transitioned, prev }`.
   */
  function observe(sym, suggestedRegime, now = Date.now()) {
    const phase = canonicalize(suggestedRegime);
    pushBuf(sym, phase, now);

    const st = ensureState(sym, phase, now);
    st.lastObservedAt = now;

    if (phase === st.phase) {
      // Currently observed regime matches the resident phase. Nothing to do.
      return { phase: st.phase, transitioned: false, prev: st.prev };
    }

    // Suggested phase differs from the resident phase. Three checks:
    //  1) the new phase dominates the rolling window (>= confirmK observations)
    //  2) the previous phase has been demoted in the rolling window (< confirmK
    //     of the last `windowN` are still the prior phase)
    //  3) the prior phase has been resident >= minResidencyMs (no flipping on
    //     fast transient residency)
    const newCount = countPhase(sym, phase);
    const priorCount = countPhase(sym, st.phase);
    const confirmPassed = newCount >= confirmK && priorCount < confirmK;
    const residencyMs = st.transitionedAt != null ? (now - st.transitionedAt) : Infinity;
    const residencyPassed = residencyMs >= minResidencyMs;

    if (!confirmPassed || !residencyPassed) {
      // Not yet a transition. Mark that we're considering one; this is observable
      // but does not change `phase`.
      if (st.inTransitionSince == null) st.inTransitionSince = now;
      return { phase: st.phase, transitioned: false, prev: st.prev };
    }

    // Confirmed transition. Fire exactly one.
    const prev = st.phase;
    st.prev = prev;
    st.phase = phase;
    st.transitionedAt = now;
    st.transitionsCount = (st.transitionsCount || 0) + 1;
    st.inTransitionSince = null;
    return { phase, transitioned: true, prev };
  }

  /**
   * Confirm a candidate regime label WITHOUT advancing the phase, used when an
   * upstream consumer wants to know whether the latest observation would, on
   * its own, satisfy the transition rules if it persisted. Useful for tests.
   */
  function wouldTransition(sym, suggestedRegime, now = Date.now()) {
    const phase = canonicalize(suggestedRegime);
    const st = state[sym];
    if (!st) return { wouldTransition: false, reason: 'no_state' };
    if (phase === st.phase) return { wouldTransition: false, reason: 'same_as_current' };
    pushBuf(sym, phase, now);
    const confirmCount = countPhase(sym, phase);
    const confirmPassed = confirmCount >= confirmK;
    const residencyMs = st.transitionedAt != null ? (now - st.transitionedAt) : Infinity;
    const residencyPassed = residencyMs >= minResidencyMs;
    return {
      wouldTransition: confirmPassed && residencyPassed,
      confirmCount,
      confirmK,
      residencyMs,
      residencyPassed,
    };
  }

  function phaseFor(sym) {
    return state[sym] ? state[sym].phase : 'STABLE';
  }

  function stateFor(sym) {
    return state[sym] ? { ...state[sym] } : null;
  }

  function serialize() {
    // Serialise the rolling buffer per symbol so that on restore the
    // confirmation counter doesn't reset to zero (which would gate a
    // legitimately sustained regime behind K more observations).
    const bufOut = {};
    for (const [sym, entries] of Object.entries(buf)) {
      bufOut[sym] = entries.map(e => ({ phase: e.phase, ts: e.ts }));
    }
    return {
      confirmK, windowN, minResidencyMs, transitionBandRatio,
      buf: bufOut,
      state: JSON.parse(JSON.stringify(state)),
    };
  }

  function restore(s) {
    if (!s || typeof s !== 'object') return;
    for (const [sym, entries] of Object.entries(s.buf || {})) {
      buf[sym] = entries.map(e => ({ phase: canonicalize(e.phase), ts: e.ts }));
    }
    for (const [sym, st] of Object.entries(s.state || {})) {
      state[sym] = { ...st };
    }
  }

  return {
    observe,
    wouldTransition,
    phaseFor,
    stateFor,
    serialize,
    restore,
    constants: { confirmK, windowN, minResidencyMs, transitionBandRatio },
  };
}
