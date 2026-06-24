# QUANT_LOGIC.md

**Simplified Quant Architecture for testCoinbase**

> "Everything should be made as simple as possible, but not simpler." — Einstein

## Core Philosophy

- One single strategy (the live strategy)
- Conviction is the central signal of edge strength
- Filtered volatility adjusts conviction in one clean place
- Regime genomes handle structural differences across market states
- Strategy logic is mode-agnostic (does not know live vs paper)
- Keep the system understandable, robust, and minimally layered

## Signal Flow

```
Price History
     ↓
calculateRealizedVolatility()
     ↓
KalmanVolatilityFilter → Filtered Volatility
     ↓
calculateAlphaConviction()
     → Technical signals (RSI, Bollinger, ROC) + Filtered Volatility
     → Produces volatility-adjusted Conviction
     ↓
alpha-modulator (getAlphaModulatedTriggers)
     → Modulates harvest & rebalance triggers using Conviction
     ↓
RegimeGenomeManager + _getEffectiveGenome
     → Loads regime-specific parameters when available
     ↓
Decision Layer (mode-agnostic)
     - Harvest / Rebalance triggers
     - Harvest take % (modest conviction influence)
     - Kelly spawn sizing (modest conviction influence)
     ↓
Execution Layer
     - Live: Real orders + real wallet
     - Paper: Simulated wallet + read-only market data
```

## Key Components

| Component | Role | Notes |
|-----------|------|-------|
| `calculateAlphaConviction` | Core edge signal | Volatility-adjusted via Kalman filter |
| `KalmanVolatilityFilter` | Smoothed volatility | Adaptive to regime changes + reset on major shifts |
| `alpha-modulator` | Trigger modulation | Uses conviction (already volatility-aware) |
| `RegimeGenomeManager` | Regime-specific parameters | Structural differences per regime |
| `_getEffectiveGenome` | Loads regime-aware genome | Falls back to base genome cleanly |
| `_getModulatedTriggers` | DRY helper for modulation | Clean interface to alpha-modulator |
| `_logStrategyState` | Observability | Configurable logging for paper trading analysis |

## Design Principles

- **Single source of edge**: Conviction carries technical signals + volatility effect
- **Minimal layering**: Volatility affects conviction once. No repeated scaling
- **Separation of concerns**:
  - Regime genomes = structural differences
  - Conviction + Filtered Volatility = dynamic adjustment
- **Mode agnosticism**: Strategy decisions do not branch on live vs paper
- **Observability**: Key signals (conviction, filtered vol, regime, triggers) are logged in paper mode
- **Robustness**: Kalman filter includes regime-shift reset logic

## Current State (Simplified)

- Volatility awareness flows through conviction
- Regime awareness flows through genome loading
- Sizing (harvest take & Kelly) receives modest conviction influence
- System remains clean, debuggable, and extensible

## Files

- `src/worm/estimation/technical-indicators.mjs`
- `src/worm/estimation/kalman-volatility.mjs`
- `src/worm/engine/alpha-modulator.mjs`
- `src/worm/regime/regime-genome-manager.mjs`
- `src/worm/utils/idempotent-cache.mjs`
- `src/worm/data/parquet-data-store.mjs`
- `src/worm/engine/trading-engine.mjs` (integration layer)

---

*This document reflects the simplified, principled state of the quant logic as of June 2026.*