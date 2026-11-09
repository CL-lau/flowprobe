import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskControl } from '../src/control.js';

test('manual handoff waits for in-flight input and invalidates its plan', async () => {
  const states: string[] = [];
  const control = new TaskControl((state) => states.push(state));
  const signal = new AbortController().signal;
  const revision = await control.checkpoint(signal);
  assert.ok(control.beginOperation(revision));
  let handed = false;
  const pause = control.pause().then(() => {
    handed = true;
  });
  assert.equal(handed, false);
  assert.equal(control.beginOperation(revision), false);
  control.endOperation();
  await pause;
  assert.equal(handed, true);
  assert.deepEqual(states, ['pausing', 'manual']);
  const checkpoint = control.checkpoint(signal);
  control.resume();
  const next = await checkpoint;
  assert.notEqual(next, revision);
  assert.equal(control.isCurrent(revision), false);
  assert.ok(control.beginOperation(next));
  control.endOperation();
});

test('stop interrupts a task waiting for manual login', async () => {
  const control = new TaskControl();
  const abort = new AbortController();
  await control.pause();
  const waiting = control.checkpoint(abort.signal);
  abort.abort(new Error('stop during login'));
  await assert.rejects(waiting, /stop during login/);
});
