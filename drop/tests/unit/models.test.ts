import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ModelGateway,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from '../../packages/models/src/index.js';
const request: ModelRequest = {
  task: 'plan',
  input: { goal: 'test' },
  responseSchema: { type: 'object' },
  maxOutputTokens: 100,
};
const response = (cost: number | null): ModelResponse => ({
  output: { ok: true },
  model: 'fixture-model',
  usage: { inputTokens: 10, outputTokens: 10, costUsd: cost },
});
const provider = (generate: ModelProvider['generate']): ModelProvider => ({
  name: 'fixture',
  quote: () => ({ maxCostUsd: 0.05 }),
  generate,
});
const limits = { maxCalls: 5, maxCostUsd: 0.1, maxConcurrent: 3, timeoutMs: 100 };
test('concurrent calls reserve synchronously and cannot spend the same remaining balance', async () => {
  const pending: ((value: ModelResponse) => void)[] = [];
  const gateway = new ModelGateway(
    provider(async () => new Promise((resolve) => pending.push(resolve))),
    limits,
    'learn',
  );
  const a = gateway.generate(request, new AbortController().signal);
  const b = gateway.generate(request, new AbortController().signal);
  await assert.rejects(gateway.generate(request, new AbortController().signal), /cost budget/);
  pending.forEach((resolve) => resolve(response(0.03)));
  await Promise.all([a, b]);
  assert.equal(gateway.summary().chargedUsd, 0.06);
  assert.equal(gateway.summary().calls, 2);
});
test('unknown usage and timeout retain reserved cost rather than refunding billed calls', async () => {
  const unknown = new ModelGateway(
    provider(async () => response(null)),
    { ...limits, maxCostUsd: 0.05 },
    'learn',
  );
  await unknown.generate(request, new AbortController().signal);
  await assert.rejects(unknown.generate(request, new AbortController().signal), /cost budget/);
  assert.equal(unknown.summary().unknownCalls, 1);
  const timeout = new ModelGateway(
    provider(async () => new Promise(() => {})),
    { ...limits, timeoutMs: 10 },
    'learn',
  );
  await assert.rejects(timeout.generate(request, new AbortController().signal), /exceeded/);
  assert.equal(timeout.summary().chargedUsd, 0.05);
  assert.equal(timeout.summary().inFlight, 0);
});
test('deterministic mode, call limit and provider cost violations are fail closed', async () => {
  await assert.rejects(
    new ModelGateway(
      provider(async () => response(0)),
      limits,
      'deterministic',
    ).generate(request, new AbortController().signal),
    /prohibit/,
  );
  const overrun = new ModelGateway(
    provider(async () => response(0.08)),
    limits,
    'learn',
  );
  await assert.rejects(
    overrun.generate(request, new AbortController().signal),
    /exceeded reserved/,
  );
  assert.equal(overrun.summary().chargedUsd, 0.08);
  await assert.rejects(overrun.generate(request, new AbortController().signal), /violated/);
  const one = new ModelGateway(
    provider(async () => response(0)),
    { ...limits, maxCalls: 1 },
    'learn',
  );
  await one.generate(request, new AbortController().signal);
  await assert.rejects(one.generate(request, new AbortController().signal), /call limit/);
});
