import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry, validateActionTemplate } from '../../packages/plugins/src/index.js';
import { bundlePlugins, loadPluginBundle } from '../../packages/plugins/src/bundle.js';
import { bounded } from '../../packages/core/src/deadline.js';

test('plugins enforce protocol, unique names and primitive replay contracts', () => {
  assert.throws(() => new PluginRegistry([{ protocolMajor: 2 } as never]), /protocolMajor/);
  const action = { name: 'a', version: '1', async execute() {} };
  assert.throws(() => new PluginRegistry([{ protocolMajor: 1, actions: [action, action] }]), /a/);
  assert.throws(
    () => validateActionTemplate([{ type: 'plugin', plugin: 'a', input: {}, effect: 'none' }]),
    /primitive/,
  );
  assert.throws(() => validateActionTemplate([]));
});
test('plugin source and dependencies are bundled and tampering is rejected', async () => {
  const bundle = await bundlePlugins(
    'examples/plugins/company.ts',
    await mkdtemp(join(tmpdir(), 'fp-plugins-')),
  );
  const loaded = await loadPluginBundle(bundle);
  assert.equal(loaded.fixtures.size, 1);
  assert.equal(loaded.planners.size, 1);
  await appendFile(bundle.path, '\n// changed');
  await assert.rejects(loadPluginBundle(bundle), /\.mjs/);
});
test('bounded plugin lifetime propagates cancellation and rejects non-cooperative work', async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(
    bounded(
      async (s) => {
        signal = s;
        return new Promise(() => {});
      },
      10,
      new AbortController().signal,
    ),
    /exceeded/,
  );
  assert.equal(signal?.aborted, true);
});
