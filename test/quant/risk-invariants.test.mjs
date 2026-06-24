// test/quant/risk-invariants.test.mjs
// Risk as a set of named invariants. After the simplification pass, the policy
// stores three regime-named caps (no multiplicative curry). Each test pins a
// specific invariant or regime-keyed cap shape.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RiskPolicy, RISK_BREACH_KINDS } from '../../src/worm/engine/risk-invariants.mjs';

describe('RiskPolicy constants', () => {
  test('default constants are conservative and finite; regime caps are named (no curry)', () => {
    const p = new RiskPolicy({});
    const c = p.constants;
    assert.ok(Number.isFinite(c.maxSpawnPctOfPortfolio));
    assert.ok(Number.isFinite(c.maxSingleAssetPctOfPortfolio));
    assert.ok(Number.isFinite(c.maxVolPctTradeable));
    assert.ok(Number.isFinite(c.crashFundPctFloor));
    // Regime-keyed caps exist as named numbers; STABLE is baseline, others <= STABLE.
    assert.ok(c.capByRegime);
    assert.equal(typeof c.capByRegime.STABLE, 'number');
    assert.equal(typeof c.capByRegime.EXPANDING, 'number');
    assert.equal(typeof c.capByRegime.COMPRESSING, 'number');
    assert.ok(c.capByRegime.EXPANDING < c.capByRegime.STABLE,
      `EXPANDING cap must be < STABLE cap; got ${c.capByRegime.EXPANDING}`);
    assert.ok(c.capByRegime.COMPRESSING <= c.capByRegime.STABLE);
    // The legacy regimeCurry map must NOT exist on the constants object anymore.
    assert.equal(c.regimeCurry, undefined, 'regimeCurry map must be removed from constants');
  });
});

describe('RiskPolicy.maxSpawnAllowable', () => {
  test('returns cashCap when cash is the binding constraint', () => {
    const p = new RiskPolicy({});
    // $100 cash, $10,000 portfolio. With defaults:
    // portfolioCap = 10000 * 0.02 = 200, regimeCap = 10000 * 0.06 = 600 (STABLE).
    // Expected = min(100, 200, 600) = 100.
    const r = p.maxSpawnAllowable(100, 10_000, 'STABLE', null);
    assert.equal(r.allowed, 100);
    assert.equal(r.cashCap, 100);
    assert.equal(r.portfolioCap, 200);
    assert.equal(r.regimeCap, 600);
  });

  test('returns portfolioCap when portfolio is binding', () => {
    const p = new RiskPolicy({});
    // $5000 cash, $10,000 portfolio. portfolioCap=200, regimeCap=600, cashCap=5000.
    // Expected = min(5000, 200, 600) = 200.
    const r = p.maxSpawnAllowable(5_000, 10_000, 'STABLE', null);
    assert.equal(r.allowed, 200);
    assert.equal(r.portfolioCap, 200);
  });

  test('regime-named caps: EXPANDING cap < STABLE cap (one number per regime, no curry)', () => {
    // $1M portfolio defaults: regime cap STABLE = 1e6 * 0.06 = 60000, EXPANDING = 36000.
    const p = new RiskPolicy({ MAX_SPAWN_PCT_OF_PORTFOLIO: 1.0 /* loose portfolio cap */ });
    const stable = p.maxSpawnAllowable(10_000_000, 10_000_000, 'STABLE', null);
    const expanding = p.maxSpawnAllowable(10_000_000, 10_000_000, 'EXPANDING', null);
    const compressing = p.maxSpawnAllowable(10_000_000, 10_000_000, 'COMPRESSING', null);
    // Regime caps are direct reads from the genome-named slots, no multiplicative.
    assert.equal(stable.regimeCap, 600_000);
    assert.equal(expanding.regimeCap, 360_000);   // 0.036 * 1e7
    assert.equal(compressing.regimeCap, 480_000); // 0.048 * 1e7
    // Stability ordering: EXPANDING < COMPRESSING < STABLE.
    assert.ok(expanding.regimeCap < stable.regimeCap);
    assert.ok(compressing.regimeCap < stable.regimeCap);
    assert.ok(expanding.regimeCap < compressing.regimeCap);
  });

  test('per-symbol overrides tighten the regime cap', () => {
    const genome = {
      RISK_MAX_VOL_PCT_TRADEABLE_STABLE: 0.10,
      overrides: {
        BTC: { MAX_VOL_PCT_TRADEABLE_STABLE: 0.02 },
      },
    };
    const p = new RiskPolicy(genome);
    const stable = p.maxSpawnAllowable(1_000_000, 1_000_000, 'STABLE', null);
    // Portfolio $1M: regimeCap for STABLE without override = 1e6 * 0.10 = 100000.
    // With BTC-specific override (no sym argument), defaults remain.
    assert.equal(p.constantsFor(null).capByRegime.STABLE, 0.10);
    // BTC-specific:
    assert.equal(p.constantsFor('BTC').capByRegime.STABLE, 0.02);
    assert.equal(stable.regimeCap, 100_000);
    // capFor with sym= applies the override.
    assert.equal(p.capFor('STABLE', 'BTC'), 0.02);
    // Without sym, the global default applies.
    assert.equal(p.capFor('STABLE'), 0.10);
  });
});

