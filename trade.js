#!/usr/bin/env node
/**
 * Coinbase Advanced Trade API client
 *
 * - Reads a CDP / Coinbase App API key from ~/.cdp/cdp_api_key.json by default
 * - Generates ES256 JWTs for each request
 * - Supports authenticated REST calls against api.coinbase.com/api/v3/brokerage/*
 *
 * Usage:
 *   node trade.js accounts
 *   node trade.js request GET /api/v3/brokerage/accounts
 *   node trade.js request POST /api/v3/brokerage/orders '{"...": "..."}'
 */

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { sign } = require('jsonwebtoken');

const API_HOST = process.env.COINBASE_API_HOST || 'api.coinbase.com';
const DEFAULT_CREDENTIAL_FILE = process.env.COINBASE_API_KEY_FILE || path.join(process.env.HOME, '.cdp', 'cdp_api_key.json');

class CoinbaseApiError extends Error {
  constructor(statusCode, bodyText, requestPath) {
    const message =
      typeof bodyText === 'string' && bodyText.trim()
        ? bodyText.trim()
        : `HTTP ${statusCode} from ${requestPath}`;
    super(message);
    this.name = 'CoinbaseApiError';
    this.statusCode = statusCode;
    this.requestPath = requestPath;
    this.bodyText = bodyText;
  }
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

  const credentialFile = DEFAULT_CREDENTIAL_FILE;
  if (!fs.existsSync(credentialFile)) {
    throw new Error(`Credential file not found: ${credentialFile}`);
  }

  const raw = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
  const keyName = raw.name || raw.id;
  const keySecret = raw.privateKey || raw.secret;

  if (!keyName) {
    throw new Error(`Missing key name in credential file: ${credentialFile}`);
  }
  if (!keySecret) {
    throw new Error(`Missing key secret/privateKey in credential file: ${credentialFile}`);
  }

  return {
    keyName,
    keySecret: normalizePem(keySecret),
    source: credentialFile,
  };
}

function normalizePem(value) {
  return String(value).replace(/\\n/g, '\n').trim();
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

function request({ method, requestPath, body, keyName, keySecret }) {
  const token = buildJwt({ method, requestPath, keyName, keySecret });
  const payload = body === undefined ? undefined : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: API_HOST,
        path: requestPath,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          const parsed = parseMaybeJson(raw);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
          } else {
            reject(new CoinbaseApiError(res.statusCode, raw, requestPath));
          }
        });
      },
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function printAccounts(response) {
  const accounts = response?.body?.accounts;
  if (!Array.isArray(accounts)) {
    console.log(JSON.stringify(response.body, null, 2));
    return;
  }

  console.log(`Accounts (${accounts.length}):`);
  for (const account of accounts) {
    const balance = account.available_balance?.value ?? '0';
    const currency = account.currency ?? 'UNKNOWN';
    const name = account.name ?? account.uuid;
    console.log(`- ${name} | ${currency} | available ${balance}`);
  }
}

function usage() {
  console.log(`Coinbase Advanced Trade API client\n
Usage:
  node trade.js accounts
  node trade.js request <METHOD> <PATH> [JSON_BODY]\n
Examples:
  node trade.js accounts
  node trade.js request GET /api/v3/brokerage/accounts
  node trade.js request POST /api/v3/brokerage/orders '{"product_id":"BTC-USD", ...}'\n
Environment overrides:
  COINBASE_API_KEY_NAME
  COINBASE_API_KEY_SECRET
  COINBASE_API_KEY_FILE
  COINBASE_API_HOST (default: api.coinbase.com)
`);
}

async function main() {
  const [command = 'accounts', ...args] = process.argv.slice(2);
  const credentials = loadCredentials();

  console.log('=== Coinbase Advanced Trade Client ===');
  console.log(`Credentials: ${credentials.source}`);
  console.log(`Key name: ${credentials.keyName}`);
  console.log('');

  if (command === 'help' || command === '--help' || command === '-h') {
    usage();
    return;
  }

  if (command === 'accounts') {
    const response = await request({
      method: 'GET',
      requestPath: '/api/v3/brokerage/accounts',
      keyName: credentials.keyName,
      keySecret: credentials.keySecret,
    });
    printAccounts(response);
    return;
  }

  if (command === 'request') {
    const [method, requestPath, ...bodyParts] = args;
    if (!method || !requestPath) {
      usage();
      process.exitCode = 1;
      return;
    }

    const bodyText = bodyParts.join(' ').trim();
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    const response = await request({
      method,
      requestPath,
      body,
      keyName: credentials.keyName,
      keySecret: credentials.keySecret,
    });
    console.log(JSON.stringify(response.body, null, 2));
    return;
  }

  usage();
  process.exitCode = 1;
}

main().catch((err) => {
  if (err instanceof CoinbaseApiError) {
    console.error(`Coinbase API error (${err.statusCode}) on ${err.requestPath}:`);
    if (typeof err.bodyText === 'string' && err.bodyText.trim()) {
      console.error(err.bodyText.trim());
    } else {
      console.error(err.message);
    }
  } else {
    console.error(err?.stack || err?.message || String(err));
  }
  process.exitCode = 1;
});
