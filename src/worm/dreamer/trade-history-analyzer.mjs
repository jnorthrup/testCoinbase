// Lifted from robinhood-worm.js — Python array scissor.
// Full shared imports cloned. DCE later.

import dotenv from 'dotenv';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import os from 'os';
import { fileURLToPath } from 'url';
import { fork } from 'child_process';

export class TradeHistoryAnalyzer {
  constructor(historyFile = 'trade_history.log') {
    this.historyFile = historyFile;
    this.stats = {}; // { SYM: { wins, losses, pnl, totalTrades, sumWin, sumLoss } }
    this.trades = []; // Raw trade list
    this.loaded = false;
    this._openBuys = {}; // { SYM: [ { cost, qty } ] } — match sells to prior buys
  }

  loadHistory() {
    if (!fs.existsSync(this.historyFile)) return;
    try {
      const lines = fs.readFileSync(this.historyFile, 'utf-8').split('\n');
      this.stats = {};
      this.trades = [];
      this._openBuys = {};
      lines.forEach(line => {
        if (!line.trim()) return;
        try {
          const trade = JSON.parse(line);
          if (!trade.asset || !trade.side || !trade.totalValue) return;
          this.trades.push(trade);
          const sym = trade.asset;
          if (!this.stats[sym]) this.stats[sym] = { wins: 0, losses: 0, pnl: 0, totalTrades: 0, sumWin: 0, sumLoss: 0 };
          const s = this.stats[sym];
          const val = parseFloat(trade.totalValue);
          s.totalTrades++;
          if (trade.side === 'BUY') {
            s.pnl -= val;
            if (!this._openBuys[sym]) this._openBuys[sym] = [];
            this._openBuys[sym].push({ cost: val, qty: parseFloat(trade.quantity || 0) });
          } else if (trade.side === 'SELL') {
            s.pnl += val;
            // Match against oldest open buy (FIFO)
            const open = this._openBuys[sym];
            if (open && open.length > 0) {
              const buy = open.shift();
              const gross = val - (parseFloat(trade.totalFees || 0));
              const profit = gross - buy.cost;
              if (profit >= 0) { s.wins++; s.sumWin += profit; }
              else             { s.losses++; s.sumLoss += Math.abs(profit); }
            }
          }
        } catch (e) { }
      });
      this.loaded = true;
      console.log(`   📚 History Loaded: Processed ${this.trades.length} trades.`);
    } catch (err) { console.error("Error loading history:", err); }
  }

  // Kelly fraction for a symbol: f* = (p*b - q) / b
  // Returns null if insufficient data (< 5 closed trades).
  kellyFraction(sym) {
    if (!this.loaded) this.loadHistory();
    const s = this.stats[sym];
    if (!s) return null;
    const closed = s.wins + s.losses;
    if (closed < 5) return null;
    const p = s.wins / closed;
    const q = 1 - p;
    const avgWin  = s.wins   > 0 ? s.sumWin  / s.wins   : 0;
    const avgLoss = s.losses > 0 ? s.sumLoss / s.losses : 1; // avoid div/0
    const b = avgWin / avgLoss; // win/loss ratio
    if (b <= 0) return null;
    const f = (p * b - q) / b;
    return Math.max(0, Math.min(0.25, f)); // hard cap at 25% — half-Kelly safety
  }

  // Portfolio-level Kelly fraction: aggregate wins/losses across all symbols.
  // Used when sizing a new spawn before a specific symbol is chosen.
  portfolioKellyFraction() {
    if (!this.loaded) this.loadHistory();
    let totalWins = 0, totalLosses = 0, sumWin = 0, sumLoss = 0;
    for (const s of Object.values(this.stats)) {
      totalWins   += s.wins;
      totalLosses += s.losses;
      sumWin      += s.sumWin;
      sumLoss     += s.sumLoss;
    }
    const closed = totalWins + totalLosses;
    if (closed < 5) return null;
    const p = totalWins / closed;
    const q = 1 - p;
    const avgWin  = totalWins   > 0 ? sumWin  / totalWins   : 0;
    const avgLoss = totalLosses > 0 ? sumLoss / totalLosses : 1;
    const b = avgWin / avgLoss;
    if (b <= 0) return null;
    const f = (p * b - q) / b;
    return Math.max(0, Math.min(0.25, f));
  }

  calculateSlippageMap() {
    if (!this.loaded) this.loadHistory();
    return { 'DEFAULT': 0.003 };
  }
}

// Renamed from SimulatorWorker to ScientificOptimizer for self-contained usage
