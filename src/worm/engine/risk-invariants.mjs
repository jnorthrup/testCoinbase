// src/worm/engine/risk-invariants.mjs
// Risk as a set of named invariants. The engine must consult RiskPolicy before
// any state-mutating action (BUY/SELL/spawn). A breach returns {allowed:false, breach}
// and the action is short-circuited.
//
// All defaults are conservative seeds the operator tunes via genome.overrides[sym].
// Breach reporting per cycle is one-event-per-breach (the engine picks the most
// severe breach and short-circuits on it).

export class RiskPolicy {
  constructor(genome = {}) {
    this.genome = genome || {};
    this.constants = this._constants();
  }

  _constants() {
    const g = this.genome || {};
    return {
      // Maximum spawn cost as a fraction of the total portfolio value.
      maxSpawnPctOfPortfolio: g.MAX_SPAWN_PCT_OF_PORTFOLIO ?? g.RISK_MAX_SPAWN_PCT_OF_PORTFOLIO ?? 0.02,
      // Maximum single asset position as a fraction of portfolio value.
      maxSingleAssetPctOfPortfolio: g.MAX_SINGLE_ASSET_PCT_OF_PORTFOLIO ?? g.RISK_MAX_SINGLE_ASSET_PCT_OF_PORTFOLIO ?? 0.20,
      // Vol-conditioned max tradeable fraction per cycle. One number per regime
      // (no currying). The constantsFor(regime) method picks the right one.
      maxVolPctTradeable: g.MAX_VOL_PCT_TRADEABLE_STABLE ?? g.RISK_MAX_VOL_PCT_TRADEABLE_STABLE ?? 0.06,
      // Crash-fund floor as fraction of portfolio value that must remain as cash.
      crashFundPctFloor: g.CRASH_FUND_PCT_FLOOR ?? g.RISK_CRASH_FUND_PCT_FLOOR ?? 0.10,
      // Regime-named caps keyed directly off the genome. No multiplicative curry.
      // Each regime has its own cap; the policy picks the one matching the
      // current regime via constantsFor(regime).
      capByRegime: {
        STABLE: g.MAX_VOL_PCT_TRADEABLE_STABLE ?? g.RISK_MAX_VOL_PCT_TRADEABLE_STABLE ?? 0.06,
        EXPANDING: g.MAX_VOL_PCT_TRADEABLE_EXPANDING ?? g.RISK_MAX_VOL_PCT_TRADEABLE_EXPANDING ?? 0.036,
        COMPRESSING: g.MAX_VOL_PCT_TRADEABLE_COMPRESSING ?? g.RISK_MAX_VOL_PCT_TRADEABLE_COMPRESSING ?? 0.048,
      },
    };
  }

  /**
   * Resolve per-symbol overrides layered on the global constants.
   * `genome.overrides[sym]` may carry any of {RISK_MAX_SPAWN_PCT_OF_PORTFOLIO, RISK_MAX_SINGLE_ASSET_PCT_OF_PORTFOLIO,
   * RISK_MAX_VOL_PCT_TRADEABLE_*, RISK_CRASH_FUND_PCT_FLOOR} for tighter or looser
   * policy per asset.
   *
   * @param {string|null} sym - bare ticker. When null, no per-symbol overrides layer.
   */
  constantsFor(sym) {
    const g = this.genome || {};
    const ov = (sym && g.overrides && g.overrides[sym]) || {};
    const base = this.constants;
    return {
      maxSpawnPctOfPortfolio: ov.RISK_MAX_SPAWN_PCT_OF_PORTFOLIO ?? base.maxSpawnPctOfPortfolio,
      maxSingleAssetPctOfPortfolio: ov.RISK_MAX_SINGLE_ASSET_PCT_OF_PORTFOLIO ?? base.maxSingleAssetPctOfPortfolio,
      maxVolPctTradeable: ov.MAX_VOL_PCT_TRADEABLE_STABLE ?? base.maxVolPctTradeable,
      crashFundPctFloor: ov.RISK_CRASH_FUND_PCT_FLOOR ?? base.crashFundPctFloor,
      capByRegime: {
        STABLE: ov.MAX_VOL_PCT_TRADEABLE_STABLE ?? base.capByRegime.STABLE,
        EXPANDING: ov.MAX_VOL_PCT_TRADEABLE_EXPANDING ?? base.capByRegime.EXPANDING,
        COMPRESSING: ov.MAX_VOL_PCT_TRADEABLE_COMPRESSING ?? base.capByRegime.COMPRESSING,
      },
    };
  }

  /**
   * Regime-keyed cap lookup. Returns the single named cap for the regime
   * (no multiplicative). `regime` is the canonical phase from the
   * phase-transition detector (STABLE | EXPANDING | COMPRESSING). For
   * UNKNOWN or unrecognized regimes, falls back to STABLE.
   */
  capFor(regime, sym = null) {
    const c = sym ? this.constantsFor(sym) : this.constants;
    const r = regime in c.capByRegime ? regime : 'STABLE';
    return c.capByRegime[r];
  }

