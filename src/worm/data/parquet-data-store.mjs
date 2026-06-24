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

  async ingestBinanceKlines(symbol, interval, csvFilePath, options = {}) {
    const { gapFillStrategy = 'forward' } = options;
    const table = `${symbol.toLowerCase()}_${interval}`;

    console.log(`[ParquetDataStore] Ingesting ${symbol} ${interval}...`);

    await this._query(`
      CREATE OR REPLACE TABLE ${table}_raw AS
      SELECT 
        CAST(open_time AS TIMESTAMP) as t,
        open::DOUBLE, high::DOUBLE, low::DOUBLE, close::DOUBLE, volume::DOUBLE
      FROM read_csv_auto('${csvFilePath}', header=true)
    `);

    await this._query(`
      CREATE OR REPLACE TABLE ${table}_dedup AS
      SELECT DISTINCT ON (t) t, open, high, low, close, volume
      FROM ${table}_raw WHERE t IS NOT NULL ORDER BY t
    `);

    const gaps = await this._detectGapsFromTable(`${table}_dedup`, interval);
    if (gaps.length > 0) {
      console.log(`[ParquetDataStore] ⚠️ Found ${gaps.length} gap(s) in ${symbol} ${interval}`);
    }

    let finalTable = `${table}_dedup`;

    if (gapFillStrategy === 'forward') {
      finalTable = await this._applyForwardFill(table);
      console.log(`[ParquetDataStore] Applied forward fill`);
    } else if (gapFillStrategy === 'interpolate') {
      finalTable = await this._applyLinearInterpolation(table);
      console.log(`[ParquetDataStore] Applied linear interpolation`);
    }

    const outputDir = path.join(this.basePath, symbol.toUpperCase(), interval);
    fs.mkdirSync(outputDir, { recursive: true });

    await this._query(`
      COPY ${finalTable} TO '${outputDir}/data.parquet' (FORMAT PARQUET, PARTITION_BY (year(t), month(t)))
    `);

    console.log(`[ParquetDataStore] Done: ${symbol} ${interval}`);
  }

  async _detectGapsFromTable(tableName, interval) {
    const mins = this._getIntervalMinutes(interval);
    const q = `WITH ordered AS (SELECT t, LAG(t) OVER (ORDER BY t) as prev_t FROM ${tableName})
      SELECT prev_t as start, t as end, EXTRACT(EPOCH FROM (t - prev_t))/60 as duration_minutes
      FROM ordered WHERE prev_t IS NOT NULL AND EXTRACT(EPOCH FROM (t - prev_t))/60 > ${mins * 1.5} ORDER BY prev_t`;
    return await this._query(q);
  }

  async _applyForwardFill(baseTable) {
    const res = `${baseTable}_forward_filled`;
    await this._query(`CREATE OR REPLACE TABLE ${res} AS
      SELECT t,
        COALESCE(open, LAG(close) OVER (ORDER BY t)) as open,
        COALESCE(high, LAG(close) OVER (ORDER BY t)) as high,
        COALESCE(low, LAG(close) OVER (ORDER BY t)) as low,
        COALESCE(close, LAG(close) OVER (ORDER BY t)) as close,
        COALESCE(volume, 0) as volume
      FROM ${baseTable}_dedup ORDER BY t`);
    return res;
  }

  async _applyLinearInterpolation(baseTable) {
    const res = `${baseTable}_interpolated`;
    await this._query(`CREATE OR REPLACE TABLE ${res} AS
      WITH n AS (SELECT *, LAG(t) OVER (ORDER BY t) prev_t, LAG(close) OVER (ORDER BY t) prev_close,
        LEAD(t) OVER (ORDER BY t) next_t, LEAD(close) OVER (ORDER BY t) next_close FROM ${baseTable}_dedup)
      SELECT t, COALESCE(open, prev_close) as open,
        COALESCE(high, GREATEST(COALESCE(prev_close, close), COALESCE(next_close, close))) as high,
        COALESCE(low, LEAST(COALESCE(prev_close, close), COALESCE(next_close, close))) as low,
        COALESCE(close, prev_close + (next_close - prev_close) * (EXTRACT(EPOCH FROM (t - prev_t)) / NULLIF(EXTRACT(EPOCH FROM (next_t - prev_t)), 0))) as close,
        COALESCE(volume, 0) as volume FROM n ORDER BY t`);
    return res;
  }

  _getIntervalMinutes(interval) {
    const m = { '1m':1,'3m':3,'5m':5,'15m':15,'30m':30,'1h':60,'2h':120,'4h':240,'6h':360,'8h':480,'12h':720,'1d':1440 };
    return m[interval] || 1;
  }

  async loadCandles(symbol, startTime, endTime, interval = '1m') {
    const dir = path.join(this.basePath, symbol.toUpperCase(), interval);
    if (!fs.existsSync(dir)) throw new Error(`No data for ${symbol} ${interval}`);
    const q = `SELECT epoch(t)*1000 as timestamp, close as price FROM read_parquet('${dir}/**/*.parquet')
      WHERE t >= '${new Date(startTime).toISOString()}' AND t < '${new Date(endTime).toISOString()}' ORDER BY t`;
    const rows = await this._query(q);
    return rows.map(r => ({ t: r.timestamp, p: { [symbol]: r.price } }));
  }

  async getAvailableRange(symbol, interval = '1m') {
    const dir = path.join(this.basePath, symbol.toUpperCase(), interval);
    return (await this._query(`SELECT min(t) start_time, max(t) end_time FROM read_parquet('${dir}/**/*.parquet')`))[0];
  }

  async _query(sql) {
    return new Promise((res, rej) => this.conn.all(sql, (e, r) => e ? rej(e) : res(r)));
  }
}