import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, createPlan, verifyPlan } from '../../packages/compiler/src/index.js';
import { resolveVariables } from '../../packages/core/src/variables.js';
import { safePath } from '../../packages/storage/src/index.js';
import { digest } from '../../packages/core/src/hash.js';
export const minimal = () => ({
  apiVersion: 'flowprobe/v1',
  kind: 'TestCase',
  id: 'example',
  owner: 'test',
  requirements: ['R1'],
  steps: [{ id: 'open', action: { type: 'navigate', path: '/' } }],
  assertions: [
    {
      id: 'title',
      after: 'open',
      type: 'dom.text',
      target: { testId: 'title' },
      expected: { equals: 'Hello' },
    },
  ],
});
test('compiler creates stable immutable-content digest and rejects modified plans', () => {
  const c = compile(minimal());
  const plan = createPlan([c], 'http://localhost:4173');
  verifyPlan(plan);
  plan.cases[0]!.test.owner = 'tampered';
  assert.throws(() => verifyPlan(plan), /example/);
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
});
test('compiler rejects invalid contracts rather than ignoring fields', () => {
  assert.throws(() => compile({ ...minimal(), assertions: [] }));
  assert.throws(() => compile({ ...minimal(), undocumentedOption: true }));
  assert.throws(() =>
    compile({ ...minimal(), assertions: [{ ...minimal().assertions[0], after: 'missing' }] }),
  );
  assert.throws(() =>
    compile({ ...minimal(), assertions: [{ ...minimal().assertions[0], required: false }] }),
  );
  assert.throws(() =>
    compile({
      ...minimal(),
      steps: [
        {
          id: 'open',
          action: { type: 'click', target: { testId: 'submit' }, effect: 'non-idempotent' },
        },
      ],
    }),
  );
  assert.throws(() =>
    compile({
      ...minimal(),
      steps: [{ id: 'open', action: { type: 'navigate', path: '${fixtures.unknown.path}' } }],
    }),
  );
});
test('variables are typed, exhaustive and reject prototype paths or expressions', () => {
  assert.equal(resolveVariables('${fixtures.a.count}', { fixtures: { a: { count: 4 } } }), 4);
  assert.equal(resolveVariables('hello ${case.id}', { case: { id: 'world' } }), 'hello world');
  assert.throws(() => resolveVariables('${fixtures.missing}', { fixtures: {} }));
  assert.throws(() => resolveVariables('${constructor.name}', {}));
  assert.throws(() => resolveVariables('${process.exit()}', {}));
});
test('artifact paths cannot escape the run directory', () => {
  assert.throws(() => safePath('/tmp/run', '../../secret'));
  assert.throws(() => safePath('/tmp/run', '/etc/passwd'));
  assert.equal(safePath('/tmp/run', 'cases/a/result.json'), '/tmp/run/cases/a/result.json');
});

test('fixture dependencies are ordered and cycles are rejected', async () => {
  const { fixtureOrder } = await import('../../packages/core/src/fixture-order.js');
  const fixture = (input: Record<string, unknown>) => ({
    provider: 'test',
    version: '1',
    isolation: 'attempt',
    input,
  });
  const caseInput = {
    ...minimal(),
    fixtures: { child: fixture({ parent: '${fixtures.parent.id}' }), parent: fixture({}) },
    cleanup: { provider: 'fixtures' },
  };
  assert.deepEqual(fixtureOrder(compile(caseInput).test), ['parent', 'child']);
  assert.throws(
    () =>
      compile({
        ...caseInput,
        fixtures: {
          child: fixture({ parent: '${fixtures.parent.id}' }),
          parent: fixture({ child: '${fixtures.child.id}' }),
        },
      }),
    /parent|child/,
  );
});

test('programmatic and deserialized plans validate mode and browser capability declarations', () => {
  const c = compile(minimal());
  assert.throws(() => createPlan([c], 'http://localhost', 'typo' as never));
  assert.throws(() => createPlan([c, c], 'http://localhost'));
  assert.throws(() =>
    createPlan([c], 'http://localhost', 'deterministic', [
      {
        name: 'chromium',
        browser: 'firefox',
        channel: 'chrome',
        locale: 'zh-CN',
        timezoneId: 'UTC',
        viewport: { width: 100, height: 100 },
      },
    ]),
  );
});
