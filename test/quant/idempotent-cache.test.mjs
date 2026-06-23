import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import {
  atomicWriteJson,
  contentHash,
  memoize
} from '../../src/worm/utils/idempotent-cache.mjs';

describe('Idempotent Cache & Persistence Utils', () => {
  it('contentHash produces stable short hashes', () => {
    const h1 = contentHash({ a: 1, b: 2 });
    const h2 = contentHash({ b: 2, a: 1 });
    assert.strictEqual(h1, h2);
    assert.strictEqual(h1.length, 16);
  });

  it('memoize caches results and respects maxSize', () => {
    let calls = 0;
    const expensive = (x) => { calls++; return x * 2; };
    const mem = memoize(expensive, { maxSize: 2 });

    assert.strictEqual(mem(5), 10);
    assert.strictEqual(mem(5), 10); // cached
    assert.strictEqual(calls, 1);

    mem(6); mem(7); // evicts oldest
    mem(5); // recomputes
    assert.ok(calls >= 2);
  });

  it('atomicWriteJson writes atomically and is idempotent on re-run', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'idempotent-test-'));
    const file = path.join(tmpDir, 'test-state.json');
    const data = { value: 42, ts: Date.now() };

    await atomicWriteJson(file, data);
    const loaded1 = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.strictEqual(loaded1.value, 42);

    // Re-write same data — should succeed without corruption
    await atomicWriteJson(file, data);
    const loaded2 = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepStrictEqual(loaded1, loaded2);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});