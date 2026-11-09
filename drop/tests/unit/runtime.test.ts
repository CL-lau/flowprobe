import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeFingerprint } from '../../packages/core/src/runtime.js';

test('dependency-lock changes invalidate runtime compatibility without depending on absolute paths', async () => {
  const a = await mkdtemp(join(tmpdir(), 'fp-lock-a-'));
  const b = await mkdtemp(join(tmpdir(), 'fp-lock-b-'));
  await writeFile(join(a, 'package-lock.json'), '{"version":1}');
  await writeFile(join(b, 'package-lock.json'), '{"version":1}');
  assert.equal(runtimeFingerprint(a), runtimeFingerprint(b));
  await writeFile(join(b, 'package-lock.json'), '{"version":2}');
  assert.notEqual(runtimeFingerprint(a), runtimeFingerprint(b));
});
