// Lifted from robinhood-worm.js — Python array scissor.
// Full shared imports cloned. DCE later.

export function parsePreviewOrderArgs(argv = process.argv) {
  const sellIdx = argv.indexOf('--preview-sell');
  const buyIdx = argv.indexOf('--preview-buy');
  const idx = sellIdx !== -1 ? sellIdx : buyIdx;
  if (idx === -1) return null;
  const side = sellIdx !== -1 ? 'SELL' : 'BUY';
  const symbol = String(argv[idx + 1] || '').trim().toUpperCase();
  const usdAmount = Number(argv[idx + 2]);
  if (!symbol || !Number.isFinite(usdAmount) || usdAmount <= 0) {
    throw new Error(`Usage: node robinhood-worm.js ${side === 'SELL' ? '--preview-sell' : '--preview-buy'} BTC 10`);
  }
  return { side, symbol, usdAmount, productId: `${symbol}-USD` };
}


export function parseStrategyPreviewArgs(argv = process.argv) {
  const idx = argv.indexOf('--preview-strategy');
  if (idx === -1) return null;
  const maybeAmount = argv[idx + 1];
  const requestedUsd = (maybeAmount === undefined || String(maybeAmount).startsWith('--')) ? 10 : Number(maybeAmount);
  if (!Number.isFinite(requestedUsd) || requestedUsd <= 0) {
    throw new Error('Usage: node robinhood-worm.js --preview-strategy [usdAmount]');
  }
  return { requestedUsd };
}


export function parseStrategyPlaceArgs(argv = process.argv) {
  const idx = argv.indexOf('--place-strategy');
  if (idx === -1) return null;
  const maybeAmount = argv[idx + 1];
  const requestedUsd = (maybeAmount === undefined || String(maybeAmount).startsWith('--')) ? 10 : Number(maybeAmount);
  if (!Number.isFinite(requestedUsd) || requestedUsd <= 0) {
    throw new Error('Usage: ALLOW_LIVE_TRADE=1 node robinhood-worm.js --place-strategy [usdAmount] --yes');
  }
  return { requestedUsd, confirm: argv.includes('--yes') };
}