import { mkdir, writeFile, rename, appendFile, readFile } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../../core/src/hash.js';
import type { Evidence, RunEvent } from '../../protocol/src/index.js';
import { FlowprobeError } from '../../core/src/errors.js';

export function safePath(root: string, key: string): string {
  const path = resolve(root, key),
    rel = relative(resolve(root), path);
  if (isAbsolute(key) || rel === '..' || rel.split(sep)[0] === '..' || isAbsolute(rel))
    throw new FlowprobeError('PATH_ESCAPE', key);
  return path;
}
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}
export class EvidenceStore {
  readonly evidence: Evidence[] = [];
  private sequence = 0;
  private writes: Promise<void> = Promise.resolve();
  constructor(
    readonly directory: string,
    readonly runId: string,
    readonly caseId: string,
    readonly attemptId: string,
  ) {}
  async record(source: string, value: unknown): Promise<Evidence> {
    const item: Evidence = {
      id: randomUUID(),
      attemptId: this.attemptId,
      source,
      value,
      collectedAt: new Date().toISOString(),
      contentHash: digest(value),
    };
    await writeJson(safePath(this.directory, `evidence/${item.id}.json`), item);
    this.evidence.push(item);
    return item;
  }
  event(type: string, data: unknown): Promise<void> {
    const event: RunEvent = {
      schemaVersion: 1,
      runId: this.runId,
      caseId: this.caseId,
      attemptId: this.attemptId,
      eventId: randomUUID(),
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      type,
      data,
    };
    this.writes = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true });
      await appendFile(safePath(this.directory, 'events.jsonl'), `${JSON.stringify(event)}\n`, {
        mode: 0o600,
      });
    });
    return this.writes;
  }
}
