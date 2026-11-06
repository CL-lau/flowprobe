import { digest } from './hash.js';
import { isDeepStrictEqual } from 'node:util';
import type { AttemptResult, CaseResult, Gate, Plan, TestCase } from '../../protocol/src/index.js';

export function attemptOutcome(test: TestCase, attempt: AttemptResult): AttemptResult['outcome'] {
  if (attempt.errors.some((e) => e.code === 'CANCELLED')) return 'cancelled';
  if (attempt.errors.length || !attempt.cleanupSucceeded) return 'error';
  const ids = attempt.assertions.map((a) => a.assertionId);
  if (new Set(ids).size !== ids.length) return 'error';
  if (new Set(attempt.evidence.map((e) => e.id)).size !== attempt.evidence.length) return 'error';
  const evidence = new Map(
    attempt.evidence
      .filter(
        (e) =>
          e.attemptId === attempt.attemptId &&
          e.contentHash === digest(e.value) &&
          Number.isFinite(Date.parse(e.collectedAt)) &&
          Date.parse(e.collectedAt) >= Date.parse(attempt.startedAt),
      )
      .map((e) => [e.id, e]),
  );
  const knownFailure = attempt.assertions.some(
    (a) =>
      a.status === 'failed' && test.assertions.some((s) => s.id === a.assertionId && s.required),
  );
  for (const assertion of test.assertions.filter((a) => a.required)) {
    const result = attempt.assertions.find((a) => a.assertionId === assertion.id);
    if (!result && knownFailure) continue;
    if (!result || !result.evidenceIds.length || result.evidenceIds.some((id) => !evidence.has(id)))
      return 'error';
    if (result.status === 'error') return 'error';
    const fact = evidence.get(result.evidenceIds[0]!)!;
    if (
      fact.source !== `assertion:${assertion.id}` ||
      !fact.value ||
      typeof fact.value !== 'object' ||
      !isDeepStrictEqual((fact.value as Record<string, unknown>)['actual'], result.actual)
    )
      return 'error';
  }
  const required = attempt.assertions.filter((a) =>
    test.assertions.some((spec) => spec.id === a.assertionId && spec.required),
  );
  if (required.some((a) => a.status === 'failed')) return 'failed';
  if (required.some((a) => a.status === 'inconclusive')) return 'inconclusive';
  if (test.steps.some((s) => !attempt.completedSteps.includes(s.id))) return 'error';
  return 'passed';
}
export function evaluateGate(plan: Plan, results: CaseResult[]): Gate {
  const expected = plan.cases.flatMap((c) =>
    c.test.projects.map((project) => ({ key: `${c.test.id}/${project}`, test: c.test })),
  );
  const reasons: string[] = [];
  let infra = false,
    cancelled = false;
  const keys = results.map((r) => `${r.caseId}/${r.project}`);
  if (!expected.length) {
    reasons.push('EMPTY_PLAN');
    infra = true;
  }
  if (new Set(keys).size !== keys.length) {
    reasons.push('DUPLICATE_RESULT');
    infra = true;
  }
  for (const key of keys)
    if (!expected.some((e) => e.key === key)) {
      reasons.push(`UNEXPECTED_RESULT:${key}`);
      infra = true;
    }
  for (const entry of expected) {
    const result = results.find((r) => `${r.caseId}/${r.project}` === entry.key);
    if (!result) {
      reasons.push(`RESULT_MISSING:${entry.key}`);
      infra = true;
      continue;
    }
    const last = result.attempts.at(-1);
    if (!last) {
      reasons.push(`ATTEMPT_MISSING:${entry.key}`);
      infra = true;
      continue;
    }
    const actual = attemptOutcome(entry.test, last);
    if (result.outcome !== actual || last.outcome !== actual) {
      reasons.push(`VERDICT_MISMATCH:${entry.key}`);
      infra = true;
    }
    if (actual !== 'passed') reasons.push(`${actual.toUpperCase()}:${entry.key}`);
    if (actual === 'error') infra = true;
    if (actual === 'cancelled') cancelled = true;
    if (
      entry.test.risk === 'critical' &&
      (result.flaky || last.repaired || result.attempts.length > 1)
    )
      reasons.push(`UNSTABLE_CRITICAL:${entry.key}`);
  }
  return {
    passed: reasons.length === 0,
    exitCode: cancelled ? 4 : infra ? 3 : reasons.length ? 1 : 0,
    reasons,
    planned: expected.length,
    completed: results.length,
  };
}
