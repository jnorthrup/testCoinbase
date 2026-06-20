import fs from 'fs';
import path from 'path';
import { MIN_ORDER_QTY_MAP, minIncrementMap } from '../config/trading-config.mjs';

function getGenomicParam(genome, key, symbol) {
  if (symbol && genome.overrides && genome.overrides[symbol] && genome.overrides[symbol][key] !== undefined) {
    return genome.overrides[symbol][key];
  }
  return genome[key];
}

function roundQty(sym, qty, incrementMap = minIncrementMap) {
  const step = incrementMap[sym] || 0.00000001;
  if (typeof qty !== 'number' || Number.isNaN(qty) || qty < (step / 10)) return '0.0';

  const rounded = Math.floor(qty / step) * step;
  let decimalPlaces = 0;
  if (step < 1) decimalPlaces = Math.round(-Math.log10(step));

  let str = rounded.toFixed(Math.min(18, Math.max(0, decimalPlaces)));
  str = str.replace(/(\.\d*[1-9])0+$/, '$1');
  str = str.replace(/\.0+$/, '');
  return Number(str) < (step / 10) ? '0.0' : str;
}

function checkMinTrade(usdValue) {
  return usdValue >= 0.25;
}

function checkMinQuantity(symbol, qty, minOrderQtyMap = MIN_ORDER_QTY_MAP) {
  const minQty = minOrderQtyMap[symbol];
  if (minQty && parseFloat(qty) < minQty) return false;
  return true;
}

function appendTradeHistory(tradeRecord, tradeHistoryFile = path.join(process.cwd(), 'trade_history.log')) {
  if (!tradeRecord.timestamp) tradeRecord.timestamp = new Date().toISOString();
  fs.appendFile(tradeHistoryFile, `${JSON.stringify(tradeRecord)}\n`, (err) => {
    if (err) console.error('Error appending trade history:', err);
  });
}

function logTrade({ asset, side, quantity, price, clientOrderId, note = '', grossValue = null, totalFees = null, settledValue = null }, tradeHistoryFile) {
  try {
    const quantityNum = parseFloat(quantity);
    const priceNum = parseFloat(price);
    if (Number.isNaN(quantityNum) || Number.isNaN(priceNum) || priceNum <= 0) {
      console.error(`Error logging trade: Invalid numeric values. Qty: ${quantity}, Price: ${price}`);
      return;
    }
    const totalValue = (quantityNum * priceNum).toFixed(2);
    const grossValueNum = parseOptionalNumber(grossValue) ?? (quantityNum * priceNum);
    const totalFeesNum = parseOptionalNumber(totalFees) ?? 0;
    const settledValueNum = parseOptionalNumber(settledValue) ?? Math.max(0, grossValueNum - totalFeesNum);
    appendTradeHistory({
      asset,
      side: side.toUpperCase(),
      orderType: 'market',
      quantity,
      effectivePrice: price,
      totalValue,
      grossValue: grossValueNum.toFixed(8),
      totalFees: totalFeesNum.toFixed(8),
      settledValue: settledValueNum.toFixed(8),
      clientOrderId,
      extra: { note },
    }, tradeHistoryFile);
  } catch (error) {
    console.error(`Error logging trade for ${asset}:`, error);
  }
}

function parseOptionalNumber(value) {
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : null;
}

function getEffectivePriceFromResp(resp, fallbackPrice) {
  const priceStr = resp?.average_price || resp?.executions?.[0]?.effective_price || resp?.price || fallbackPrice?.toString();
  if (priceStr === undefined || priceStr === null) return null;
  const priceNum = parseFloat(priceStr);
  return !Number.isNaN(priceNum) && priceNum > 0 ? priceNum : null;
}

function getFilledQuantityFromResp(resp, fallbackQuantity = null) {
  const filledQty = parseOptionalNumber(resp?.filled_asset_quantity ?? resp?.filled_quantity);
  if (filledQty !== null && filledQty > 0) return filledQty;
  const fallbackQty = parseOptionalNumber(fallbackQuantity);
  return fallbackQty !== null && fallbackQty > 0 ? fallbackQty : 0;
}

function getTotalFeesFromResp(resp) {
  const fees = parseOptionalNumber(resp?.total_fees ?? resp?.fees ?? resp?.raw?.order?.total_fees ?? resp?.raw?.total_fees);
  return fees !== null && fees >= 0 ? fees : 0;
}

function getGrossValueFromResp(resp, fallbackQuantity = null, fallbackPrice = null) {
  const filledValue = parseOptionalNumber(resp?.filled_value ?? resp?.quote_value ?? resp?.raw?.order?.filled_value ?? resp?.raw?.filled_value);
  if (filledValue !== null && filledValue >= 0) return filledValue;
  const qty = getFilledQuantityFromResp(resp, fallbackQuantity);
  const price = getEffectivePriceFromResp(resp, fallbackPrice);
  return qty > 0 && price !== null && price > 0 ? qty * price : 0;
}

function getSettledValueFromResp(resp, fallbackQuantity = null, fallbackPrice = null) {
  const netValue = parseOptionalNumber(resp?.total_value_after_fees ?? resp?.net_value ?? resp?.raw?.order?.total_value_after_fees ?? resp?.raw?.total_value_after_fees);
  if (netValue !== null && netValue >= 0) return netValue;
  const grossValue = getGrossValueFromResp(resp, fallbackQuantity, fallbackPrice);
  const fees = getTotalFeesFromResp(resp);
  return grossValue > 0 ? Math.max(0, grossValue - fees) : 0;
}

async function verifyOrder(api, orderId, symbol, maxRetries = 6, delayMs = 1500) {
  if (!api || !orderId) return null;
  console.log(`🔍 [Verification] Starting status polling for order: ${orderId} (${symbol})`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const order = await api.getOrderStatus(orderId);
      if (!order) {
        console.warn(`⚠️ [Verification] Poll attempt ${attempt}/${maxRetries} returned empty response.`);
      } else {
        const state = order.state?.toLowerCase();
        console.log(`   ⏱️ [Verification] Attempt ${attempt}/${maxRetries}: Order State = '${state}'`);
        if (state === 'filled') return order;
        if (['rejected', 'cancelled', 'failed', 'expired'].includes(state)) return null;
      }
    } catch (err) {
      console.error(`   ⚠️ [Verification] Poll attempt ${attempt} error for order ${orderId}:`, err.message);
    }

    if (attempt < maxRetries) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return null;
}

export {
  appendTradeHistory,
  checkMinQuantity,
  checkMinTrade,
  getEffectivePriceFromResp,
  getFilledQuantityFromResp,
  getGenomicParam,
  getGrossValueFromResp,
  getSettledValueFromResp,
  getTotalFeesFromResp,
  logTrade,
  roundQty,
  verifyOrder,
};
