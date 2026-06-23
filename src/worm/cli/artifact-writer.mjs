// Lifted from robinhood-worm.js — Python array scissor.
// Full shared imports cloned. DCE later.

import fs from 'fs';
import path from 'path';

export function writeWormArtifact(payload, modeLabel = 'preview') {
  const dir = path.join(process.cwd(), 'runs');
  fs.mkdirSync(dir, { recursive: true });
  const safeTime = new Date().toISOString().replace(/[:.]/g, '-');
  const safeProduct = String(payload.productId || 'NONE').replace(/[^A-Z0-9-]/g, '_');
  const safeSide = String(payload.side || 'unknown').toLowerCase();
  const safeMode = String(modeLabel || 'preview').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const filePath = path.join(dir, `${safeTime}-worm-${safeMode}-${safeSide}-${safeProduct}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  return filePath;
}


export function writeWormPreviewArtifact(payload) {
  return writeWormArtifact(payload, 'preview');
}


export function writeWormLiveArtifact(payload) {
  return writeWormArtifact(payload, 'live');
}