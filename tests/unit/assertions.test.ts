import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { evaluateAssertion } from '../../packages/assertions/src/index.js';
import { EvidenceStore } from '../../packages/storage/src/index.js';

test('polling preserves a real business mismatch when subsequent reads time out', async () => {
  let calls = 0;
  const page = {
    url: () => 'http://localhost/orders',
    request: {
      async get() {
        if (++calls > 1) throw new Error('transport deadline exceeded');
        return {
          status: () => 200,
          text: async () => '{"amountMinor":1}',
          dispose: async () => {},
        };
      },
    },
  } as unknown as Page;
  const store = new EvidenceStore(
    await mkdtemp(join(tmpdir(), 'fp-poll-')),
    'run',
    'case',
    'attempt',
  );
  const result = await evaluateAssertion(
    {
      id: 'amount',
      after: 'submit',
      type: 'api',
      path: '/orders',
      required: true,
      timeoutMs: 220,
      expected: { status: 200, fields: { amountMinor: 10000 } },
    },
    page,
    'http://localhost',
    store,
    new AbortController().signal,
  );
  assert.ok(calls > 1);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.actual, { status: 200, body: { amountMinor: 1 } });
  assert.match(result.message ?? '', /transport deadline/);
});
