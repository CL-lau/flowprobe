import { digest } from '../../packages/core/src/hash.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReplayCache } from '../../packages/cache/src/index.js';
import { compile, defaultProjects } from '../../packages/compiler/src/index.js';
import type { AttemptResult, Action } from '../../packages/protocol/src/index.js';
const compiled = compile({
  apiVersion: 'flowprobe/v1',
  kind: 'TestCase',
  id: 'intent',
  owner: 'test',
  requirements: ['R'],
  steps: [
    {
      id: 's',
      action: {
        type: 'intent',
        text: 'open',
        scope: { component: 'test' },
        strategy: ['approved-replay'],
        effect: 'none',
      },
      verifies: ['v'],
    },
  ],
  assertions: [{ id: 'v', after: 's', type: 'url', expected: '/' }],
});
const identity = {
  sourceDigest: compiled.sourceDigest,
  pluginDigest: 'plugin1',
  project: defaultProjects[0]!,
  baseUrl: 'http://localhost',
  browserVersion: '1',
};
const templates: Record<string, Action[]> = {
  s: [{ type: 'navigate', path: '/', effect: 'none' }],
};
const result = (): AttemptResult => ({
  caseId: 'intent',
  project: 'chromium',
  attemptId: 'a',
  outcome: 'passed',
  startedAt: '2026-11-07T00:00:00Z',
  durationMs: 1,
  completedSteps: ['s'],
  evidence: [
    {
      id: 'e',
      attemptId: 'a',
      source: 'assertion:v',
      collectedAt: '2026-11-07T00:00:01Z',
      contentHash: digest({ actual: '/' }),
      value: { actual: '/' },
    },
  ],
  assertions: [
    {
      assertionId: 'v',
      status: 'passed',
      evidenceIds: ['e'],
      expected: '/',
      actual: '/',
      evaluatorVersion: '1',
      durationMs: 1,
    },
  ],
  errors: [],
  cleanupSucceeded: true,
  artifacts: [],
  repaired: false,
});
test('verified cache requires explicit promotion and matches all compatibility dimensions', async () => {
  const cache = new ReplayCache({
    directory: await mkdtemp(join(tmpdir(), 'fp-cache-')),
    appIdentity: 'test',
    buildId: '1',
  });
  const entry = await cache.record(identity, compiled, result(), templates);
  assert.equal(entry.state, 'validated');
  assert.equal(await cache.lookup(identity), undefined);
  await cache.promote(entry.id, 'reviewer');
  assert.equal((await cache.lookup(identity))?.id, entry.id);
  assert.equal(await cache.lookup({ ...identity, browserVersion: '2' }), undefined);
  assert.equal(await cache.lookup({ ...identity, pluginDigest: 'changed' }), undefined);
  const newBuild = new ReplayCache({ ...cache.config, buildId: '2' });
  assert.equal(await newBuild.lookup(identity), undefined);
  await cache.invalidate(entry.id, 'UI changed');
  assert.equal(await cache.lookup(identity), undefined);
});
test('claimed success with missing or failed verification cannot be promoted', async () => {
  const cache = new ReplayCache({
    directory: await mkdtemp(join(tmpdir(), 'fp-cache-')),
    appIdentity: 'test',
    buildId: '1',
  });
  for (const mutate of [
    (r: AttemptResult) => (r.assertions = []),
    (r: AttemptResult) => (r.assertions[0]!.status = 'failed'),
    (r: AttemptResult) => (r.cleanupSucceeded = false),
  ]) {
    const attempt = result();
    mutate(attempt);
    const entry = await cache.record(identity, compiled, attempt, templates);
    assert.equal(entry.state, 'candidate');
    await assert.rejects(cache.promote(entry.id, 'reviewer'));
  }
});
