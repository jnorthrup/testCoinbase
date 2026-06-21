import fs from 'fs';
import path from 'path';

export function logTrade({ asset, side, quantity, price, clientOrderId, note = "", grossValue = null, totalFees = null, settledValue = null }) {
  try {
    const quantityNum = parseFloat(quantity); const priceNum = parseFloat(price); if (isNaN(quantityNum) || isNaN(priceNum) || priceNum <= 0) { console.error(`Error logging trade: Invalid numeric values. Qty: ${quantity}, Price: ${price}`); return; } const totalValue = (quantityNum * priceNum).toFixed(2); const grossValueNum = parseOptionalNumber(grossValue) ?? (quantityNum * priceNum); const totalFeesNum = parseOptionalNumber(totalFees) ?? 0; const settledValueNum = parseOptionalNumber(settledValue) ?? Math.max(0, grossValueNum - totalFeesNum); appendTradeHistory({ asset, side: side.toUpperCase(), orderType: "market", quantity, effectivePrice: price, totalValue, grossValue: grossValueNum.toFixed(8), totalFees: totalFeesNum.toFixed(8), settledValue: settledValueNum.toFixed(8), clientOrderId, extra: { note } });
  } catch (error) { console.error(`Error logging trade for ${asset}:`, error); }
}

export function appendTradeHistory(tradeRecord) {
  const tradeHistoryFile = path.join(process.cwd(), 'trade_history.log');
  if (!tradeRecord.timestamp) { tradeRecord.timestamp = new Date().toISOString(); }
  const logLine = JSON.stringify(tradeRecord);
  fs.appendFile(tradeHistoryFile, logLine + "\n", (err) => {
    if (err) console.error("Error appending trade history:", err);
  });
}
let lastMarketDataFlush = 0;
let marketDataBuffer = [];


export function pruneMarketDataFile() {
  const logFile = path.join(process.cwd(), 'market_data.jsonl');
  if (!fs.existsSync(logFile)) return;
  try {
    const stats = fs.statSync(logFile);
    const MAX_SIZE = 100 * 1024 * 1024;
    if (stats.size > MAX_SIZE) {
      console.log(`🧹 [Startup Pruning] Market data file size is ${(stats.size / 1024 / 1024).toFixed(2)}MB. Pruning to save HDD performance...`);
      const content = fs.readFileSync(logFile, 'utf-8');
      const lines = content.split('\n');
      if (lines.length > 250000) {
        const prunedContent = lines.slice(-250000).join('\n');
        fs.writeFileSync(logFile, prunedContent + (prunedContent.endsWith('\n') ? '' : '\n'));
        console.log(`   ✅ HDD Pruned successfully to last 250,000 entries.`);
      }
    }
  } catch (e) {
    console.error("⚠️ Failed to prune market data on startup:", e.message);
  }
}

export function appendMarketData(timestamp, portfolioSummary) {
  const prices = {};
  portfolioSummary.forEach(r => prices[r.Symbol] = r.Price);
  const entry = JSON.stringify({ t: timestamp, p: prices });

  marketDataBuffer.push(entry);

  if (marketDataBuffer.length >= 15 || (Date.now() - lastMarketDataFlush > 120000)) {
    const logFile = path.join(process.cwd(), 'market_data.jsonl');
    const bulkData = marketDataBuffer.join('\n') + '\n';

    fs.appendFile(logFile, bulkData, (err) => {
      if (err) console.error("Error appending market data:", err);
    });
    marketDataBuffer = [];
    lastMarketDataFlush = Date.now();
  }

  // Update In-Memory History
  if (typeof priceHistory !== 'undefined' && Array.isArray(priceHistory)) {
    priceHistory.push({ t: timestamp, p: prices });
    if (priceHistory.length > 300) priceHistory.shift();
  }
}

export function loadRecentMarketData(limit = 200) {
  const logFile = path.join(process.cwd(), 'market_data.jsonl');
  if (!fs.existsSync(logFile)) return [];

  let fd;
  try {
    // HDD Optimization: Read backwards from the end of the file in 64KB chunks instead of loading 250MB+ into RAM
    fd = fs.openSync(logFile, 'r');
    const stats = fs.fstatSync(fd);
    const fileSize = stats.size;
    if (fileSize === 0) return [];

    const chunkSize = 64 * 1024;
    const buffer = Buffer.alloc(chunkSize);
    let filePosition = fileSize;
    let lines = [];
    let leftover = '';

    while (filePosition > 0 && lines.length < limit + 1) {
      const readSize = Math.min(chunkSize, filePosition);
      filePosition -= readSize;

      fs.readSync(fd, buffer, 0, readSize, filePosition);
      const dataStr = buffer.toString('utf8', 0, readSize) + leftover;
      const partLines = dataStr.split('\n');

      leftover = partLines[0];
      if (partLines.length > 1) {
        lines = partLines.slice(1).concat(lines);
      }
    }

    if (leftover && lines.length < limit + 1) {
      lines.unshift(leftover);
    }

    const cleanLines = lines.filter(line => line.trim()).slice(-limit);
    return cleanLines.map(line => {
      try { return JSON.parse(line); } catch (e) { return null; }
    }).filter(x => x);

  } catch (err) {
    console.warn("⚠️ Chunked history read failed, falling back to full read:", err.message);
    try {
      if (fd) fs.closeSync(fd);
      const content = fs.readFileSync(logFile, 'utf-8').trim();
      if (!content) return [];
      const lines = content.split('\n');
      const recent = lines.slice(-limit);
      return recent.map(line => {
        try { return JSON.parse(line); } catch (e) { return null; }
      }).filter(x => x);
    } catch (fallbackErr) {
      console.error("❌ Fallback history read also failed:", fallbackErr.message);
      return [];
    }
  } finally {
    if (fd) {
      try { fs.closeSync(fd); } catch (e) { }
    }
  }
}
