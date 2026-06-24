# QUANT_LOGIC.md

**Simplified Quant Architecture for testCoinbase**

> "Everything should be made as simple as possible, but not simpler." — Einstein

## Core Philosophy

- One single strategy (the live strategy)
- Conviction is the central signal of edge strength
- Filtered volatility adjusts conviction in one clean place
- Regime genomes handle structural differences across market states
- Strategy logic is mode-agnostic
- Keep the system understandable and minimally layered

## Signal Flow

```
Price History
     ↓
calculateRealizedVolatility()
     ↓
KalmanVolatilityFilter → Filtered Volatility
     ↓
calculateAlphaConviction()  (volatility-aware)
     ↓
alpha-modulator
     ↓
RegimeGenomeManager + _getEffectiveGenome
     ↓
Decision Layer (mode-agnostic)
     ↓
Execution (Live / Paper)
```

## Key Components

- `calculateAlphaConviction` — Core signal (volatility-adjusted)
- `KalmanVolatilityFilter` — Smoothed adaptive volatility
- `alpha-modulator` — Trigger modulation via conviction
- `RegimeGenomeManager` — Regime-specific parameters
- Clean helpers in engine for modulation and logging

*Last updated: June 2026*