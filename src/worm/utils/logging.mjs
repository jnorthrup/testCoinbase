// src/worm/utils/logging.mjs
// Centralized logging utilities

const RESET = '\x1b[0m';
const COLORS = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

export function colorize(text, color) {
  if (!COLORS[color]) return text;
  return `${COLORS[color]}${text}${RESET}`;
}

export function success(text) { return colorize(text, 'green'); }
export function error(text) { return colorize(text, 'red'); }
export function warn(text) { return colorize(text, 'yellow'); }
export function info(text) { return colorize(text, 'cyan'); }
export function bold(text) { return `\x1b[1m${text}${RESET}`; }

export function deviationColor(percent) {
  if (percent > 0) return 'green';
  if (percent < 0) return 'red';
  return 'white';
}

export function formatUSD(value, decimals = 2) {
  const sign = value < 0 ? '-' : '+';
  return `${sign}$${Math.abs(value).toFixed(decimals)}`;
}

export function formatPercent(value, decimals = 2) {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}