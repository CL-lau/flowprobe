import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { z } from 'zod';

const envelope = z
  .object({
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string() }).passthrough().optional(),
  })
  .passthrough();
export class NativeDesktop {
  readonly binary: string;
  readonly application: string;
  constructor() {
    const require = createRequire(import.meta.url);
    const directory = dirname(require.resolve('agent-desktop/package.json'));
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    this.application = process.resourcesPath
      ? join(process.resourcesPath, 'native-driver/FlowProbe Driver.app')
      : join(root, '.flowprobe/native-driver/FlowProbe Driver.app');
    if (!existsSync(this.application))
      this.application = join(root, '.flowprobe/native-driver/FlowProbe Driver.app');
    const bundled = join(
      this.application,
      'Contents/MacOS',
      `agent-desktop-darwin-${process.arch}`,
    );
    this.binary =
      process.platform === 'darwin' && existsSync(bundled)
        ? bundled
        : join(
            directory,
            'bin',
            `agent-desktop-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`,
          );
  }
  async run(args: string[], signal?: AbortSignal, input?: string): Promise<unknown> {
    signal?.throwIfAborted();
    if (process.platform === 'darwin' && this.binary.startsWith(this.application)) {
      return this.runApplication(args, signal, input);
    }
    return this.runDirect(args, signal, input);
  }
  private async runApplication(
    args: string[],
    signal?: AbortSignal,
    input?: string,
  ): Promise<unknown> {
    const directory = await mkdtemp(join(tmpdir(), 'flowprobe-driver-'));
    const output = join(directory, 'stdout.json');
    const errorFile = join(directory, 'stderr.txt');
    const inputFile = join(directory, 'stdin.txt');
    const trace = join(directory, 'trace.jsonl');
    const terminate = () => {
      // LaunchServices owns the app process. Only terminate this request's unique traced instance.
      try {
        const records = execFileSync('/bin/ps', ['-axo', 'pid=,comm='], {
          encoding: 'utf8',
          timeout: 2000,
        });
        for (const line of records.split('\n')) {
          const match = line.trim().match(/^(\d+)\s+(.+)$/);
          if (!match || match[2] !== this.binary) continue;
          const pid = Number(match[1]);
          const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'args='], {
            encoding: 'utf8',
            timeout: 2000,
          });
          if (command.includes(trace)) process.kill(pid, 'SIGTERM');
        }
      } catch {}
    };
    let completed = false;
    try {
      for (const [file, content] of [
        [inputFile, input ?? ''],
        [output, ''],
        [errorFile, ''],
      ] as const)
        await writeFile(file, content, { mode: 0o600 });
      signal?.throwIfAborted();
      signal?.addEventListener('abort', terminate, { once: true });
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          '/usr/bin/open',
          [
            '-n',
            '-g',
            '-W',
            '--stdin',
            inputFile,
            '--stdout',
            output,
            '--stderr',
            errorFile,
            '-a',
            this.application,
            '--args',
            ...args,
            '--trace',
            trace,
          ],
          {
            ...(signal ? { signal } : {}),
            timeout: 20000,
            stdio: 'ignore',
          },
        );
        child.on('error', reject);
        child.on('close', () => resolve());
      });
      signal?.throwIfAborted();
      // Very short-lived apps can finish before `open -W` resolves their PID. The driver's
      // complete JSON response, rather than the launcher's exit status, is authoritative.
      let raw: unknown;
      const deadline = Date.now() + 3000;
      for (;;) {
        signal?.throwIfAborted();
        if ((await stat(output)).size > 4_000_000) throw new Error('Desktop response exceeds 4 MB');
        try {
          raw = JSON.parse(await readFile(output, 'utf8'));
          break;
        } catch {
          if (Date.now() >= deadline) throw new Error('Desktop app did not return a response');
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const result = envelope.parse(raw);
      if (!result.ok)
        throw new Error(
          `${result.error?.code ?? 'DESKTOP_ERROR'}: ${result.error?.message ?? 'Desktop operation failed'}`,
        );
      completed = true;
      return result.data;
    } finally {
      signal?.removeEventListener('abort', terminate);
      if (!completed || signal?.aborted) terminate();
      await rm(directory, { recursive: true, force: true });
    }
  }
  private async runDirect(args: string[], signal?: AbortSignal, input?: string): Promise<unknown> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, {
        ...(signal ? { signal } : {}),
        timeout: 20000,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4_000_000) {
          child.kill();
          reject(new Error('Desktop response exceeds 4 MB'));
        } else chunks.push(chunk);
      });
      // Native diagnostics never contain a protocol response; keep them out of the task transcript.
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', () => {
        try {
          const result = envelope.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          if (!result.ok)
            reject(
              new Error(
                `${result.error?.code ?? 'DESKTOP_ERROR'}: ${result.error?.message ?? 'Desktop operation failed'}`,
              ),
            );
          else resolve(result.data);
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }
}
