import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpModelProvider } from '../../packages/models/src/index.js';
import { createSemanticPlanner } from '../../packages/models/src/planner.js';
import { PluginRegistry } from '../../packages/plugins/src/index.js';
import { compile, loadCases, defaultProjects } from '../../packages/compiler/src/index.js';
import { runAttempt } from '../../packages/runner-playwright/src/attempt.js';
import company from '../../examples/plugins/company.js';

test.use({ trace: 'off' });
for (const variant of ['valid', 'escape', 'bad-json', 'rate-limit', 'no-budget'] as const) {
  test(`metered model browser integration: ${variant}`, async ({ browser }) => {
    let calls = 0;
    const server = createServer(async (req, res) => {
      calls++;
      let text = '';
      for await (const chunk of req) text += String(chunk);
      const input = JSON.parse(text) as { input: { inputs: { title: string } } };
      if (variant === 'rate-limit') {
        res.writeHead(429);
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      if (variant === 'bad-json') {
        res.end('{invalid');
        return;
      }
      const actions =
        variant === 'escape'
          ? [{ type: 'navigate', path: 'https://example.invalid', effect: 'none' }]
          : [
              {
                type: 'fill',
                target: { label: '订单标题' },
                value: input.input.inputs.title,
                effect: 'none',
              },
              { type: 'fill', target: { label: '金额（元）' }, value: '100', effect: 'none' },
              {
                type: 'click',
                target: { role: 'button', name: '提交订单' },
                effect: 'non-idempotent',
              },
            ];
      res.end(
        JSON.stringify({
          output: { actions },
          model: 'controlled-fixture',
          usage: { inputTokens: 100, outputTokens: 100, costUsd: 0.001 },
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const provider = new HttpModelProvider({
      endpoint: `http://127.0.0.1:${address.port}`,
      model: 'controlled-fixture',
      maxCostPerCallUsd: 0.01,
      maxOutputTokens: 4096,
      maxConcurrent: 1,
      timeoutMs: 3000,
    });
    const registry = new PluginRegistry([{ ...company, planners: [createSemanticPlanner()] }]);
    const source = structuredClone(
      (
        await loadCases('examples/plugin-cases', {
          catalog: new PluginRegistry([company]).catalog(),
        })
      )[0]!.test,
    );
    const intent = source.steps.find((s) => s.action.type === 'intent')!;
    if (intent.action.type !== 'intent') throw new Error('No intent');
    intent.action.strategy = ['flowprobe.semantic'];
    source.policy.model = { maxCalls: variant === 'no-budget' ? 0 : 2, maxCostUsd: 0.02 };
    try {
      const result = await runAttempt({
        browser,
        compiled: compile(source, { catalog: registry.catalog() }),
        project: defaultProjects[0]!,
        baseUrl: 'http://127.0.0.1:4173',
        runId: 'model',
        outputDirectory: await mkdtemp(join(tmpdir(), 'fp-model-')),
        registry,
        mode: 'learn',
        modelProvider: provider,
      });
      if (variant === 'valid') {
        expect(result.errors).toEqual([]);
        expect(result.outcome).toBe('passed');
        expect(result.assertions).toHaveLength(2);
      } else {
        expect(result.outcome).toBe('error');
        expect(result.completedSteps).not.toContain('create');
      }
      expect(calls).toBe(variant === 'no-budget' ? 0 : 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

test('visual model receives a component crop and Canvas actions retain independent verification', async ({
  browser,
}) => {
  const { createVisualPlanner } = await import('../../packages/models/src/planner.js');
  let sawImage = false;
  const provider = {
    name: 'controlled-visual',
    quote: () => ({ maxCostUsd: 0.01 }),
    async generate(request: import('../../packages/models/src/index.js').ModelRequest) {
      const input = request.input as { image: { mimeType: string; data: string } };
      sawImage =
        input.image.mimeType === 'image/png' &&
        Buffer.from(input.image.data, 'base64').subarray(1, 4).toString() === 'PNG';
      return {
        output: {
          points: [
            { x: 0.2, y: 0.3 },
            { x: 0.6, y: 0.3 },
          ],
        },
        model: 'controlled-visual',
        usage: { inputTokens: 200, outputTokens: 30, costUsd: 0.001 },
      };
    },
  };
  const registry = new PluginRegistry([{ protocolMajor: 1, planners: [createVisualPlanner()] }]);
  const source = {
    apiVersion: 'flowprobe/v1',
    kind: 'TestCase',
    id: 'canvas.visual',
    owner: 'simulation',
    requirements: ['CANVAS-VISUAL'],
    steps: [
      { id: 'open', action: { type: 'navigate', path: '/canvas' } },
      {
        id: 'add',
        action: {
          type: 'intent',
          text: '添加两个审批节点',
          scope: { component: 'workflow' },
          strategy: ['flowprobe.visual'],
        },
        verifies: ['nodes'],
      },
    ],
    assertions: [
      {
        id: 'nodes',
        after: 'add',
        type: 'dom.text',
        target: { testId: 'node-count' },
        expected: { equals: '节点数：2' },
      },
    ],
    policy: { model: { maxCalls: 1, maxCostUsd: 0.02 } },
  };
  const result = await runAttempt({
    browser,
    compiled: compile(source, { catalog: registry.catalog() }),
    project: defaultProjects[0]!,
    baseUrl: 'http://127.0.0.1:4173',
    runId: 'visual',
    outputDirectory: await mkdtemp(join(tmpdir(), 'fp-visual-')),
    registry,
    mode: 'learn',
    modelProvider: provider,
  });
  expect(sawImage).toBeTruthy();
  expect(result.errors).toEqual([]);
  expect(result.outcome).toBe('passed');
});
