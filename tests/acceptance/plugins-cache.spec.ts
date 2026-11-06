import { test, expect } from '@playwright/test';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bundlePlugins, loadPluginBundle } from '../../packages/plugins/src/bundle.js';
import { PluginRegistry, type PluginSet } from '../../packages/plugins/src/index.js';
import {
  loadCases,
  compile,
  createPlan,
  defaultProjects,
} from '../../packages/compiler/src/index.js';
import { runAttempt } from '../../packages/runner-playwright/src/attempt.js';
import { runPlan } from '../../packages/runner-playwright/src/index.js';
import { ReplayCache } from '../../packages/cache/src/index.js';
import company from '../../examples/plugins/company.js';

test.use({ trace: 'off' });
const baseUrl = 'http://127.0.0.1:4173';
const projects = defaultProjects.map((p) => ({
  ...p,
  ...(process.env['FLOWPROBE_TEST_CHANNEL'] === 'chrome' ? { channel: 'chrome' as const } : {}),
}));

test('cold learn → explicit promotion → parameterized replay → product fault is still rejected', async ({
  browser,
  request,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'fp-replay-'));
  const bundle = await bundlePlugins('examples/plugins/company.ts', join(directory, 'plugins'));
  const registry = await loadPluginBundle(bundle);
  const cases = await loadCases('examples/plugin-cases', { catalog: registry.catalog() });
  const source = structuredClone(cases[0]!.test);
  const profile = randomUUID();
  source.steps[0]!.action = {
    type: 'navigate',
    path: `/orders?profile=${profile}`,
    effect: 'none',
  };
  source.assertions.forEach((a) => (a.timeoutMs = 700));
  const compiled = compile(source, { catalog: registry.catalog() });
  const cache = new ReplayCache({
    directory: join(directory, 'cache'),
    appIdentity: 'simulator',
    buildId: '1',
  });
  const options = {
    browser,
    compiled,
    project: projects[0]!,
    baseUrl,
    runId: 'replay',
    outputDirectory: directory,
    registry,
    cache,
    pluginDigest: bundle.sha256,
  };
  try {
    const cold = await runAttempt({ ...options, mode: 'learn' });
    expect(cold.errors).toEqual([]);
    expect(cold.outcome).toBe('passed');
    const files = await readdir(join(cache.config.directory, 'entries'));
    expect(files).toHaveLength(1);
    const entry = await cache.read(files[0]!.slice(0, -5));
    expect(entry.state).toBe('validated');
    expect(JSON.stringify(entry.templates)).toContain('${fixtures.order.title}');
    expect(JSON.stringify(entry.templates)).not.toContain(cold.attemptId);
    await cache.promote(entry.id, 'acceptance-reviewer');
    // Fail the planner if invoked: a warm run must execute approved primitives only.
    registry.planners.get('company.createOrder')!.plan = async () => {
      throw new Error('Planner invoked during replay');
    };
    const warm = await runAttempt({ ...options, mode: 'deterministic' });
    expect(warm.errors).toEqual([]);
    expect(warm.outcome).toBe('passed');
    expect(warm.attemptId).not.toBe(cold.attemptId);
    const coldTitle = (cold.assertions[1]!.actual as { orders: { title: string }[] }).orders[0]!
      .title;
    const warmTitle = (warm.assertions[1]!.actual as { orders: { title: string }[] }).orders[0]!
      .title;
    expect(warmTitle).not.toBe(coldTitle);
    await request.post(`${baseUrl}/api/fault-profiles/${profile}`, {
      data: { fault: 'wrong-amount' },
    });
    const faulty = await runAttempt({ ...options, mode: 'deterministic' });
    expect(faulty.outcome).toBe('failed');
    expect(faulty.assertions.find((a) => a.assertionId === 'order.persisted')?.status).toBe(
      'failed',
    );
    const events = await readFile(
      join(directory, `cases/${source.id}/${projects[0]!.name}/${faulty.attemptId}/events.jsonl`),
      'utf8',
    );
    expect(events).toContain('"decision":"hit"');
    expect(await readdir(join(cache.config.directory, 'entries'))).toHaveLength(1);
  } finally {
    await request.delete(`${baseUrl}/api/fault-profiles/${profile}`);
  }
});

test('partial fixture setup still cleans resources, and cleanup failure blocks pass', async ({
  browser,
}) => {
  let cleaned = 0;
  const broken: PluginSet = {
    ...company,
    fixtures: [
      {
        name: 'company.orderDraft',
        version: '1',
        async setup(_input, ctx) {
          await ctx.recordResource({ id: 'partial' });
          throw new Error('seed failed');
        },
        async cleanup(resources) {
          cleaned += resources.length;
        },
      },
    ],
  };
  const registry = new PluginRegistry([broken]);
  const compiled = (await loadCases('examples/plugin-cases', { catalog: registry.catalog() }))[0]!;
  const directory = await mkdtemp(join(tmpdir(), 'fp-cleanup-'));
  const failed = await runAttempt({
    browser,
    compiled,
    registry,
    project: projects[0]!,
    baseUrl,
    runId: 'setup',
    outputDirectory: directory,
    mode: 'learn',
  });
  expect(failed.outcome).toBe('error');
  expect(cleaned).toBe(1);
  expect(failed.cleanupSucceeded).toBeTruthy();
  const badCleanup = new PluginRegistry([
    {
      ...company,
      fixtures: [
        {
          ...company.fixtures![0]!,
          async cleanup() {
            throw new Error('cleanup unavailable');
          },
        },
      ],
    },
  ]);
  const result = await runAttempt({
    browser,
    compiled,
    registry: badCleanup,
    project: projects[0]!,
    baseUrl,
    runId: 'cleanup',
    outputDirectory: directory,
    mode: 'learn',
  });
  expect(result.assertions.every((a) => a.status === 'passed')).toBeTruthy();
  expect(result.outcome).toBe('error');
  expect(result.cleanupSucceeded).toBeFalsy();
});

test('bundled plugins run through the real Playwright Test harness and record cache validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fp-plugin-run-'));
  const plugins = await bundlePlugins('examples/plugins/company.ts', join(root, 'plugins'));
  const cases = await loadCases('examples/plugin-cases', { catalog: plugins.catalog });
  const cache = { directory: join(root, 'cache'), appIdentity: 'simulator', buildId: '1' };
  const plan = createPlan(cases, baseUrl, 'learn', projects, plugins, cache);
  const report = await runPlan(plan, { outputRoot: root, workers: 1 });
  expect(report.gate).toMatchObject({ passed: true, planned: 1, completed: 1 });
  const entries = await readdir(join(cache.directory, 'entries'));
  expect((await new ReplayCache(cache).read(entries[0]!.slice(0, -5))).state).toBe('validated');
});