  /**
   * Compute the maximum spawn cost (USD) given available cash, total portfolio
   * value, and the current regime. Returns the lower of {cashCap, portfolioCap}
   * after applying the regime cap on vol. Never returns NaN/null.
   *
   * @returns {{ allowed: number, cashCap: number, portfolioCap: number, regimeCap: number }}
   */
  maxSpawnAllowable(cashBalance, totalPortfolioValue, regime = 'STABLE', sym = null) {
    const cb = Number.isFinite(cashBalance) ? Math.max(0, cashBalance) : 0;
    const pv = Number.isFinite(totalPortfolioValue) && totalPortfolioValue > 0
      ? totalPortfolioValue
      : Math.max(1, cb);  // floor for 0-portfolio case: don't divide by zero
    const c = sym ? this.constantsFor(sym) : this.constants;

    const portfolioCap = pv * c.maxSpawnPctOfPortfolio;
    // No curry multiplier. regimeCap = portfolioValue * regime-named cap (one number).
    const regimeCap = pv * this.capFor(regime, sym);
    const cashCap = cb;

    // Final allowed = min(cashCap, portfolioCap, regimeCap).
    return {
      allowed: Math.min(cashCap, portfolioCap, regimeCap),
      cashCap,
      portfolioCap,
      regimeCap,
    };
  }

  /**
   * Per-cycle invariant check. Calls before any BUY/SELL/spawn and returns
   * {allowed, breach?}. The engine refuses to act on allowed=false.
   *
   * `proposed` shape:
   *   { kind: 'SPAWN'|'BUY'|'SELL', sym, usd, cashBalance, totalPortfolioValue, regime, currentPrice? }
   *
   * Breach kinds:
   *   - 'CASH_FLOOR': proposed trade would push cash below crashFundPctFloor * portfolio.
   *   - 'MAX_VOL_PCT': proposed trade exceeds vol-conditioned cap (regime-mult).
   *   - 'MAX_ASSET_PCT': proposed BUY would push asset above maxSingleAssetPctOfPortfolio.
   *   - 'CASH_INSUFFICIENT': proposed USD > cashBalance.
   *
   * @returns {{allowed: boolean, breach?: {kind, observed, cap, severity}}}
   */
  assertAction(proposed) {
    if (!proposed || typeof proposed !== 'object') {
      return { allowed: false, breach: { kind: 'INVALID', observed: 0, cap: 0, severity: 0 } };
    }
    const c = proposed.sym ? this.constantsFor(proposed.sym) : this.constants;
    const cb = Number.isFinite(proposed.cashBalance) ? proposed.cashBalance : 0;
    const pv = Number.isFinite(proposed.totalPortfolioValue) && proposed.totalPortfolioValue > 0
      ? proposed.totalPortfolioValue
      : Math.max(1, cb);
    const usd = Number.isFinite(proposed.usd) ? Math.max(0, proposed.usd) : 0;
    const regime = proposed.regime || 'STABLE';

    // CASH_INSUFFICIENT check first — without cash you can't trade.
    if (usd > cb + 1e-9) {
      return {
        allowed: false,
        breach: { kind: 'CASH_INSUFFICIENT', observed: usd, cap: cb, severity: 4 },
      };
    }

    // CASH_FLOOR: after the trade, cash must remain >= crashFundPctFloor * portfolio.
    const minCash = pv * c.crashFundPctFloor;
    if (cb - usd < minCash - 1e-9) {
      return {
        allowed: false,
        breach: {
          kind: 'CASH_FLOOR',
          observed: cb - usd,
          cap: minCash,
          severity: 3,
        },
      };
    }

    // MAX_VOL_PCT: regime-named cap (no curry). One number per regime off the genome.
    const volCap = pv * this.capFor(regime, proposed.sym);
    if (usd > volCap + 1e-9) {
      return {
        allowed: false,
        breach: {
          kind: 'MAX_VOL_PCT',
          observed: usd,
          cap: volCap,
          severity: 2,
        },
      };
    }

    // MAX_ASSET_PCT: BUY-only. After the trade, this asset's position must not
    // exceed maxSingleAssetPctOfPortfolio of the portfolio.
    if (proposed.kind === 'BUY' || proposed.kind === 'SPAWN') {
      const price = Number.isFinite(proposed.currentPrice) && proposed.currentPrice > 0
        ? proposed.currentPrice
        : null;
      if (price) {
        const qty = usd / price;
        const posValue = qty * price;  // = usd for spot, but the cap is on notional.
        if (posValue > pv * c.maxSingleAssetPctOfPortfolio + 1e-9) {
          // We don't know the existing position; this check uses the proposed trade
          // alone. Tighter integration would subtract current holding.
          // For now, treat proposed trade <= maxSingleAssetPctOfPortfolio * portfolio.
          // If the proposed trade already exceeds that, refuse.
          return {
            allowed: false,
            breach: {
              kind: 'MAX_ASSET_PCT',
              observed: posValue,
              cap: pv * c.maxSingleAssetPctOfPortfolio,
              severity: 1,
            },
          };
        }
      }
    }

    return { allowed: true };
  }
}

export const RISK_BREACH_KINDS = ['CASH_INSUFFICIENT', 'CASH_FLOOR', 'MAX_VOL_PCT', 'MAX_ASSET_PCT', 'INVALID'];
