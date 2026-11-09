import { z } from 'zod';
import { gatewayConfigSchema, type GatewayConfig } from '../../models/src/index.js';
import { fixtureOrder } from '../../core/src/fixture-order.js';
import type { CacheConfig } from '../../cache/src/index.js';
import { emptyCatalog, validateCapabilities, type PluginCatalog } from '../../plugins/src/index.js';
import type { PluginBundle } from '../../plugins/src/bundle.js';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseDocument } from 'yaml';
import {
  caseSchema,
  type CompiledCase,
  type Mode,
  type Plan,
  type Project,
} from '../../protocol/src/index.js';
import { digest } from '../../core/src/hash.js';
import { FlowprobeError } from '../../core/src/errors.js';

export interface CompileOptions {
  mode?: Mode;
  preconditions?: ReadonlySet<string>;
  catalog?: PluginCatalog;
}
export function compile(input: unknown, options: CompileOptions = {}): CompiledCase {
  const parsed = caseSchema.safeParse(input);
  if (!parsed.success) throw new FlowprobeError('SCHEMA_INVALID', parsed.error.message);
  const test = parsed.data;
  const steps = new Map(test.steps.map((s, i) => [s.id, i]));
  const assertions = new Map(test.assertions.map((a) => [a.id, a]));
  if (steps.size !== test.steps.length || assertions.size !== test.assertions.length)
    throw new FlowprobeError('DUPLICATE_ID', test.id);
  if (!test.assertions.some((a) => a.required))
    throw new FlowprobeError('ASSERTION_MISSING', 'At least one required assertion must exist');
  for (const assertion of test.assertions) {
    if (!steps.has(assertion.after))
      throw new FlowprobeError('REFERENCE_INVALID', `Unknown step: ${assertion.after}`);
  }
  for (const step of test.steps) {
    for (const id of step.verifies) {
      const assertion = assertions.get(id);
      if (!assertion || assertion.after !== step.id)
        throw new FlowprobeError('REFERENCE_INVALID', `${step.id} must own assertion ${id}`);
    }
    if (step.action.effect !== 'none' && !step.verifies.some((id) => assertions.get(id)?.required))
      throw new FlowprobeError(
        'UNVERIFIED_EFFECT',
        `Write step ${step.id} requires a linked required assertion`,
      );
    if (
      options.mode === 'deterministic' &&
      step.action.type === 'intent' &&
      !step.action.strategy.includes('approved-replay')
    )
      throw new FlowprobeError('MODEL_FORBIDDEN', step.id);
    if (step.action.type === 'intent' && !step.verifies.some((id) => assertions.get(id)?.required))
      throw new FlowprobeError('UNVERIFIED_INTENT', step.id);
    for (const id of step.preconditions)
      if (
        !options.preconditions?.has(id) &&
        !options.catalog?.preconditions.some((p) => p.name === id)
      )
        throw new FlowprobeError('PRECONDITION_UNKNOWN', id);
  }
  if (test.cleanup && !Object.keys(test.fixtures).length)
    throw new FlowprobeError('CLEANUP_ORPHAN', 'Cleanup requires fixture ownership');
  if (test.engines.some((engine) => engine !== 'playwright'))
    throw new FlowprobeError('ENGINE_UNSUPPORTED', test.engines.join(','));
  if (Object.keys(test.fixtures).length && !test.cleanup)
    throw new FlowprobeError('CLEANUP_MISSING', test.id);
  fixtureOrder(test);
  const serialized = JSON.stringify(test);
  for (const match of serialized.matchAll(/\$\{([^}]+)\}/g)) {
    const path = match[1]!;
    if (
      !/^(fixtures\.[\w-]+\.[\w.-]+|run\.id|case\.id|attempt\.id)$/.test(path) ||
      /(?:^|\.)(__proto__|prototype|constructor)(?:\.|$)/.test(path)
    )
      throw new FlowprobeError('VARIABLE_SYNTAX', path);
    if (path.startsWith('fixtures.') && !Object.hasOwn(test.fixtures, path.split('.')[1]!))
      throw new FlowprobeError('VARIABLE_MISSING', path);
  }
  return { schemaVersion: 1, sourceDigest: digest(test), test };
}
export async function loadCases(
  directory: string,
  options: CompileOptions = {},
): Promise<CompiledCase[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(join(dir, entry.name));
      else if (/\.ya?ml$/.test(entry.name)) files.push(join(dir, entry.name));
    }
  }
  await walk(resolve(directory));
  const cases = await Promise.all(
    files.sort().map(async (file) => {
      const doc = parseDocument(await readFile(file, 'utf8'), { uniqueKeys: true });
      if (doc.errors.length)
        throw new FlowprobeError(
          'YAML_INVALID',
          `${file}: ${doc.errors.map((e) => e.message).join('; ')}`,
        );
      return compile(doc.toJS({ maxAliasCount: 20 }), options);
    }),
  );
  if (!cases.length) throw new FlowprobeError('EMPTY_PLAN', 'No YAML test cases found');
  if (new Set(cases.map((c) => c.test.id)).size !== cases.length)
    throw new FlowprobeError('DUPLICATE_ID', 'Duplicate case IDs');
  return cases;
}
export const defaultProjects: Project[] = [
  {
    name: 'chromium',
    browser: 'chromium',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1280, height: 800 },
  },
];
export function createPlan(
  cases: CompiledCase[],
  baseUrl: string,
  mode: Mode = 'deterministic',
  projects: Project[] = defaultProjects,
  plugins?: PluginBundle,
  cache?: CacheConfig,
  models?: GatewayConfig,
): Plan {
  z.enum(['deterministic', 'hybrid-frozen', 'learn', 'explore']).parse(mode);
  z.array(
    z
      .object({
        name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
        browser: z.enum(['chromium', 'firefox', 'webkit']),
        channel: z.enum(['chrome', 'msedge']).optional(),
        locale: z.string().min(1),
        timezoneId: z.string().min(1),
        viewport: z
          .object({ width: z.number().int().positive(), height: z.number().int().positive() })
          .strict(),
      })
      .strict(),
  )
    .min(1)
    .parse(projects);
  if (projects.some((p) => p.channel && p.browser !== 'chromium'))
    throw new FlowprobeError('PROJECT_CHANNEL', 'Chrome/Edge channels require Chromium');
  if (new Set(cases.map((c) => c.test.id)).size !== cases.length)
    throw new FlowprobeError('DUPLICATE_ID', 'Duplicate case IDs');
  if (models) models = gatewayConfigSchema.parse(models);
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new FlowprobeError('URL_INVALID', baseUrl);
  if (!cases.length) throw new FlowprobeError('EMPTY_PLAN', 'No cases selected');
  if (new Set(projects.map((p) => p.name)).size !== projects.length)
    throw new FlowprobeError('DUPLICATE_ID', 'Duplicate project names');
  for (const item of cases) {
    const checked = compile(item.test, { mode, catalog: plugins?.catalog ?? emptyCatalog() });
    validateCapabilities(checked.test, plugins?.catalog ?? emptyCatalog());
    if (checked.sourceDigest !== item.sourceDigest)
      throw new FlowprobeError('PLAN_TAMPERED', item.test.id);
    for (const name of item.test.projects)
      if (!projects.some((p) => p.name === name)) throw new FlowprobeError('PROJECT_UNKNOWN', name);
  }
  const content = {
    schemaVersion: 1 as const,
    mode,
    baseUrl: url.href,
    cases,
    projects,
    ...(plugins ? { plugins } : {}),
    ...(cache ? { cache } : {}),
    ...(models ? { models } : {}),
  };
  const hash = digest(content);
  return { ...content, id: hash.slice(0, 16), createdAt: new Date().toISOString(), digest: hash };
}
export function verifyPlan(plan: Plan): void {
  const rebuilt = createPlan(
    plan.cases,
    plan.baseUrl,
    plan.mode,
    plan.projects,
    plan.plugins,
    plan.cache,
    plan.models,
  );
  if (rebuilt.digest !== plan.digest || rebuilt.id !== plan.id)
    throw new FlowprobeError('PLAN_TAMPERED', 'Plan digest mismatch');
}