describe('RiskPolicy.assertAction', () => {
  test('rejects a trade that breaches cash floor (cash would drop below crashFundPctFloor * portfolio)', () => {
    const p = new RiskPolicy({});
    const r = p.assertAction({
      kind: 'BUY',
      sym: 'BTC',
      usd: 950,
      cashBalance: 1_000,
      totalPortfolioValue: 10_000,
      regime: 'STABLE',
      currentPrice: 50_000,
    });
    assert.equal(r.allowed, false);
    assert.ok(r.breach);
    assert.equal(r.breach.kind, 'CASH_FLOOR');
    assert.ok(RISK_BREACH_KINDS.includes(r.breach.kind));
  });

  test('rejects a trade that exceeds the EXPANDING regime cap (regime-keyed, no curry)', () => {
    // Portfolio $10,000, EXPANDING regime: regime cap = 10000 * 0.036 = $360.
    // Proposed trade $400 must be rejected with MAX_VOL_PCT breach.
    const p = new RiskPolicy({});
    const r = p.assertAction({
      kind: 'SPAWN',
      sym: 'BTC',
      usd: 400,
      cashBalance: 5_000,
      totalPortfolioValue: 10_000,
      regime: 'EXPANDING',
      currentPrice: 50_000,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.breach.kind, 'MAX_VOL_PCT');
    assert.equal(r.breach.observed, 400);
    assert.equal(r.breach.cap, 360);
  });

  test('allows a bounded trade', () => {
    const p = new RiskPolicy({});
    const r = p.assertAction({
      kind: 'SPAWN',
      sym: 'BTC',
      usd: 200,
      cashBalance: 5_000,
      totalPortfolioValue: 10_000,
      regime: 'STABLE',
      currentPrice: 50_000,
    });
    assert.equal(r.allowed, true);
    assert.ok(!r.breach);
  });

  test('rejects CASH_INSUFFICIENT before any other check fires', () => {
    const p = new RiskPolicy({});
    const r = p.assertAction({
      kind: 'BUY',
      sym: 'BTC',
      usd: 2_000,
      cashBalance: 1_000,
      totalPortfolioValue: 10_000,
      regime: 'STABLE',
      currentPrice: 50_000,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.breach.kind, 'CASH_INSUFFICIENT');
  });

  test('per-symbol overrides tighten the regime cap at the asserted-action level', () => {
    // Per-symbol override at MAX_VOL_PCT_TRADEABLE_STABLE = 0.02 (much tighter than 0.06 default).
    const genome = {
      overrides: {
        BTC: { MAX_VOL_PCT_TRADEABLE_STABLE: 0.005 },
      },
    };
    const p = new RiskPolicy(genome);
    const r = p.assertAction({
      kind: 'BUY',
      sym: 'BTC',
      usd: 80,             // 0.8% of 10k = above BTC's 0.5% cap, below global 6%
      cashBalance: 5_000,
      totalPortfolioValue: 10_000,
      regime: 'STABLE',
      currentPrice: 50_000,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.breach.kind, 'MAX_VOL_PCT');
    assert.ok(r.breach.cap < 80, `per-symbol override cap should be < 80, got ${r.breach.cap}`);
  });
});

describe('RiskPolicy capFor', () => {
  test('returns the named regime cap; falls back to STABLE for unrecognized', () => {
    const p = new RiskPolicy({});
    assert.equal(p.capFor('STABLE'), 0.06);
    assert.equal(p.capFor('EXPANDING'), 0.036);
    assert.equal(p.capFor('COMPRESSING'), 0.048);
    assert.equal(p.capFor('UNKNOWN'), 0.06);   // fallback
    assert.equal(p.capFor(undefined), 0.06);   // fallback
  });
});
