import { spawn, type SpawnOptions } from 'node:child_process';

/** Own a process tree until exit; cancellation waits for forced tree termination. */
export async function runProcess(
  command: string,
  args: string[],
  options: SpawnOptions & { signal?: AbortSignal; killGraceMs?: number } = {},
): Promise<{ exitCode: number | null; cancelled: boolean; error?: Error }> {
  const { signal, killGraceMs = 10_000, ...spawnOptions } = options;
  if (!Number.isFinite(killGraceMs) || killGraceMs < 0)
    throw new Error('killGraceMs must be finite and nonnegative');
  if (signal?.aborted) return { exitCode: null, cancelled: true };
  const child = spawn(command, args, {
    ...spawnOptions,
    detached: process.platform !== 'win32',
  });
  let error: Error | undefined;
  let cancellation: Promise<void> | undefined;
  const killGroup = (force: boolean): Promise<void> => {
    if (!child.pid) return Promise.resolve();
    if (process.platform === 'win32') {
      return new Promise((resolveKill, rejectKill) => {
        const killer = spawn('taskkill', [
          '/pid',
          String(child.pid),
          '/T',
          ...(force ? ['/F'] : []),
        ]);
        killer.once('error', rejectKill);
        killer.once('close', (code) => {
          if (code === 0 || code === 128) resolveKill();
          else rejectKill(new Error(`taskkill failed: ${code}`));
        });
      });
    }
    try {
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') return Promise.reject(cause);
    }
    return Promise.resolve();
  };
  const cancel = (): void => {
    cancellation ??= (async () => {
      await killGroup(false);
      // The leader may exit first while descendants ignore SIGTERM.
      await new Promise((resolveGrace) => setTimeout(resolveGrace, killGraceMs));
      await killGroup(true);
    })();
    // Attach immediately so a termination failure cannot become unhandled.
    void cancellation.catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    const exitCode = await new Promise<number | null>((resolveExit) => {
      child.once('error', (cause) => {
        error = cause;
        resolveExit(null);
      });
      child.once('close', resolveExit);
    });
    await cancellation;
    return { exitCode, cancelled: Boolean(cancellation), ...(error ? { error } : {}) };
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
