import { digest } from '../../packages/core/src/hash.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, createPlan } from '../../packages/compiler/src/index.js';
import { attemptOutcome, evaluateGate } from '../../packages/core/src/verdict.js';
import type { AttemptResult } from '../../packages/protocol/src/index.js';
const compiled = compile({
  apiVersion: 'flowprobe/v1',
  kind: 'TestCase',
  id: 'a',
  owner: 'test',
  requirements: ['R'],
  risk: 'critical',
  steps: [{ id: 's', action: { type: 'navigate', path: '/' } }],
  assertions: [{ id: 'v', after: 's', type: 'url', expected: '/' }],
});
const good = (): AttemptResult => ({
  caseId: 'a',
  project: 'chromium',
  attemptId: 'x',
  outcome: 'passed',
  startedAt: new Date().toISOString(),
  durationMs: 1,
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
  completedSteps: ['s'],
  evidence: [
    {
      id: 'e',
      attemptId: 'x',
      source: 'assertion:v',
      collectedAt: new Date().toISOString(),
      contentHash: digest({ actual: '/' }),
      value: { actual: '/' },
    },
  ],
  errors: [],
  cleanupSucceeded: true,
  artifacts: [],
  repaired: false,
});
test('success requires all required assertions and current attempt evidence', () => {
  assert.equal(attemptOutcome(compiled.test, good()), 'passed');
  for (const mutation of [
    (r: AttemptResult) => (r.assertions = []),
    (r: AttemptResult) => (r.evidence = []),
    (r: AttemptResult) => (r.completedSteps = []),
    (r: AttemptResult) => (r.cleanupSucceeded = false),
    (r: AttemptResult) => (r.evidence[0]!.attemptId = 'other'),
  ]) {
    const result = good();
    mutation(result);
    assert.equal(attemptOutcome(compiled.test, result), 'error');
  }
});
test('missing, duplicate, forged and unstable results do not pass gate', () => {
  const plan = createPlan([compiled], 'http://localhost:4173');
  assert.equal(evaluateGate(plan, []).exitCode, 3);
  const caseResult = {
    caseId: 'a',
    project: 'chromium',
    outcome: 'passed' as const,
    flaky: false,
    attempts: [good()],
  };
  assert.equal(evaluateGate(plan, [caseResult]).passed, true);
  assert.equal(evaluateGate(plan, [caseResult, caseResult]).passed, false);
  assert.equal(evaluateGate(plan, [{ ...caseResult, flaky: true }]).passed, false);
  caseResult.attempts[0]!.assertions = [];
  assert.equal(evaluateGate(plan, [caseResult]).passed, false);
});
test('business mismatch is a failure and cannot be overwritten by a claimed pass', () => {
  const result = good();
  result.assertions[0]!.status = 'failed';
  assert.equal(attemptOutcome(compiled.test, result), 'failed');
  assert.equal(
    evaluateGate(createPlan([compiled], 'http://localhost'), [
      { caseId: 'a', project: 'chromium', outcome: 'passed', flaky: false, attempts: [result] },
    ]).passed,
    false,
  );
});

test('evidence digest, provenance, freshness and observed value must agree', () => {
  for (const mutate of [
    (r: AttemptResult) => (r.evidence[0]!.contentHash = 'modified'),
    (r: AttemptResult) => (r.evidence[0]!.source = 'agent-summary'),
    (r: AttemptResult) => (r.evidence[0]!.collectedAt = '2000-01-01T00:00:00Z'),
    (r: AttemptResult) => (r.assertions[0]!.actual = 'different'),
  ]) {
    const result = good();
    mutate(result);
    assert.equal(attemptOutcome(compiled.test, result), 'error');
  }
});
