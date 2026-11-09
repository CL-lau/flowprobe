import { runtimeFingerprint } from '../../core/src/runtime.js';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Action, AttemptResult, CompiledCase, Project } from '../../protocol/src/index.js';
import { actionSchema } from '../../protocol/src/index.js';
import { digest } from '../../core/src/hash.js';
import { attemptOutcome } from '../../core/src/verdict.js';
import { FlowprobeError } from '../../core/src/errors.js';
import { readJson, safePath, writeJson } from '../../storage/src/index.js';
import { validateActionTemplate } from '../../plugins/src/index.js';

export interface CacheConfig {
  directory: string;
  appIdentity: string;
  buildId: string;
}
export interface CacheIdentity {
  sourceDigest: string;
  pluginDigest: string;
  project: Project;
  baseUrl: string;
  browserVersion: string;
  runtimeDigest?: string;
}
const entrySchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    key: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(['candidate', 'validated', 'approved', 'invalidated']),
    createdAt: z.string(),
    sourceDigest: z.string(),
    attemptId: z.string(),
    templateDigest: z.string(),
    templates: z.record(z.string(), z.array(actionSchema)),
    verificationIds: z.array(z.string()),
    validation: z
      .object({ outcome: z.string(), evidenceDigest: z.string(), cleanupSucceeded: z.boolean() })
      .strict(),
    promotedBy: z.string().optional(),
    promotedAt: z.string().optional(),
    invalidationReason: z.string().optional(),
  })
  .strict();
export type CacheEntry = z.infer<typeof entrySchema>;

export class ReplayCache {
  constructor(readonly config: CacheConfig) {
    if (!config.appIdentity.trim() || !config.buildId.trim())
      throw new FlowprobeError('CACHE_IDENTITY', 'Application identity and buildId are required');
  }
  key(identity: CacheIdentity): string {
    return digest({
      ...identity,
      runtimeDigest: identity.runtimeDigest ?? runtimeFingerprint(),
      appIdentity: this.config.appIdentity,
      buildId: this.config.buildId,
      replayProtocol: 1,
    });
  }
  async record(
    identity: CacheIdentity,
    compiled: CompiledCase,
    result: AttemptResult,
    templates: Record<string, Action[]>,
  ): Promise<CacheEntry> {
    if (
      identity.sourceDigest !== compiled.sourceDigest ||
      result.caseId !== compiled.test.id ||
      result.project !== identity.project.name
    )
      throw new FlowprobeError('CACHE_IDENTITY', 'Validation source mismatch');
    const stepIds = Object.keys(templates);
    if (!stepIds.length) throw new FlowprobeError('CACHE_EMPTY', 'No recorded intent actions');
    for (const stepId of stepIds) {
      const step = compiled.test.steps.find((s) => s.id === stepId);
      if (
        !step ||
        step.action.type !== 'intent' ||
        !step.verifies.some((id) => compiled.test.assertions.some((a) => a.id === id && a.required))
      )
        throw new FlowprobeError('CACHE_UNVERIFIED', stepId);
      validateActionTemplate(templates[stepId]);
    }
    const outcome = attemptOutcome(compiled.test, result);
    const entry: CacheEntry = {
      schemaVersion: 1,
      id: randomUUID(),
      key: this.key(identity),
      state: outcome === 'passed' && !result.repaired ? 'validated' : 'candidate',
      createdAt: new Date().toISOString(),
      sourceDigest: compiled.sourceDigest,
      attemptId: result.attemptId,
      templates,
      templateDigest: digest(templates),
      verificationIds: compiled.test.assertions.filter((a) => a.required).map((a) => a.id),
      validation: {
        outcome,
        evidenceDigest: digest(result.evidence),
        cleanupSucceeded: result.cleanupSucceeded,
      },
    };
    await writeJson(this.path(entry.id), entry);
    return entry;
  }
  private path(id: string): string {
    z.string().uuid().parse(id);
    return safePath(this.config.directory, `entries/${id}.json`);
  }
  async read(id: string): Promise<CacheEntry> {
    const entry = entrySchema.parse(await readJson(this.path(id)));
    if (entry.id !== id || entry.templateDigest !== digest(entry.templates))
      throw new FlowprobeError('CACHE_CORRUPT', id);
    for (const template of Object.values(entry.templates)) validateActionTemplate(template);
    return entry;
  }
  private async update(
    id: string,
    operation: (entry: CacheEntry) => CacheEntry,
  ): Promise<CacheEntry> {
    const path = this.path(id),
      lock = `${path}.lock`;
    try {
      await mkdir(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new FlowprobeError('CACHE_BUSY', id);
      throw error;
    }
    try {
      const result = operation(await this.read(id));
      await writeJson(path, result);
      return result;
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
  async promote(id: string, actor: string): Promise<CacheEntry> {
    if (!actor.trim())
      throw new FlowprobeError('CACHE_ACTOR', 'Promotion requires a named reviewer');
    return this.update(id, (entry) => {
      if (
        entry.state !== 'validated' ||
        entry.validation.outcome !== 'passed' ||
        !entry.validation.cleanupSucceeded ||
        !entry.verificationIds.length
      )
        throw new FlowprobeError('CACHE_NOT_VALIDATED', id);
      return {
        ...entry,
        state: 'approved',
        promotedBy: actor,
        promotedAt: new Date().toISOString(),
      };
    });
  }
  async invalidate(id: string, reason: string): Promise<CacheEntry> {
    return this.update(id, (entry) => ({
      ...entry,
      state: 'invalidated',
      invalidationReason: reason,
    }));
  }
  async lookup(identity: CacheIdentity): Promise<CacheEntry | undefined> {
    let files: string[];
    try {
      files = await readdir(safePath(this.config.directory, 'entries'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const key = this.key(identity),
      candidates: CacheEntry[] = [];
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      const entry = await this.read(file.slice(0, -5));
      if (entry.key === key && entry.state === 'approved') candidates.push(entry);
    }
    return candidates.sort((a, b) => (b.promotedAt ?? '').localeCompare(a.promotedAt ?? ''))[0];
  }
}
