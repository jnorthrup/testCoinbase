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
   * Ingest a Binance kline CSV file and store as clean Parquet.
   * 
   * @param {string} symbol 
   * @param {string} interval 
   * @param {string} csvFilePath 
   * @param {Object} options
   * @param {'none'|'forward'|'interpolate'} [options.gapFillStrategy='forward']
   */
  async ingestBinanceKlines(symbol, interval, csvFilePath, options = {}) {
    const { gapFillStrategy = 'forward' } = options;
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

    // Remove duplicates and sort
    await this._query(`
      CREATE OR REPLACE TABLE ${table}_dedup AS
      SELECT DISTINCT ON (t)
        t, open, high, low, close, volume
      FROM ${table}_raw
      WHERE t IS NOT NULL
      ORDER BY t
    `);

    // Gap detection
    const gaps = await this._detectGapsFromTable(`${table}_dedup`, interval);
    if (gaps.length > 0) {
      console.log(`[ParquetDataStore] ⚠️  Found ${gaps.length} gap(s) in ${symbol} ${interval}`);
    }

    let finalTable = `${table}_dedup`;

    // === Gap Filling Strategies ===
    if (gapFillStrategy === 'forward') {
      finalTable = await this._applyForwardFill(table);
      console.log(`[ParquetDataStore] Applied forward fill strategy`);
    } else if (gapFillStrategy === 'interpolate') {
      finalTable = await this._applyLinearInterpolation(table);
      console.log(`[ParquetDataStore] Applied linear interpolation strategy`);
    } else {
      console.log(`[ParquetDataStore] No gap filling applied`);
    }

    // Write final clean data as partitioned Parquet
    const outputDir = path.join(this.basePath, symbol.toUpperCase(), interval);
    fs.mkdirSync(outputDir, { recursive: true });

    await this._query(`
      COPY ${finalTable} 
      TO '${outputDir}/data.parquet' 
      (FORMAT PARQUET, PARTITION_BY (year(t), month(t)))
    `);

    console.log(`[ParquetDataStore] Done: ${symbol} ${interval}`);
  }

  async _detectGapsFromTable(tableName, interval) {
    const intervalMinutes = this._getIntervalMinutes(interval);

    const query = `
      WITH ordered AS (
        SELECT t, LAG(t) OVER (ORDER BY t) as prev_t
        FROM ${tableName}
      )
      SELECT 
        prev_t as start,
        t as end,
        EXTRACT(EPOCH FROM (t - prev_t)) / 60 as duration_minutes
      FROM ordered
      WHERE prev_t IS NOT NULL 
        AND EXTRACT(EPOCH FROM (t - prev_t)) / 60 > ${intervalMinutes * 1.5}
      ORDER BY prev_t
    `;

    return await this._query(query);
  }

  async _applyForwardFill(baseTable) {
    const resultTable = `${baseTable}_forward_filled`;

    await this._query(`
      CREATE OR REPLACE TABLE ${resultTable} AS
      SELECT 
        t,
        COALESCE(open,  LAG(close) OVER (ORDER BY t)) as open,
        COALESCE(high,  LAG(close) OVER (ORDER BY t)) as high,
        COALESCE(low,   LAG(close) OVER (ORDER BY t)) as low,
        COALESCE(close, LAG(close) OVER (ORDER BY t)) as close,
        COALESCE(volume, 0) as volume
      FROM ${baseTable}_dedup
      ORDER BY t
    `);

    return resultTable;
  }

  async _applyLinearInterpolation(baseTable) {
    const resultTable = `${baseTable}_interpolated`;

    await this._query(`
      CREATE OR REPLACE TABLE ${resultTable} AS
      WITH with_neighbors AS (
        SELECT *,
               LAG(t) OVER (ORDER BY t) as prev_t,
               LAG(close) OVER (ORDER BY t) as prev_close,
               LEAD(t) OVER (ORDER BY t) as next_t,
               LEAD(close) OVER (ORDER BY t) as next_close
        FROM ${baseTable}_dedup
      )
      SELECT 
        t,
        COALESCE(open, prev_close) as open,
        COALESCE(high, GREATEST(COALESCE(prev_close, close), COALESCE(next_close, close))) as high,
        COALESCE(low,  LEAST(COALESCE(prev_close, close), COALESCE(next_close, close))) as low,
        COALESCE(close, 
          prev_close + (next_close - prev_close) * 
          (EXTRACT(EPOCH FROM (t - prev_t)) / NULLIF(EXTRACT(EPOCH FROM (next_t - prev_t)), 0))
        ) as close,
        COALESCE(volume, 0) as volume
      FROM with_neighbors
      ORDER BY t
    `);

    return resultTable;
  }

  _getIntervalMinutes(interval) {
    const map = {
      '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30,
      '1h': 60, '2h': 120, '4h': 240, '6h': 360, '8h': 480, '12h': 720,
      '1d': 1440
    };
    return map[interval] || 1;
  }

  async loadCandles(symbol, startTime, endTime, interval = '1m') {
    const dir = path.join(this.basePath, symbol.toUpperCase(), interval);
    if (!fs.existsSync(dir)) {
      throw new Error(`No Parquet data found for ${symbol} ${interval}`);
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

  async getAvailableRange(symbol, interval = '1m') {
    const dir = path.join(this.basePath, symbol.toUpperCase(), interval);

    const result = await this._query(`
      SELECT min(t) as start_time, max(t) as end_time
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