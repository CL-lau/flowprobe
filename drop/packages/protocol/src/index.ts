import type { GatewayConfig, UsageRecord } from '../../models/src/index.js';
import type { CacheConfig } from '../../cache/src/index.js';
import type { PluginBundle } from '../../plugins/src/bundle.js';
import { z } from 'zod';

export const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const targetSchema = z
  .object({
    testId: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    css: z.string().optional(),
    matchText: z.string().optional(),
    frame: z.string().optional(),
    scopeTestId: z.string().optional(),
  })
  .strict()
  .refine(
    (t) => [t.testId, t.role, t.label, t.css].filter((v) => v !== undefined).length === 1,
    'Exactly one of testId, role, label or css is required',
  );
const effect = z.enum(['none', 'idempotent', 'non-idempotent']).default('none');
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), path: z.string(), effect }).strict(),
  z.object({ type: z.literal('click'), target: targetSchema, effect }).strict(),
  z.object({ type: z.literal('fill'), target: targetSchema, value: z.string(), effect }).strict(),
  z.object({ type: z.literal('select'), target: targetSchema, value: z.string(), effect }).strict(),
  z
    .object({ type: z.literal('check'), target: targetSchema, checked: z.boolean(), effect })
    .strict(),
  z
    .object({
      type: z.literal('point'),
      target: targetSchema,
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      expectedSize: z
        .object({ width: z.number().positive(), height: z.number().positive() })
        .strict(),
      effect,
    })
    .strict(),
  z.object({ type: z.literal('press'), target: targetSchema, key: z.string(), effect }).strict(),
  z
    .object({
      type: z.literal('intent'),
      text: z.string().min(1),
      inputs: z.record(z.string(), z.unknown()).default({}),
      scope: z.object({ component: z.string() }).strict(),
      strategy: z.array(z.string()).min(1),
      effect,
      operationKey: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('plugin'),
      plugin: identifier,
      input: z.record(z.string(), z.unknown()).default({}),
      effect,
    })
    .strict(),
]);
const assertionBase = {
  id: identifier,
  after: identifier,
  required: z.boolean().default(true),
  timeoutMs: z.number().int().positive().max(120000).default(5000),
};
export const assertionSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...assertionBase,
      type: z.literal('dom.text'),
      target: targetSchema,
      expected: z.union([
        z.object({ equals: z.string() }).strict(),
        z.object({ contains: z.string().min(1) }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      ...assertionBase,
      type: z.literal('dom.visible'),
      target: targetSchema,
      expected: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...assertionBase,
      type: z.literal('dom.count'),
      target: targetSchema,
      expected: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...assertionBase,
      type: z.literal('dom.value'),
      target: targetSchema,
      expected: z.string(),
    })
    .strict(),
  z.object({ ...assertionBase, type: z.literal('url'), expected: z.string() }).strict(),
  z
    .object({
      ...assertionBase,
      type: z.literal('api'),
      path: z.string(),
      expected: z
        .object({
          status: z.number().int().min(100).max(599),
          body: z.unknown().optional(),
          fields: z.record(z.string(), z.unknown()).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...assertionBase,
      type: z.literal('plugin'),
      plugin: identifier,
      input: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
]);
export const caseSchema = z
  .object({
    apiVersion: z.literal('flowprobe/v1'),
    kind: z.literal('TestCase'),
    id: identifier,
    owner: z.string().min(1),
    requirements: z.array(identifier).min(1),
    risk: z.enum(['critical', 'high', 'normal']).default('normal'),
    engines: z.array(z.string()).min(1).default(['playwright']),
    projects: z.array(identifier).min(1).default(['chromium']),
    tags: z.array(z.string()).default([]),
    fixtures: z
      .record(
        identifier,
        z
          .object({
            provider: identifier,
            version: z.string(),
            isolation: z.literal('attempt'),
            input: z.record(z.string(), z.unknown()).default({}),
          })
          .strict(),
      )
      .default({}),
    steps: z
      .array(
        z
          .object({
            id: identifier,
            action: actionSchema,
            verifies: z.array(identifier).default([]),
            preconditions: z.array(identifier).default([]),
            timeoutMs: z.number().int().positive().max(120000).default(15000),
          })
          .strict(),
      )
      .min(1),
    assertions: z.array(assertionSchema).min(1),
    policy: z
      .object({
        allowRepair: z.boolean().default(false),
        attemptTimeoutMs: z.number().int().positive().max(3600000).default(60000),
        maxAttempts: z.number().int().min(1).max(5).default(1),
        model: z
          .object({
            maxCalls: z.number().int().nonnegative().default(0),
            maxCostUsd: z.number().nonnegative().default(0),
          })
          .default({ maxCalls: 0, maxCostUsd: 0 }),
      })
      .strict()
      .default({
        allowRepair: false,
        attemptTimeoutMs: 60000,
        maxAttempts: 1,
        model: { maxCalls: 0, maxCostUsd: 0 },
      }),
    cleanup: z
      .object({ provider: identifier, required: z.boolean().default(true) })
      .strict()
      .optional(),
  })
  .strict();
export type TestCase = z.infer<typeof caseSchema>;
export type Action = z.infer<typeof actionSchema>;
export type Assertion = z.infer<typeof assertionSchema>;
export type Target = z.infer<typeof targetSchema>;
export type Mode = 'deterministic' | 'hybrid-frozen' | 'learn' | 'explore';
export type Outcome =
  'passed' | 'failed' | 'error' | 'inconclusive' | 'cancelled' | 'skipped' | 'unsupported';
export interface CompiledCase {
  schemaVersion: 1;
  sourceDigest: string;
  test: TestCase;
}
export interface Plan {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  mode: Mode;
  baseUrl: string;
  cases: CompiledCase[];
  projects: Project[];
  digest: string;
  plugins?: PluginBundle;
  cache?: CacheConfig;
  models?: GatewayConfig;
}
export interface Project {
  name: string;
  browser: 'chromium' | 'firefox' | 'webkit';
  channel?: 'chrome' | 'msedge';
  locale: string;
  timezoneId: string;
  viewport: { width: number; height: number };
}
export interface Evidence {
  id: string;
  attemptId: string;
  source: string;
  collectedAt: string;
  contentHash: string;
  value: unknown;
}
export interface AssertionResult {
  assertionId: string;
  status: 'passed' | 'failed' | 'inconclusive' | 'error';
  evidenceIds: string[];
  expected: unknown;
  actual: unknown;
  evaluatorVersion: string;
  durationMs: number;
  errorCode?: string;
  message?: string;
}
export interface AttemptResult {
  caseId: string;
  project: string;
  attemptId: string;
  outcome: Outcome;
  startedAt: string;
  durationMs: number;
  assertions: AssertionResult[];
  completedSteps: string[];
  evidence: Evidence[];
  errors: { code: string; message: string }[];
  cleanupSucceeded: boolean;
  artifacts: string[];
  repaired: boolean;
  modelUsage?: UsageRecord[];
}
export interface CaseResult {
  caseId: string;
  project: string;
  outcome: Outcome;
  flaky: boolean;
  attempts: AttemptResult[];
}
export interface Gate {
  passed: boolean;
  exitCode: 0 | 1 | 2 | 3 | 4;
  reasons: string[];
  planned: number;
  completed: number;
}
export interface RunReport {
  schemaVersion: 1;
  runId: string;
  plan: Plan;
  startedAt: string;
  finishedAt: string;
  cases: CaseResult[];
  gate: Gate;
}
export interface RunEvent {
  schemaVersion: 1;
  runId: string;
  caseId: string;
  attemptId: string;
  eventId: string;
  sequence: number;
  timestamp: string;
  type: string;
  data: unknown;
}
