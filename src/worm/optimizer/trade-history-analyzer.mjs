import fs from 'fs';

class TradeHistoryAnalyzer {
  constructor(historyFile = 'trade_history.log') {
    this.historyFile = historyFile;
    this.stats = {};
    this.trades = [];
    this.loaded = false;
  }

  loadHistory() {
    if (!fs.existsSync(this.historyFile)) return;
    try {
      const lines = fs.readFileSync(this.historyFile, 'utf-8').split('\n');
      this.stats = {};
      this.trades = [];
      lines.forEach((line) => {
        if (!line.trim()) return;
        try {
          const trade = JSON.parse(line);
          if (!trade.asset || !trade.side || !trade.totalValue) return;
          this.trades.push(trade);
          if (!this.stats[trade.asset]) this.stats[trade.asset] = { wins: 0, losses: 0, pnl: 0, totalTrades: 0 };
          const s = this.stats[trade.asset];
          const val = parseFloat(trade.totalValue);
          if (trade.side === 'BUY') s.pnl -= val;
          else if (trade.side === 'SELL') s.pnl += val;
          s.totalTrades += 1;
        } catch {}
      });
      this.loaded = true;
      TradeHistoryAnalyzer._loadCount = (TradeHistoryAnalyzer._loadCount || 0) + 1;
      if (TradeHistoryAnalyzer._loadCount === 1) {
        console.log(`📦 Trade history preload: ${this.trades.length} trades from ${this.historyFile}`);
      }
      if (process.env.WORM_VERBOSE_HISTORY === '1') {
        console.log(`   📚 [analyser #${TradeHistoryAnalyzer._loadCount}] History Loaded: Processed ${this.trades.length} trades.`);
      }
    } catch (err) {
      console.error('Error loading history:', err);
    }
  }

  calculateSlippageMap() {
    if (!this.loaded) this.loadHistory();
    return { DEFAULT: 0.003 };
  }
}

export { TradeHistoryAnalyzer };
