#!/usr/bin/env node
'use strict';

const { CoinbaseApiError, createClient } = require('./coinbase-advanced');

function usage() {
  console.log(`Coinbase asset regime checker\n\nUsage:\n  node regime.js [--json] [--all] [BTC-USD ETH-USD ...]\n\nWhat it does:\n  - fetches product details for specified pairs (or all from accounts)\n  - reports trading regime: online/offline, disabled, restrictions\n  - checks min/max sizes, increments, venue, product type\n\nNo trades are placed.`);
}

function parseFlags(argv) {
  return {
    json: argv.includes('--json'),
    all: argv.includes('--all'),
    help: argv.includes('--help') || argv.includes('-h') || argv.includes('help'),
    products: argv.filter((arg) => !arg.startsWith('--') && !arg.startsWith('-')),
  };
}

function money(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 }) : 'n/a';
}

function qty(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 12 }) : 'n/a';
}

function regimeLabel(product) {
  const labels = [];
  if (product.status !== 'online') labels.push('offline');
  if (product.trading_disabled) labels.push('trading-disabled');
  if (product.cancel_only) labels.push('cancel-only');
  if (product.limit_only) labels.push('limit-only');
  if (product.post_only) labels.push('post-only');
  if (product.auction_mode) labels.push('auction-mode');
  if (product.view_only) labels.push('view-only');
  if (product.is_disabled) labels.push('disabled');
  if (product.is_alpha_testing) labels.push('alpha');
  if (product.new) labels.push('new');
  return labels.length ? labels.join(', ') : 'normal';
}

function regimeSeverity(product) {
  if (product.status !== 'online') return 'BLOCKED';
  if (product.trading_disabled) return 'BLOCKED';
  if (product.cancel_only || product.limit_only || product.post_only) return 'RESTRICTED';
  if (product.auction_mode || product.view_only || product.is_disabled) return 'RESTRICTED';
  return 'OK';
}

async function checkRegime({ products = [], includeAllAccounts = false } = {}) {
  const client = createClient();
  let targetProducts = products;

  if (targetProducts.length === 0) {
    const accountsBody = await client.listAccounts();
    const accounts = Array.isArray(accountsBody.accounts) ? accountsBody.accounts : [];
    const currencies = new Set(
      accounts
        .filter((a) => (includeAllAccounts ? true : (Number(a.available_balance?.value || 0) + Number(a.hold?.value || 0)) > 0))
        .map((a) => a.currency)
        .filter((c) => c && c !== 'USD')
    );
    targetProducts = Array.from(currencies).map((c) => `${c}-USD`);
  }

  const results = [];
  for (const productId of targetProducts) {
    try {
      const product = await client.getProduct(productId);
      const regime = regimeLabel(product);
      const severity = regimeSeverity(product);
      results.push({
        productId: product.product_id || productId,
        displayName: product.display_name || product.product_id || productId,
        baseCurrency: product.base_currency_id || product.base_name,
        quoteCurrency: product.quote_currency_id || product.quote_name,
        price: product.price || product.mid_market_price || product.best_bid_price || product.best_ask_price,
        status: product.status,
        tradingDisabled: product.trading_disabled,
        cancelOnly: product.cancel_only,
        limitOnly: product.limit_only,
        postOnly: product.post_only,
        auctionMode: product.auction_mode,
        viewOnly: product.view_only,
        isDisabled: product.is_disabled,
        productType: product.product_type,
        productVenue: product.product_venue,
        baseIncrement: product.base_increment,
        quoteIncrement: product.quote_increment,
        baseMinSize: product.base_min_size,
        baseMaxSize: product.base_max_size,
        quoteMinSize: product.quote_min_size,
        quoteMaxSize: product.quote_max_size,
        regime,
        severity,
      });
    } catch (err) {
      if (err instanceof CoinbaseApiError) {
        results.push({
          productId,
          error: `HTTP ${err.statusCode}: ${String(err.bodyText || err.message).trim()}`,
          severity: 'ERROR',
        });
      } else {
        results.push({
          productId,
          error: String(err?.message || err),
          severity: 'ERROR',
        });
      }
    }
  }

  return results;
}

function printTable(results) {
  console.log('PRODUCT_ID     REGIME                    SEVERITY  PRICE           BASE_INC  QUOTE_INC  MIN_BASE  MAX_BASE  VENUE  TYPE');
  console.log('-------------  --------------------------  --------  --------------  --------  ---------  --------  --------  -----  ----');
  for (const r of results) {
    if (r.error) {
      console.log(`${(r.productId || '').padEnd(13)}  ${('ERROR: ' + r.error).padEnd(26)}  ${'ERROR'.padEnd(8)}`);
      continue;
    }
    const price = money(r.price);
    console.log([
      (r.productId || '').padEnd(13),
      (r.regime || '').padEnd(26),
      (r.severity || '').padEnd(8),
      price.padStart(14),
      (r.baseIncrement || '').padStart(8),
      (r.quoteIncrement || '').padStart(9),
      qty(r.baseMinSize).padStart(8),
      qty(r.baseMaxSize).padStart(8),
      (r.productVenue || '').padStart(5),
      (r.productType || '').padStart(4),
    ].join('  '));
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    usage();
    return;
  }

  const results = await checkRegime({ products: flags.products, includeAllAccounts: flags.all });
  if (flags.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    printTable(results);
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

module.exports = { checkRegime, regimeLabel, regimeSeverity };
