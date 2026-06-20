#!/usr/bin/env node
'use strict';

const { CoinbaseApiError, createClient } = require('./coinbase-advanced');

function usage() {
  console.log(`Coinbase portfolio reporter\n\nUsage:\n  node portfolio.js [--json] [--all]\n\nWhat it does:\n  - fetches live Coinbase Advanced Trade accounts\n  - fetches live USD product prices for non-zero crypto balances when available\n  - prints an approximate USD portfolio total\n\nNo trades are placed by this reporter.`);
}

function parseFlags(argv) {
  return {
    json: argv.includes('--json'),
    all: argv.includes('--all'),
    help: argv.includes('--help') || argv.includes('-h') || argv.includes('help'),
  };
}

function asNumber(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return asNumber(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  });
}

function qty(value) {
  const n = asNumber(value);
  if (Math.abs(n) >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 8 });
  return n.toLocaleString('en-US', { maximumFractionDigits: 12 });
}

async function getUsdPrice(client, currency) {
  if (currency === 'USD') return { price: 1, source: 'cash' };

  const stablePar = new Set(['USDC', 'USDT']);
  const productId = `${currency}-USD`;
  try {
    const product = await client.getProduct(productId);
    const price = asNumber(product.price || product.mid_market_price || product.best_bid_price || product.best_ask_price);
    if (price > 0) {
      return { price, source: product.product_id || productId };
    }
  } catch (err) {
    if (!(err instanceof CoinbaseApiError && (err.statusCode === 400 || err.statusCode === 404))) {
      throw err;
    }
  }

  if (stablePar.has(currency)) return { price: 1, source: 'stablecoin-parity-fallback' };
  return { price: null, source: 'no-usd-product' };
}

async function buildReport({ includeAll = false } = {}) {
  const client = createClient();
  const accountsBody = await client.listAccounts();
  const accounts = Array.isArray(accountsBody.accounts) ? accountsBody.accounts : [];
  const rows = [];

  for (const account of accounts) {
    const currency = account.currency || 'UNKNOWN';
    const available = asNumber(account.available_balance?.value);
    const hold = asNumber(account.hold?.value);
    const total = available + hold;
    if (!includeAll && total === 0) continue;

    const quote = await getUsdPrice(client, currency);
    const valueUsd = quote.price === null ? null : total * quote.price;
    rows.push({
      currency,
      accountName: account.name || account.uuid || currency,
      available,
      hold,
      total,
      priceUsd: quote.price,
      priceSource: quote.source,
      valueUsd,
    });
  }

  rows.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
  const totalUsd = rows.reduce((sum, row) => sum + (row.valueUsd ?? 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    accountCount: accounts.length,
    reportedCount: rows.length,
    totalUsd,
    rows,
  };
}

function printTable(report) {
  console.log(`Portfolio report ${report.generatedAt}`);
  console.log(`Accounts: ${report.reportedCount}/${report.accountCount} shown`);
  console.log('');
  console.log('CUR      AVAILABLE          HOLD       PRICE_USD        VALUE_USD   SOURCE');
  console.log('-------  -----------------  ---------  ---------------  ----------  -------------------------');
  for (const row of report.rows) {
    const price = row.priceUsd === null ? 'n/a' : money(row.priceUsd);
    const value = row.valueUsd === null ? 'n/a' : money(row.valueUsd);
    console.log([
      row.currency.padEnd(7),
      qty(row.available).padStart(17),
      qty(row.hold).padStart(9),
      price.padStart(15),
      value.padStart(10),
      row.priceSource,
    ].join('  '));
  }
  console.log('');
  console.log(`Approx total USD: ${money(report.totalUsd)}`);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    usage();
    return;
  }

  const report = await buildReport({ includeAll: flags.all });
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTable(report);
  }
}

if (require.main === module) {
  main().catch((err) => {
    if (err instanceof CoinbaseApiError) {
      console.error(`Coinbase API error (${err.statusCode}) on ${err.requestPath}:`);
      console.error(String(err.bodyText || err.message).trim());
    } else {
      console.error(err?.stack || err?.message || String(err));
    }
    process.exitCode = 1;
  });
}

module.exports = { buildReport };
