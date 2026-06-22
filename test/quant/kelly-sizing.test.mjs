// test/quant/kelly-sizing.test.mjs
// Unit tests for Kelly criterion position sizing.
// No network calls — pure logic.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TradeHistoryAnalyzer } from '../../src/worm/dreamer/trade-history-analyzer.mjs';
import { kellySpawnCost } from '../../src/worm/estimation/kalman.mjs';

// ── kellySpawnCost ────────────────────────────────────────────────────────────

describe('kellySpawnCost: floor/ceiling/formula', () => {
  test('returns 1% of portfolio when kellyFraction is null (bootstrap fallback)', () => {
    // $10k portfolio, 1% = $100 — portfolio-scaled, not a flat constant
    assert.equal(kellySpawnCost(null, 10_000, 30, 500), 100);
  });

  test('returns 1% of portfolio when kellyFraction is 0', () => {
    assert.equal(kellySpawnCost(0, 10_000, 30, 500), 100);
  });

  test('floor still applies when 1% < minSpawnCostUsd', () => {
    // $500 portfolio, 1% = $5 < floor $30 -> floor wins
    assert.equal(kellySpawnCost(null, 500, 30, 500), 30);
  });

  test('scales with portfolio value', () => {
    // f=0.05, portfolio=$10k => $500 raw, clamped to ceiling $500
    const result = kellySpawnCost(0.05, 10_000, 30, 500);
    assert.equal(result, 500);
  });

  test('respects ceiling', () => {
    const result = kellySpawnCost(0.25, 100_000, 30, 500);
    assert.equal(result, 500);
  });

  test('respects floor when kelly*portfolio < floor', () => {
    // f=0.001, portfolio=$1000 => $1 raw, floor=$30
    const result = kellySpawnCost(0.001, 1_000, 30, 500);
    assert.equal(result, 30);
  });

  test('mid-range: f=0.02, portfolio=$5000 => $100', () => {
    const result = kellySpawnCost(0.02, 5_000, 30, 500);
    assert.equal(result, 100);
  });
});

// ── TradeHistoryAnalyzer.kellyFraction ────────────────────────────────────────

describe('TradeHistoryAnalyzer: kellyFraction from trade log', () => {
  function makeAnalyzer(trades) {
    const a = new TradeHistoryAnalyzer();
    // Bypass file I/O — inject stats directly via loadHistory logic
    a.loaded = true;
    a.stats = {};
    a._openBuys = {};
    for (const t of trades) {
      const sym = t.asset;
      if (!a.stats[sym]) a.stats[sym] = { wins: 0, losses: 0, pnl: 0, totalTrades: 0, sumWin: 0, sumLoss: 0 };
      const s = a.stats[sym];
      const val = t.totalValue;
      s.totalTrades++;
      if (t.side === 'BUY') {
        s.pnl -= val;
        if (!a._openBuys[sym]) a._openBuys[sym] = [];
        a._openBuys[sym].push({ cost: val, qty: t.quantity || 0 });
      } else if (t.side === 'SELL') {
        s.pnl += val;
        const open = a._openBuys[sym];
        if (open && open.length > 0) {
          const buy = open.shift();
          const profit = val - buy.cost;
          if (profit >= 0) { s.wins++; s.sumWin += profit; }
          else             { s.losses++; s.sumLoss += Math.abs(profit); }
        }
      }
    }
    return a;
  }

  test('returns null when fewer than 5 closed trades', () => {
    const a = makeAnalyzer([
      { asset: 'SOL', side: 'BUY',  totalValue: 100 },
      { asset: 'SOL', side: 'SELL', totalValue: 110 },
      { asset: 'SOL', side: 'BUY',  totalValue: 100 },
      { asset: 'SOL', side: 'SELL', totalValue: 90  },
    ]);
    assert.equal(a.kellyFraction('SOL'), null);
  });

  test('positive edge: 7 wins, 3 losses -> positive fraction', () => {
    const trades = [];
    for (let i = 0; i < 7; i++) {
      trades.push({ asset: 'SOL', side: 'BUY',  totalValue: 100 });
      trades.push({ asset: 'SOL', side: 'SELL', totalValue: 115 }); // $15 win
    }
    for (let i = 0; i < 3; i++) {
      trades.push({ asset: 'SOL', side: 'BUY',  totalValue: 100 });
      trades.push({ asset: 'SOL', side: 'SELL', totalValue: 90  }); // $10 loss
    }
    const a = makeAnalyzer(trades);
    const f = a.kellyFraction('SOL');
    assert.ok(f !== null, 'should return a fraction');
    assert.ok(f > 0, `fraction should be positive, got ${f}`);
    assert.ok(f <= 0.25, `fraction capped at 0.25, got ${f}`);
  });

  test('negative edge: all losses -> fraction is 0 (clamped)', () => {
    const trades = [];
    for (let i = 0; i < 6; i++) {
      trades.push({ asset: 'BTC', side: 'BUY',  totalValue: 100 });
      trades.push({ asset: 'BTC', side: 'SELL', totalValue: 80  }); // $20 loss
    }
    const a = makeAnalyzer(trades);
    const f = a.kellyFraction('BTC');
    assert.ok(f !== null);
    assert.equal(f, 0); // Math.max(0, negative) = 0
  });

  test('cap enforced: even a huge edge is capped at 0.25', () => {
    const trades = [];
    for (let i = 0; i < 10; i++) {
      trades.push({ asset: 'ETH', side: 'BUY',  totalValue: 100 });
      trades.push({ asset: 'ETH', side: 'SELL', totalValue: 999 }); // enormous win
    }
    const a = makeAnalyzer(trades);
    const f = a.kellyFraction('ETH');
    assert.ok(f !== null);
    assert.equal(f, 0.25);
  });

  test('portfolioKellyFraction aggregates across symbols', () => {
    const trades = [];
    for (let i = 0; i < 4; i++) {
      trades.push({ asset: 'SOL', side: 'BUY',  totalValue: 100 });
      trades.push({ asset: 'SOL', side: 'SELL', totalValue: 115 });
      trades.push({ asset: 'ETH', side: 'BUY',  totalValue: 100 });
      trades.push({ asset: 'ETH', side: 'SELL', totalValue: 115 });
    }
    // 8 total closed trades across 2 symbols -> portfolio method should fire
    const a = makeAnalyzer(trades);
    const f = a.portfolioKellyFraction();
    assert.ok(f !== null, 'should aggregate enough trades');
    assert.ok(f > 0);
  });
});
