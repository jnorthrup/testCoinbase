import duckdb from 'duckdb';
import fs from 'fs';
import path from 'path';

// Create data directory if it doesn't exist
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.CANDLE_DB_PATH || path.join(dataDir, 'candles.db');

export class CandleDB {
  constructor() {
    this.db = new duckdb.Database(dbPath);
    this._readyResolve = null;
    this.ready = new Promise((resolve) => {
      this._readyResolve = resolve;
    });
    this.init();
  }

  init() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS candles (
        symbol VARCHAR,
        granularity INTEGER,
        start BIGINT,
        open DOUBLE,
        high DOUBLE,
        low DOUBLE,
        close DOUBLE,
        volume DOUBLE
      )
    `, (err) => {
      if (err) {
        console.error("[CandleDB] Table creation failed:", err.message);
        this._readyResolve(); // Resolve even on error to avoid deadlock
      } else {
        // Create an index to make queries extremely fast
        this.db.run(`
          CREATE INDEX IF NOT EXISTS candles_idx ON candles (symbol, granularity, start)
        `, (idxErr) => {
          if (idxErr) console.error("[CandleDB] Index creation failed:", idxErr.message);
          // Resolve after index creation completes
          this._readyResolve();
        });
      }
    });
  }

  async getCandles(symbol, granularity) {
    await this.ready;
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT start, open, high, low, close, volume 
         FROM candles 
         WHERE symbol = ? AND granularity = ? 
         ORDER BY start ASC`,
        symbol,
        granularity,
        (err, rows) => {
          if (err) {
            console.error(`[CandleDB] Failed to query candles for ${symbol}:`, err.message);
            reject(err);
          } else {
            const candles = (rows || []).map(r => ({
              start: Number(r.start),
              open: parseFloat(r.open),
              high: parseFloat(r.high),
              low: parseFloat(r.low),
              close: parseFloat(r.close),
              volume: parseFloat(r.volume)
            }));
            resolve(candles);
          }
        }
      );
    });
  }

  async saveCandles(symbol, granularity, candles) {
    await this.ready;
    if (!candles || candles.length === 0) return;

    // Use Number/parseFloat mapping to sanitize inputs
    const sanitizedCandles = candles.map(c => ({
      start: Number(c.start),
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: parseFloat(c.volume)
    })).filter(c => !isNaN(c.start) && !isNaN(c.open) && !isNaN(c.close));

    if (sanitizedCandles.length === 0) return;

    // DuckDB node API uses callbacks. We simulate ON CONFLICT REPLACE / UPSERT by deleting existing start times and inserting new ones.
    const timestamps = sanitizedCandles.map(c => c.start).join(', ');

    return new Promise((resolve, reject) => {
      this.db.run(
        `DELETE FROM candles 
         WHERE symbol = ? AND granularity = ? AND start IN (${timestamps})`,
        symbol,
        granularity,
        (err) => {
          if (err) {
            console.error(`[CandleDB] Failed to delete duplicates for ${symbol}:`, err.message);
            return reject(err);
          }

          const placeholders = sanitizedCandles.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
          const sql = `INSERT INTO candles (symbol, granularity, start, open, high, low, close, volume) VALUES ${placeholders}`;
          const params = [];
          for (const c of sanitizedCandles) {
            params.push(
              symbol,
              granularity,
              c.start,
              c.open,
              c.high,
              c.low,
              c.close,
              c.volume
            );
          }

          this.db.run(sql, ...params, (insertErr) => {
            if (insertErr) {
              console.error(`[CandleDB] Failed to bulk insert candles for ${symbol}:`, insertErr.message);
              reject(insertErr);
            } else {
              resolve();
            }
          });
        }
      );
    });
  }
}

export const candleDb = new CandleDB();
