// Lifted from robinhood-worm.js — Python array scissor.
// Full shared imports cloned. DCE later.

import dotenv from 'dotenv';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import os from 'os';
import { fileURLToPath } from 'url';
import { fork } from 'child_process';

export async function loadLivePortfolioSnapshot(api) {
  const cashBalance = await api.getBalance();
  const holdings = await api.getHoldings();
  const holdingDetails = buildHoldingDetails(holdings);
  return { cashBalance, holdings, holdingDetails };
}
