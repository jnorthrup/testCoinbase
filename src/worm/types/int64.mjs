// src/worm/types/int64.mjs
// 64-bit integer types using BigInt for precise crypto math
// Prevents float precision loss on large quantities

export class I64 {
  constructor(value = 0n) {
    this._value = typeof value === 'bigint' ? value : BigInt(Math.floor(Number(value) * 1e8));
    this._scale = 8n; // 8 decimal places of precision
  }

  static fromNumber(value) {
    return new I64(BigInt(Math.floor(value * 1e8)));
  }

  static fromBigInt(value) {
    return new I64(value);
  }

  toNumber() {
    return Number(this._value) / 1e8;
  }

  toBigInt() {
    return this._value;
  }

  add(other) {
    const o = other instanceof I64 ? other._value : BigInt(Math.floor(Number(other) * 1e8));
    return new I64(this._value + o);
  }

  sub(other) {
    const o = other instanceof I64 ? other._value : BigInt(Math.floor(Number(other) * 1e8));
    return new I64(this._value - o);
  }

  mul(other) {
    const o = other instanceof I64 ? other._value : BigInt(Math.floor(Number(other) * 1e8));
    return new I64((this._value * o) / this._scale);
  }

  div(other) {
    const o = other instanceof I64 ? other._value : BigInt(Math.floor(Number(other) * 1e8));
    return new I64((this._value * this._scale) / o);
  }

  cmp(other) {
    const o = other instanceof I64 ? other._value : BigInt(Math.floor(Number(other) * 1e8));
    if (this._value < o) return -1;
    if (this._value > o) return 1;
    return 0;
  }

  isZero() { return this._value === 0n; }
  isPositive() { return this._value > 0n; }
  isNegative() { return this._value < 0n; }

  toString() { return this._value.toString(); }
  valueOf() { return this.toNumber(); }
}

// 64-bit unsigned integer
export class U64 {
  constructor(value = 0n) {
    this._value = typeof value === 'bigint' ? value : BigInt(Math.max(0, Math.floor(Number(value) * 1e8)));
    this._scale = 8n;
  }

  static fromNumber(value) {
    return new U64(BigInt(Math.max(0, Math.floor(value * 1e8))));
  }

  static fromBigInt(value) {
    return new U64(value);
  }

  toNumber() {
    return Number(this._value) / 1e8;
  }

  toBigInt() {
    return this._value;
  }

  add(other) {
    const o = other instanceof U64 ? other._value : BigInt(Math.max(0, Math.floor(Number(other) * 1e8)));
    return new U64(this._value + o);
  }

  sub(other) {
    const o = other instanceof U64 ? other._value : BigInt(Math.max(0, Math.floor(Number(other) * 1e8)));
    return new U64(this._value > o ? this._value - o : 0n);
  }

  mul(other) {
    const o = other instanceof U64 ? other._value : BigInt(Math.max(0, Math.floor(Number(other) * 1e8)));
    return new U64((this._value * o) / this._scale);
  }

  div(other) {
    const o = other instanceof U64 ? other._value : BigInt(Math.max(0, Math.floor(Number(other) * 1e8)));
    if (o === 0n) return new U64(0n);
    return new U64((this._value * this._scale) / o);
  }

  isZero() { return this._value === 0n; }

  toString() { return this._value.toString(); }
  valueOf() { return this.toNumber(); }
}

// 64-bit price type (8 decimal places, can be negative for spreads)
export class Price64 {
  constructor(value = 0n) {
    this._value = typeof value === 'bigint' ? value : BigInt(Math.floor(Number(value) * 1e8));
    this._scale = 8n;
  }

  static fromNumber(value) {
    return new Price64(BigInt(Math.floor(value * 1e8)));
  }

  toNumber() {
    return Number(this._value) / 1e8;
  }

  toBigInt() {
    return this._value;
  }

  add(other) {
    const o = other instanceof Price64 ? other._value : BigInt(Math.floor(Number(other) * 1e8));
    return new Price64(this._value + o);
  }

  sub(other) {
    const o = other instanceof Price64 ? other._value : BigInt(Math.floor(Number(other) * 1e8));
    return new Price64(this._value - o);
  }

  mul(other) {
    const o = other instanceof Price64 ? other._value : BigInt(Math.floor(Number(other) * 1e8));
    return new Price64((this._value * o) / this._scale);
  }

  cmp(other) {
    const o = other instanceof Price64 ? other._value : BigInt(Math.floor(Number(other) * 1e8));
    if (this._value < o) return -1;
    if (this._value > o) return 1;
    return 0;
  }

  toString() { return this.toNumber().toFixed(8); }
}

// Tensor for portfolio values (per-symbol 64-bit)
export class PortfolioTensor {
  constructor() {
    this._prices = new Map();    // symbol -> Price64
    this._quantities = new Map(); // symbol -> U64
    this._baselines = new Map();  // symbol -> Price64 (USD value baseline)
    this._lastUpdate = 0n;        // BigInt timestamp
  }

  setPrice(symbol, price) {
    this._prices.set(symbol, Price64.fromNumber(price));
  }

  setQuantity(symbol, quantity) {
    this._quantities.set(symbol, U64.fromNumber(quantity));
  }

  setBaseline(symbol, baselineUsd) {
    this._baselines.set(symbol, Price64.fromNumber(baselineUsd));
  }

  getValue(symbol) {
    const q = this._quantities.get(symbol);
    const p = this._prices.get(symbol);
    if (!q || !p || q.isZero()) return 0;
    return q.mul(p).toNumber();
  }

  getDeviation(symbol) {
    const v = this.getValue(symbol);
    const b = this._baselines.get(symbol);
    if (!b) return 0;
    if (b.toBigInt() === 0n) return 0;
    return (v - b.toNumber()) / b.toNumber();
  }

  getTotalValue() {
    let total = 0;
    for (const [sym] of this._quantities) {
      total += this.getValue(sym);
    }
    return total;
  }

  symbols() {
    return Array.from(this._quantities.keys());
  }

  getQuantity(symbol) {
    return this._quantities.get(symbol);
  }

  getPrice(symbol) {
    return this._prices.get(symbol);
  }

  getBaseline(symbol) {
    return this._baselines.get(symbol);
  }

  clear() {
    this._prices.clear();
    this._quantities.clear();
    this._baselines.clear();
  }
}