#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CoinbaseApiError, createClient } = require('./coinbase-advanced');

function usage() {
  console.log(`Coinbase guarded agent trade bed\n\nUsage:\n  node agent-trader.js preview-sell BTC 10\n  node agent-trader.js preview-buy BTC 10\n  node agent-trader.js plan ./plan.json\n  ALLOW_LIVE_TRADE=1 node agent-trader.js place-sell BTC 10 --yes\n\nPlan JSON shape:\n  {\n    "mode": "preview",\n    "side": "SELL",\n    "productId": "BTC-USD",\n    "usdAmount": "10",\n    "maxUsd": "25"\n  }\n\nSafety rails:\n  - default mode previews only\n  - live placement requires both --yes and ALLOW_LIVE_TRADE=1\n  - every preview/place writes a JSON run artifact under ./runs/\n  - no credential material is written to run artifacts`);
}

function asNumber(value, fieldName = 'number') {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid ${fieldName}: ${value}`);
  return n;
}

function decimalPlaces(value) {
  const text = String(value || '1');
  if (!text.includes('.')) return 0;
  return text.replace(/0+$/, '').split('.')[1]?.length || 0;
}

function floorToIncrement(value, increment) {
  const places = decimalPlaces(increment);
  const scale = 10 ** places;
  const incUnits = Math.max(1, Math.round(asNumber(increment, 'increment') * scale));
  const rawUnits = Math.floor(asNumber(value, 'value') * scale);
  const flooredUnits = Math.floor(rawUnits / incUnits) * incUnits;
  return (flooredUnits / scale).toFixed(places);
}

function toProductId(assetOrProduct) {
  const clean = String(assetOrProduct || '').trim().toUpperCase();
  if (!clean) throw new Error('Missing asset/product');
  return clean.includes('-') ? clean : `${clean}-USD`;
}

function splitProduct(productId) {
  const parts = String(productId).split('-');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`Expected product like BTC-USD, got ${productId}`);
  return { base: parts[0], quote: parts[1] };
}

function parseFlags(args) {
  const flags = new Set(args.filter((arg) => arg.startsWith('--')));
  return {
    yes: flags.has('--yes'),
    help: flags.has('--help') || flags.has('-h'),
  };
}

function parseCommand(argv) {
  const [command, ...args] = argv;
  const flags = parseFlags(argv);
  if (!command || command === 'help' || flags.help) return { help: true };

  if (command === 'plan') {
    const [planPathOrJson] = args;
    if (!planPathOrJson) throw new Error('Missing plan file path or JSON string');
    const raw = fs.existsSync(planPathOrJson) ? fs.readFileSync(planPathOrJson, 'utf8') : planPathOrJson;
    return { ...JSON.parse(raw), confirm: flags.yes };
  }

  const match = command.match(/^(preview|place)-(buy|sell)$/);
  if (!match) throw new Error(`Unknown command: ${command}`);
  const [, mode, side] = match;
  const [assetOrProduct, usdAmount] = args.filter((arg) => !arg.startsWith('--'));
  if (!assetOrProduct || !usdAmount) throw new Error(`Usage: node agent-trader.js ${command} BTC 10`);
  return {
    mode,
    side: side.toUpperCase(),
    productId: toProductId(assetOrProduct),
    usdAmount,
    maxUsd: process.env.AGENT_MAX_USD || '25',
    confirm: flags.yes,
  };
}

function validatePlan(plan) {
  const normalized = {
    mode: String(plan.mode || 'preview').toLowerCase(),
    side: String(plan.side || '').toUpperCase(),
    productId: toProductId(plan.productId || plan.product || plan.asset),
    usdAmount: String(plan.usdAmount || plan.quoteUsd || plan.amountUsd || ''),
    maxUsd: String(plan.maxUsd || process.env.AGENT_MAX_USD || '25'),
    confirm: Boolean(plan.confirm),
  };

  if (!['preview', 'place'].includes(normalized.mode)) throw new Error(`Unsupported mode: ${normalized.mode}`);
  if (!['BUY', 'SELL'].includes(normalized.side)) throw new Error(`Unsupported side: ${normalized.side}`);
  if (!normalized.usdAmount) throw new Error('Missing usdAmount');

  const usdAmount = asNumber(normalized.usdAmount, 'usdAmount');
  const maxUsd = asNumber(normalized.maxUsd, 'maxUsd');
  if (usdAmount <= 0) throw new Error('usdAmount must be positive');
  if (usdAmount > maxUsd) throw new Error(`Plan exceeds maxUsd guard: ${usdAmount} > ${maxUsd}`);
  if (normalized.mode === 'place' && (!normalized.confirm || process.env.ALLOW_LIVE_TRADE !== '1')) {
    throw new Error('Live placement requires --yes and ALLOW_LIVE_TRADE=1');
  }

  return normalized;
}

function accountAvailable(accountsBody, currency) {
  const accounts = Array.isArray(accountsBody.accounts) ? accountsBody.accounts : [];
  const account = accounts.find((item) => item.currency === currency);
  return account ? asNumber(account.available_balance?.value || 0, `${currency} available`) : 0;
}

function selectProductPrice(product) {
  const price = asNumber(product.price || product.mid_market_price || product.best_bid_price || product.best_ask_price, 'product price');
  if (price <= 0) throw new Error(`Product ${product.product_id} has no usable price`);
  return price;
}

function buildOrderPreviewRequest(plan, product, accountsBody) {
  const { base, quote } = splitProduct(plan.productId);
  const price = selectProductPrice(product);
  const usdAmount = asNumber(plan.usdAmount, 'usdAmount');
  const quoteIncrement = product.quote_increment || '0.01';
  const baseIncrement = product.base_increment || '0.00000001';

  const marketMarketIoc = {};
  if (plan.side === 'BUY') {
    const quoteSize = floorToIncrement(usdAmount, quoteIncrement);
    if (asNumber(quoteSize, 'quoteSize') <= 0) throw new Error('quoteSize became zero after increment rounding');
    const availableQuote = accountAvailable(accountsBody, quote);
    if (availableQuote < asNumber(quoteSize, 'quoteSize')) {
      throw new Error(`Insufficient ${quote}: need ${quoteSize}, available ${availableQuote}`);
    }
    marketMarketIoc.quoteSize = quoteSize;
  } else {
    const rawBaseSize = usdAmount / price;
    const baseSize = floorToIncrement(rawBaseSize, baseIncrement);
    if (asNumber(baseSize, 'baseSize') <= 0) throw new Error('baseSize became zero after increment rounding');
    if (asNumber(baseSize, 'baseSize') < asNumber(product.base_min_size || baseIncrement, 'base_min_size')) {
      throw new Error(`baseSize ${baseSize} is below Coinbase minimum ${product.base_min_size || baseIncrement}`);
    }
    const availableBase = accountAvailable(accountsBody, base);
    if (availableBase < asNumber(baseSize, 'baseSize')) {
      throw new Error(`Insufficient ${base}: need ${baseSize}, available ${availableBase}`);
    }
    marketMarketIoc.baseSize = baseSize;
  }

  return {
    productId: plan.productId,
    side: plan.side,
    orderConfiguration: { marketMarketIoc },
  };
}

function summarizePreview(preview) {
  return {
    previewId: preview.preview_id || preview.previewId || null,
    quoteSize: preview.quote_size || preview.quoteSize || null,
    baseSize: preview.base_size || preview.baseSize || null,
    orderTotal: preview.order_total || preview.orderTotal || null,
    commissionTotal: preview.commission_total || preview.commissionTotal || null,
    estimatedAverageFilledPrice: preview.est_average_filled_price || preview.estAverageFilledPrice || null,
    errors: preview.errs || preview.errors || [],
    warnings: preview.warning || preview.warnings || [],
  };
}

function writeRunArtifact(run) {
  const dir = path.join(process.cwd(), 'runs');
  fs.mkdirSync(dir, { recursive: true });
  const safeTime = run.generatedAt.replace(/[:.]/g, '-');
  const safeProduct = run.plan.productId.replace(/[^A-Z0-9-]/g, '_');
  const filePath = path.join(dir, `${safeTime}-${run.plan.mode}-${run.plan.side.toLowerCase()}-${safeProduct}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(run, null, 2)}\n`);
  return filePath;
}

async function executePlan(inputPlan) {
  const plan = validatePlan(inputPlan);
  const client = createClient();
  const [product, accountsBody] = await Promise.all([
    client.getProduct(plan.productId),
    client.listAccounts(),
  ]);

  const previewRequest = buildOrderPreviewRequest(plan, product, accountsBody);
  const preview = await client.previewOrder(previewRequest);
  const previewSummary = summarizePreview(preview);

  const run = {
    generatedAt: new Date().toISOString(),
    plan,
    product: {
      productId: product.product_id,
      price: product.price,
      baseIncrement: product.base_increment,
      quoteIncrement: product.quote_increment,
      baseMinSize: product.base_min_size,
      quoteMinSize: product.quote_min_size,
      status: product.status,
      tradingDisabled: product.trading_disabled,
    },
    previewRequest,
    preview,
    previewSummary,
    liveOrderRequest: null,
    liveOrderResponse: null,
    liveOrderStatus: null,
  };

  if (plan.mode === 'place') {
    const previewId = previewSummary.previewId;
    if (!previewId) throw new Error('Preview did not return preview_id; refusing to place live order');
    const liveOrderRequest = {
      ...previewRequest,
      clientOrderId: crypto.randomUUID(),
      previewId,
    };
    const liveOrderResponse = await client.createOrder(liveOrderRequest);
    run.liveOrderRequest = liveOrderRequest;
    run.liveOrderResponse = liveOrderResponse;

    const orderId = liveOrderResponse.success_response?.order_id || liveOrderResponse.successResponse?.orderId;
    if (orderId) {
      run.liveOrderStatus = await client.getOrder(orderId);
    }
  }

  const artifact = writeRunArtifact(run);
  return { run, artifact };
}

function printResult(result) {
  const { run, artifact } = result;
  console.log(`Agent trade ${run.plan.mode} ${run.plan.side} ${run.plan.productId}`);
  console.log(`requested USD: ${run.plan.usdAmount}`);
  console.log(`product price: ${run.product.price}`);
  console.log(`preview quote/base: ${run.previewSummary.quoteSize || 'n/a'} / ${run.previewSummary.baseSize || 'n/a'}`);
  console.log(`preview total/fee: ${run.previewSummary.orderTotal || 'n/a'} / ${run.previewSummary.commissionTotal || 'n/a'}`);
  if (run.liveOrderResponse) {
    console.log(`live order: ${JSON.stringify(run.liveOrderResponse.success_response || run.liveOrderResponse.successResponse || run.liveOrderResponse)}`);
    const status = run.liveOrderStatus?.order?.status;
    if (status) console.log(`live status: ${status}`);
  } else {
    console.log('live order: not placed (preview only)');
  }
  console.log(`artifact: ${artifact}`);
}

async function main() {
  const parsed = parseCommand(process.argv.slice(2));
  if (parsed.help) {
    usage();
    return;
  }
  const result = await executePlan(parsed);
  printResult(result);
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

module.exports = { executePlan, validatePlan };
