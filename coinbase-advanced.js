#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { sign } = require('jsonwebtoken');

const API_HOST = process.env.COINBASE_API_HOST || 'api.coinbase.com';
const DEFAULT_CREDENTIAL_FILE = process.env.COINBASE_API_KEY_FILE || path.join(process.env.HOME, '.cdp', 'cdp_api_key.json');

class CoinbaseApiError extends Error {
  constructor(statusCode, bodyText, requestPath) {
    const message = typeof bodyText === 'string' && bodyText.trim()
      ? bodyText.trim()
      : `HTTP ${statusCode} from ${requestPath}`;
    super(message);
    this.name = 'CoinbaseApiError';
    this.statusCode = statusCode;
    this.requestPath = requestPath;
    this.bodyText = bodyText;
  }
}

function normalizePem(value) {
  return String(value).replace(/\\n/g, '\n').trim();
}

function loadCredentials() {
  const envName = process.env.COINBASE_API_KEY_NAME;
  const envSecret = process.env.COINBASE_API_KEY_SECRET;
  if (envName && envSecret) {
    return {
      keyName: envName,
      keySecret: normalizePem(envSecret),
      source: 'environment',
    };
  }

  if (!fs.existsSync(DEFAULT_CREDENTIAL_FILE)) {
    throw new Error(`Credential file not found: ${DEFAULT_CREDENTIAL_FILE}`);
  }

  const raw = JSON.parse(fs.readFileSync(DEFAULT_CREDENTIAL_FILE, 'utf8'));
  const keyName = raw.name || raw.id;
  const keySecret = raw.privateKey || raw.secret;

  if (!keyName) {
    throw new Error(`Missing key name in credential file: ${DEFAULT_CREDENTIAL_FILE}`);
  }
  if (!keySecret) {
    throw new Error(`Missing key secret/privateKey in credential file: ${DEFAULT_CREDENTIAL_FILE}`);
  }

  return {
    keyName,
    keySecret: normalizePem(keySecret),
    source: DEFAULT_CREDENTIAL_FILE,
  };
}

function toBrokeragePath(requestPath) {
  const clean = String(requestPath || '').trim();
  if (!clean) throw new Error('Missing Coinbase request path');
  if (clean.startsWith('/api/v3/brokerage/')) return clean;
  if (clean.startsWith('api/v3/brokerage/')) return `/${clean}`;
  return `/api/v3/brokerage/${clean.replace(/^\/+/, '')}`;
}

function appendQuery(requestPath, query) {
  if (!query || Object.keys(query).length === 0) return requestPath;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  const queryText = params.toString();
  return queryText ? `${requestPath}${requestPath.includes('?') ? '&' : '?'}${queryText}` : requestPath;
}

function buildJwt({ method, requestPath, keyName, keySecret }) {
  const now = Math.floor(Date.now() / 1000);
  const uri = `${method.toUpperCase()} ${API_HOST}${requestPath}`;

  return sign(
    {
      iss: 'coinbase-cloud',
      sub: keyName,
      nbf: now,
      exp: now + 120,
      uri,
    },
    keySecret,
    {
      algorithm: 'ES256',
      header: {
        kid: keyName,
        nonce: crypto.randomBytes(16).toString('hex'),
      },
    },
  );
}

function parseMaybeJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function request({ method = 'GET', requestPath, query, body, credentials = loadCredentials(), retries = 3, retryDelay = 1000 }) {
  const pathWithQuery = appendQuery(toBrokeragePath(requestPath), query);
  const token = buildJwt({
    method,
    requestPath: pathWithQuery,
    keyName: credentials.keyName,
    keySecret: credentials.keySecret,
  });
  const payload = body === undefined ? undefined : JSON.stringify(body);

  function attempt(attemptNum) {
    return new Promise((resolve, reject) => {
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };
      if (payload !== undefined) {
        headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = https.request(
        {
          hostname: API_HOST,
          path: pathWithQuery,
          method: method.toUpperCase(),
          headers,
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => {
            const parsed = parseMaybeJson(raw);
            const response = { statusCode: res.statusCode, headers: res.headers, body: parsed, requestPath: pathWithQuery };
            
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(response);
            } else if (res.statusCode === 429 && attemptNum < retries) {
              // Rate limited - exponential backoff
              const delay = retryDelay * Math.pow(2, attemptNum - 1);
              console.warn(`⚠️ Rate limited (429), retrying in ${delay}ms... (attempt ${attemptNum}/${retries})`);
              setTimeout(() => attempt(attemptNum + 1).then(resolve).catch(reject), delay);
            } else {
              reject(new CoinbaseApiError(res.statusCode, raw, pathWithQuery));
            }
          });
        },
      );

      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  return attempt(1);
}

function createClient(credentials = loadCredentials()) {
  return {
    credentialsSource: credentials.source,
    request: (args) => request({ ...args, credentials }),
    listAccounts: () => request({ method: 'GET', requestPath: 'accounts', credentials }).then((r) => r.body),
    getProduct: (productId) => request({ method: 'GET', requestPath: `products/${productId}`, credentials }).then((r) => r.body),
    previewOrder: (body) => request({ method: 'POST', requestPath: 'orders/preview', body, credentials }).then((r) => r.body),
    createOrder: (body) => request({ method: 'POST', requestPath: 'orders', body, credentials }).then((r) => r.body),
    getOrder: (orderId) => request({ method: 'GET', requestPath: `orders/historical/${orderId}`, credentials }).then((r) => r.body),
    getProducts: () => request({ method: 'GET', requestPath: 'products', credentials }).then((r) => r.body),
  };
}

// PERP/ETF/Index exclusion lists — assets that look like spot but are derivatives or synthetic
const PERP_EXCLUDE = new Set([
  // Perpetual futures products (Coinbase International)
  // Advanced Trade doesn't list perps on main endpoint, but just in case
]);

const ETF_EXCLUDE = new Set([
  // Leveraged ETFs / synthetic tokens (if any appear on spot)
  'BTC2X', 'BTC3X', 'ETH2X', 'ETH3X', 'BTCBEAR', 'ETHBEAR', 'BTCBULL', 'ETHBULL',
  'BTCUP', 'BTCDOWN', 'ETHUP', 'ETHDOWN', // Binance-style leveraged tokens
  'INDEX', 'DEFIINDX', // Index tokens
]);

const INDEX_EXCLUDE = new Set([
  // Explicit index products
  'CCI30', 'DEFI10', 'BLOXROUTE', // Example index tokens
]);

async function buildMinOrderQtyMap(client = null) {
  const c = client || createClient();
  const resp = await c.getProducts();
  const products = resp?.products || [];
  
  const map = {};
  for (const p of products) {
    // Only online USD pairs
    if (p.status !== 'online' || !p.product_id?.endsWith('-USD')) continue;
    
    // Extract base currency from product_id (e.g., "BTC-USD" -> "BTC")
    const base = p.product_id.split('-')[0];
    const inc = p.base_increment;
    
    if (!base || !inc) continue;
    
    // Skip perps, ETFs, indexes
    if (PERP_EXCLUDE.has(base) || ETF_EXCLUDE.has(base) || INDEX_EXCLUDE.has(base)) continue;
    
    // Use base_increment as minimum order quantity
    map[base] = parseFloat(inc);
  }
  
  return map;
}

module.exports = {
  API_HOST,
  CoinbaseApiError,
  appendQuery,
  buildJwt,
  createClient,
  loadCredentials,
  request,
  toBrokeragePath,
  PERP_EXCLUDE,
  ETF_EXCLUDE,
  INDEX_EXCLUDE,
  buildMinOrderQtyMap,
};
