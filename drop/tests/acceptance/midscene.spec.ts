import { bundlePlugins, loadPluginBundle } from '../../packages/plugins/src/bundle.js';
import { test, expect } from '@playwright/test';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createMidscenePlugins } from '../../packages/adapters-midscene/src/index.js';
import type { MidsceneFactory } from '../../packages/adapters-midscene/src/index.js';
import { PluginRegistry } from '../../packages/plugins/src/index.js';
import { compile, defaultProjects } from '../../packages/compiler/src/index.js';
import { runAttempt } from '../../packages/runner-playwright/src/attempt.js';
import type { ModelProvider } from '../../packages/models/src/index.js';

test.use({ trace: 'off' });
const config = {
  modelName: 'fixture-qwen',
  modelFamily: 'qwen3-vl' as const,
  maxOutputTokens: 4096,
  replanningCycleLimit: 2,
};
const source = {
  apiVersion: 'flowprobe/v1',
  kind: 'TestCase',
  id: 'native.midscene',
  owner: 'simulation',
  requirements: ['NATIVE-001'],
  steps: [
    { id: 'open', action: { type: 'navigate', path: '/canvas' } },
    {
      id: 'tap',
      action: {
        type: 'intent',
        text: 'Locate a point in the center of the canvas',
        scope: { component: 'workflow' },
        strategy: ['midscene.locate'],
      },
      verifies: ['nodes'],
    },
  ],
  assertions: [
    {
      id: 'nodes',
      after: 'tap',
      type: 'dom.text',
      target: { testId: 'node-count' },
      expected: { equals: '节点数：1' },
    },
  ],
  policy: { model: { maxCalls: 3, maxCostUsd: 0.03 } },
};
const provider: ModelProvider = {
  name: 'midscene-controlled',
  quote: () => ({ maxCostUsd: 0.01 }),
  async generate() {
    return {
      model: 'fixture-qwen',
      output: {
        model: 'fixture-qwen',
        choices: [
          {
            message: {
              role: 'assistant',
              content: JSON.stringify({ bbox_2d: [500, 500, 520, 520] }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      },
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 },
    };
  },
};

test('real Midscene SDK captures browser screenshot, uses metered completion and returns a host-verified point', async ({
  browser,
}) => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), 'fp-midscene-bundle-'));
  const bundle = await bundlePlugins('examples/plugins/midscene.ts', root);
  const registry = await loadPluginBundle(bundle);
  const result = await runAttempt({
    browser,
    compiled: compile(source, { catalog: registry.catalog() }),
    project: defaultProjects[0]!,
    baseUrl: 'http://127.0.0.1:4173',
    runId: 'midscene-native',
    outputDirectory: await mkdtemp(join(tmpdir(), 'fp-midscene-')),
    registry,
    mode: 'learn',
    modelProvider: provider,
  });
  expect(result.errors).toEqual([]);
  expect(result.outcome).toBe('passed');
  expect(result.modelUsage?.length).toBeGreaterThan(0);
  expect(result.evidence.some((e) => e.source === 'observation:midscene.location')).toBeTruthy();
  const nativeLogs = await readdir(
    join(dirname(result.artifacts[0]!), 'native', 'midscene', 'logs'),
  );
  expect(nativeLogs).toContain('ai-call.log');
});

test('native locator outside scope is rejected and native lifecycle is disposed', async ({
  browser,
}) => {
  let destroyed = false;
  const factory: MidsceneFactory = async () => ({
    async aiLocate() {
      return { center: [0, 0] };
    },
    async aiAct() {},
    async destroy() {
      destroyed = true;
    },
  });
  const registry = new PluginRegistry([createMidscenePlugins(config, factory)]);
  const result = await runAttempt({
    browser,
    compiled: compile(source, { catalog: registry.catalog() }),
    project: defaultProjects[0]!,
    baseUrl: 'http://127.0.0.1:4173',
    runId: 'midscene-bounds',
    outputDirectory: await mkdtemp(join(tmpdir(), 'fp-midscene-')),
    registry,
    mode: 'learn',
    modelProvider: provider,
  });
  expect(result.outcome).toBe('error');
  expect(destroyed).toBeTruthy();
  expect(result.completedSteps).not.toContain('tap');
});

test('native aiAct claimed completion cannot override a failing business assertion', async ({
  browser,
}) => {
  const registry = new PluginRegistry([createMidscenePlugins(config)]);
  const input = structuredClone(source);
  const task = {
    ...input,
    steps: [
      input.steps[0],
      {
        id: 'tap',
        action: {
          type: 'plugin',
          plugin: 'midscene.act',
          input: { instruction: 'Add one node to the canvas' },
          effect: 'non-idempotent',
        },
        verifies: ['nodes'],
      },
    ],
    assertions: input.assertions.map((a) => ({ ...a, timeoutMs: 500 })),
  };
  const lyingProvider: ModelProvider = {
    ...provider,
    async generate() {
      return {
        model: 'fixture-qwen',
        output: {
          model: 'fixture-qwen',
          choices: [
            {
              message: {
                role: 'assistant',
                content:
                  '<planning>Task completed.</planning><complete success="true">Node added</complete>',
              },
            },
          ],
        },
        usage: { inputTokens: 100, outputTokens: 30, costUsd: 0.001 },
      };
    },
  };
  const result = await runAttempt({
    browser,
    compiled: compile(task, { catalog: registry.catalog() }),
    project: defaultProjects[0]!,
    baseUrl: 'http://127.0.0.1:4173',
    runId: 'midscene-act',
    outputDirectory: await mkdtemp(join(tmpdir(), 'fp-midscene-')),
    registry,
    mode: 'learn',
    modelProvider: lyingProvider,
  });
  expect(result.errors).toEqual([]);
  expect(result.outcome).toBe('failed');
  expect(result.assertions[0]?.actual).toBe('节点数：0');
});
