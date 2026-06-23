import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateRSI,
  calculateSMA,
  calculateEMA,
  calculateBollingerBands,
  calculateROC,
  calculateVolatility,
  calculateAlphaConviction
} from '../../src/worm/estimation/technical-indicators.mjs';

describe('Technical Indicators - Alpha Factors', () => {
  const uptrend = Array.from({ length: 50 }, (_, i) => 100 + i * 0.5);
  const downtrend = Array.from({ length: 50 }, (_, i) => 150 - i * 0.5);
  const sideways = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i / 5) * 3);

  it('calculateRSI returns valid value in [0,100] or null', () => {
    const rsiUp = calculateRSI(uptrend, 14);
    const rsiDown = calculateRSI(downtrend, 14);
    assert.ok(rsiUp === null || (rsiUp >= 0 && rsiUp <= 100));
    assert.ok(rsiDown === null || (rsiDown >= 0 && rsiDown <= 100));
    assert.strictEqual(calculateRSI([100, 101], 14), null); // too short
  });

  it('calculateAlphaConviction produces score in [-1,1] with rich diagnostics', () => {
    const result = calculateAlphaConviction(uptrend, { rsiPeriod: 14 });
    assert.ok(result.conviction >= -1 && result.conviction <= 1);
    assert.ok(['BULLISH_ALPHA', 'BEARISH_OR_OVERBOUGHT', 'NEUTRAL'].includes(result.interpretation));
    assert.ok(result.rsi);
    assert.ok(result.signals);
  });

  it('Bollinger %B is clamped to [0,1]', () => {
    const bb = calculateBollingerBands(uptrend, 20);
    assert.ok(bb.percentB >= 0 && bb.percentB <= 1);
  });

  it('calculateROC and volatility return reasonable numbers or null', () => {
    assert.ok(calculateROC(uptrend, 10) > 0);
    const vol = calculateVolatility(uptrend, 20);
    assert.ok(vol === null || vol > 0);
  });

  it('handles edge cases gracefully (empty, short arrays)', () => {
    assert.strictEqual(calculateRSI([], 14), null);
    assert.strictEqual(calculateSMA([1,2], 10), null);
    const conv = calculateAlphaConviction([100]);
    assert.ok(conv && conv.conviction === 0 && conv.signals?.insufficientData);
  });
});