import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../../packages/core/src/process.js';

test('pre-cancelled processes never spawn and ordinary exits retain their code', async () => {
  assert.deepEqual(await runProcess('nonexistent-command', [], { signal: AbortSignal.abort() }), {
    exitCode: null,
    cancelled: true,
  });
  assert.equal((await runProcess(process.execPath, ['-e', 'process.exit(7)'])).exitCode, 7);
  assert.ok((await runProcess('flowprobe-nonexistent-command', [])).error);
});

test(
  'cancellation kills a descendant ignoring TERM even after its parent exits',
  {
    skip: process.platform === 'win32',
    timeout: 10_000,
  },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flowprobe-process-'));
    const heartbeat = join(dir, 'heartbeat');
    const controller = new AbortController();
    const descendant = `const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20);`;
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
    const running = runProcess(process.execPath, ['-e', parent], {
      signal: controller.signal,
      killGraceMs: 100,
      stdio: 'ignore',
    });
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try {
          ready = (await readFile(heartbeat)).length > 0;
        } catch {}
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(ready, 'descendant started');
      controller.abort();
      assert.equal((await running).cancelled, true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const snapshot = await readFile(heartbeat, 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(await readFile(heartbeat, 'utf8'), snapshot, 'no late writes');
    } finally {
      controller.abort();
      await running;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
