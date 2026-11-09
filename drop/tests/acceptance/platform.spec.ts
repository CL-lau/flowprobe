import { test, expect } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compile,
  loadCases,
  defaultProjects,
  createPlan,
} from '../../packages/compiler/src/index.js';
import { runAttempt } from '../../packages/runner-playwright/src/attempt.js';
import { runPlan } from '../../packages/runner-playwright/src/index.js';
import { evaluateGate } from '../../packages/core/src/verdict.js';

// FlowProbe owns each attempt's trace; avoid two tracing lifecycles on one context.
test.use({ trace: 'off' });
const baseUrl = 'http://127.0.0.1:4173';
const projects = defaultProjects.map((p) => ({
  ...p,
  ...(process.env['FLOWPROBE_TEST_CHANNEL'] === 'chrome' ? { channel: 'chrome' as const } : {}),
}));
const cases = await loadCases('examples/cases');
for (const compiled of cases) {
  test(`real browser: ${compiled.test.id}`, async ({ browser }) => {
    const result = await runAttempt({
      browser,
      compiled,
      project: projects[0]!,
      baseUrl,
      runId: 'acceptance',
      outputDirectory: await mkdtemp(join(tmpdir(), 'flowprobe-')),
    });
    expect(result.errors).toEqual([]);
    expect(result.outcome).toBe('passed');
    expect(result.assertions).toHaveLength(compiled.test.assertions.length);
    expect(result.artifacts.some((p) => p.endsWith('trace.zip'))).toBeTruthy();
  });
}
for (const fault of ['wrong-amount', 'fake-success', 'server-error']) {
  test(`fault cannot pass: ${fault}`, async ({ browser }) => {
    const source = structuredClone(cases.find((c) => c.test.id === 'orders.create')!.test);
    source.steps[0]!.action = { type: 'navigate', path: `/orders?fault=${fault}`, effect: 'none' };
    source.assertions.forEach((a) => (a.timeoutMs = 700));
    const compiled = compile(source);
    const result = await runAttempt({
      browser,
      compiled,
      project: projects[0]!,
      baseUrl,
      runId: 'fault',
      outputDirectory: await mkdtemp(join(tmpdir(), 'flowprobe-')),
    });
    expect(result.outcome).not.toBe('passed');
    const gate = evaluateGate(createPlan([compiled], baseUrl, 'deterministic', projects), [
      {
        caseId: source.id,
        project: 'chromium',
        outcome: result.outcome,
        flaky: false,
        attempts: [result],
      },
    ]);
    expect(gate.passed).toBeFalsy();
    expect(result.assertions.find((a) => a.assertionId === 'order.persisted')?.status).toBe(
      'failed',
    );
  });
}
test('CLI runner uses Playwright Test and writes reconciled JSON/HTML/JUnit evidence', async () => {
  test.setTimeout(90000);
  const root = await mkdtemp(join(tmpdir(), 'flowprobe-cli-'));
  const report = await runPlan(createPlan(cases, baseUrl, 'deterministic', projects), {
    outputRoot: root,
    workers: 2,
  });
  expect(report.gate).toMatchObject({ passed: true, exitCode: 0, planned: 5, completed: 5 });
  expect(await readFile(join(root, report.runId, 'index.html'), 'utf8')).toContain('门禁通过');
  expect(await readFile(join(root, report.runId, 'junit.xml'), 'utf8')).toContain('failures="0"');
});

test('attempt timeout closes context and prevents later writes', async ({ browser }) => {
  const source = structuredClone(cases.find((c) => c.test.id === 'orders.create')!.test);
  source.policy.attemptTimeoutMs = 500;
  source.steps[1]!.action = { type: 'click', target: { testId: 'never-appears' }, effect: 'none' };
  const before = browser.contexts().length;
  const result = await runAttempt({
    browser,
    compiled: compile(source),
    project: projects[0]!,
    baseUrl,
    runId: 'timeout',
    outputDirectory: await mkdtemp(join(tmpdir(), 'flowprobe-')),
  });
  expect(result.outcome).toBe('error');
  expect(result.errors.some((e) => e.code === 'ATTEMPT_TIMEOUT')).toBeTruthy();
  expect(result.completedSteps).not.toContain('submit');
  expect(browser.contexts()).toHaveLength(before);
});

test('pre-cancelled attempt performs no action and cannot pass', async ({ browser }) => {
  const controller = new AbortController();
  controller.abort();
  const result = await runAttempt({
    browser,
    compiled: cases[0]!,
    project: projects[0]!,
    baseUrl,
    runId: 'cancel',
    outputDirectory: await mkdtemp(join(tmpdir(), 'flowprobe-')),
    signal: controller.signal,
  });
  expect(result.outcome).toBe('cancelled');
  expect(result.completedSteps).toEqual([]);
});
