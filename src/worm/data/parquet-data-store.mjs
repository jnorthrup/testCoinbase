// src/worm/data/parquet-data-store.mjs
import duckdb from 'duckdb';
import fs from 'fs';
import path from 'path';

export class ParquetDataStore {
  constructor(basePath = './data/parquet') {
    this.basePath = basePath;
    this.db = new duckdb.Database(':memory:');
    this.conn = this.db.connect();

    if (!fs.existsSync(basePath)) {
      fs.mkdirSync(basePath, { recursive: true });
    }
  }

  /**
   * Ingest a Binance kline CSV file (from data.binance.vision)
   * and store it as clean, partitioned Parquet.
   * Automatically detects and reports gaps.
   */
  async ingestBinanceKlines(symbol, interval, csvFilePath) {
    const table = `${symbol.toLowerCase()}_${interval}`;

    console.log(`[ParquetDataStore] Ingesting ${symbol} ${interval}...`);

    // Load raw data
    await this._query(`
      CREATE OR REPLACE TABLE ${table}_raw AS
      SELECT 
        CAST(open_time AS TIMESTAMP) as t,
        open::DOUBLE,
        high::DOUBLE,
        low::DOUBLE,
        close::DOUBLE,
        volume::DOUBLE
      FROM read_csv_auto('${csvFilePath}', header=true)
    `);

    // Clean: remove duplicates + sort
    await this._query(`
      CREATE OR REPLACE TABLE ${table}_clean AS
      SELECT DISTINCT ON (t)
        t,
        open, high, low, close, volume
      FROM ${table}_raw
      WHERE t IS NOT NULL
      ORDER BY t
    `);

    // === Automatic Gap Detection ===
    const gaps = await this._detectGaps(table, interval);
    if (gaps.length > 0) {
      console.log(`[ParquetDataStore] ⚠️  Found ${gaps.length} gap(s) in ${symbol} ${interval}:`);
      gaps.slice(0, 5).forEach(gap => {
        console.log(`   - ${gap.start} → ${gap.end} (${gap.duration_minutes} min)`);
      });
      if (gaps.length > 5) {
        console.log(`   ... and ${gaps.length - 5} more`);
      }
    } else {
      console.log(`[ParquetDataStore] ✓ No gaps detected in ${symbol} ${interval}`);
    }

    // Write as partitioned Parquet (by year/month)
    const outputDir = path.join(this.basePath, symbol.toUpperCase(), interval);
    fs.mkdirSync(outputDir, { recursive: true });

    await this._query(`
      COPY ${table}_clean 
      TO '${outputDir}/data.parquet' 
      (FORMAT PARQUET, PARTITION_BY (year(t), month(t)))
    `);

    console.log(`[ParquetDataStore] Done: ${symbol} ${interval}`);
  }

  /**
   * Detect gaps in the cleaned data based on expected interval.
   */
  async _detectGaps(tableName, interval) {
    const intervalMinutes = this._getIntervalMinutes(interval);

    const query = `
      WITH ordered_data AS (
        SELECT t, 
               LAG(t) OVER (ORDER BY t) as prev_t
        FROM ${tableName}_clean
      )
      SELECT 
        prev_t as start,
        t as end,
        EXTRACT(EPOCH FROM (t - prev_t)) / 60 as duration_minutes
      FROM ordered_data
      WHERE prev_t IS NOT NULL 
        AND EXTRACT(EPOCH FROM (t - prev_t)) / 60 > ${intervalMinutes * 1.5}
      ORDER BY prev_t
    `;

    return await this._query(query);
  }

  _getIntervalMinutes(interval) {
    const map = {
      '1m': 1,
      '3m': 3,
      '5m': 5,
      '15m': 15,
      '30m': 30,
      '1h': 60,
      '2h': 120,
      '4h': 240,
      '6h': 360,
      '8h': 480,
      '12h': 720,
      '1d': 1440
    };
    return map[interval] || 1;
  }

  /**
   * Load clean candles for backtesting / shadow mode.
   * Returns data in a format usable by TradingEngine.
   */
  async loadCandles(symbol, startTime, endTime, interval = '1m') {
    const dir = path.join(this.basePath, symbol.toUpperCase(), interval);

    if (!fs.existsSync(dir)) {
      throw new Error(`No data found for ${symbol} ${interval}`);
    }

    const query = `
      SELECT 
        epoch(t) * 1000 as timestamp,
        close as price
      FROM read_parquet('${dir}/**/*.parquet')
      WHERE t >= '${new Date(startTime).toISOString()}'
        AND t < '${new Date(endTime).toISOString()}'
      ORDER BY t
    `;

    const rows = await this._query(query);

    return rows.map(row => ({
      t: row.timestamp,
      p: { [symbol]: row.price }
    }));
  }

  /**
   * Get the available date range for a symbol
   */
  async getAvailableRange(symbol, interval = '1m') {
    const dir = path.join(this.basePath, symbol.toUpperCase(), interval);

    const result = await this._query(`
      SELECT 
        min(t) as start_time,
        max(t) as end_time
      FROM read_parquet('${dir}/**/*.parquet')
    `);

    return result[0];
  }

  async _query(sql) {
    return new Promise((resolve, reject) => {
      this.conn.all(sql, (err, res) => {
        if (err) reject(err);
        else resolve(res);
      });
    });
  }
}