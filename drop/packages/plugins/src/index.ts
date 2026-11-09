import type { ModelClient } from '../../models/src/index.js';
import type { Page, APIRequestContext } from '@playwright/test';
import type { Action, TestCase } from '../../protocol/src/index.js';
import { identifier, actionSchema } from '../../protocol/src/index.js';
import { z } from 'zod';
import { digest } from '../../core/src/hash.js';
import { FlowprobeError } from '../../core/src/errors.js';

export interface PluginContext {
  page: Page;
  api: APIRequestContext;
  baseUrl: string;
  signal: AbortSignal;
  runId: string;
  caseId: string;
  attemptId: string;
  artifactDirectory: string;
  model?: ModelClient;
  /** Record resources immediately, including before setup can fail. */
  recordObservation(source: string, value: unknown): Promise<string>;
  recordResource(resource: Record<string, unknown>): Promise<void>;
}
export interface FixturePlugin {
  name: string;
  version: string;
  setup(input: Record<string, unknown>, ctx: PluginContext): Promise<Record<string, unknown>>;
  cleanup(resources: readonly Record<string, unknown>[], ctx: PluginContext): Promise<void>;
}
export interface ActionPlugin {
  name: string;
  version: string;
  execute(input: Record<string, unknown>, ctx: PluginContext): Promise<void>;
}
export interface AssertionPlugin {
  name: string;
  version: string;
  observe(input: Record<string, unknown>, ctx: PluginContext): Promise<unknown>;
  evaluate(
    actual: unknown,
    input: Record<string, unknown>,
  ): { status: 'passed' | 'failed' | 'inconclusive'; expected: unknown };
}
export interface PreconditionPlugin {
  name: string;
  version: string;
  check(ctx: PluginContext): Promise<boolean>;
}
export interface IntentPlanner {
  name: string;
  version: string;
  modelBased: boolean;
  /** Return a template: dynamic values must remain ${fixtures...} placeholders. */
  plan(action: Extract<Action, { type: 'intent' }>, ctx: PluginContext): Promise<Action[]>;
}
export interface PluginSet {
  protocolMajor: 1;
  fixtures?: FixturePlugin[];
  actions?: ActionPlugin[];
  assertions?: AssertionPlugin[];
  preconditions?: PreconditionPlugin[];
  planners?: IntentPlanner[];
}
export interface PluginCatalog {
  protocolMajor: 1;
  digest: string;
  fixtures: { name: string; version: string }[];
  actions: { name: string; version: string }[];
  assertions: { name: string; version: string }[];
  preconditions: { name: string; version: string }[];
  planners: { name: string; version: string; modelBased: boolean }[];
}
export const catalogSchema = z
  .object({
    protocolMajor: z.literal(1),
    digest: z.string(),
    fixtures: z.array(z.object({ name: identifier, version: z.string() }).strict()),
    actions: z.array(z.object({ name: identifier, version: z.string() }).strict()),
    assertions: z.array(z.object({ name: identifier, version: z.string() }).strict()),
    preconditions: z.array(z.object({ name: identifier, version: z.string() }).strict()),
    planners: z.array(
      z.object({ name: identifier, version: z.string(), modelBased: z.boolean() }).strict(),
    ),
  })
  .strict();

export class PluginRegistry {
  readonly fixtures = new Map<string, FixturePlugin>();
  readonly actions = new Map<string, ActionPlugin>();
  readonly assertions = new Map<string, AssertionPlugin>();
  readonly preconditions = new Map<string, PreconditionPlugin>();
  readonly planners = new Map<string, IntentPlanner>();
  constructor(sets: PluginSet[] = []) {
    for (const set of sets) {
      if (set.protocolMajor !== 1)
        throw new FlowprobeError('PLUGIN_PROTOCOL', 'Expected protocolMajor 1');
      this.add(this.fixtures, set.fixtures ?? [], ['setup', 'cleanup']);
      this.add(this.actions, set.actions ?? [], ['execute']);
      this.add(this.assertions, set.assertions ?? [], ['observe', 'evaluate']);
      this.add(this.preconditions, set.preconditions ?? [], ['check']);
      this.add(this.planners, set.planners ?? [], ['plan']);
      for (const planner of set.planners ?? [])
        if (typeof planner.modelBased !== 'boolean')
          throw new FlowprobeError('PLUGIN_INVALID', planner.name);
    }
  }
  private add<T extends { name: string; version: string }>(
    map: Map<string, T>,
    plugins: T[],
    methods: string[],
  ): void {
    for (const plugin of plugins) {
      identifier.parse(plugin.name);
      if (
        !plugin.version ||
        methods.some((method) => typeof (plugin as Record<string, unknown>)[method] !== 'function')
      )
        throw new FlowprobeError('PLUGIN_INVALID', plugin.name);
      if (map.has(plugin.name)) throw new FlowprobeError('PLUGIN_DUPLICATE', plugin.name);
      map.set(plugin.name, plugin);
    }
  }
  catalog(): PluginCatalog {
    const list = <T extends { name: string; version: string }>(map: Map<string, T>) =>
      [...map.values()]
        .map((p) => ({ name: p.name, version: p.version }))
        .sort((a, b) => a.name.localeCompare(b.name));
    const value = {
      protocolMajor: 1 as const,
      fixtures: list(this.fixtures),
      actions: list(this.actions),
      assertions: list(this.assertions),
      preconditions: list(this.preconditions),
      planners: [...this.planners.values()]
        .map((p) => ({ name: p.name, version: p.version, modelBased: p.modelBased }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
    return { ...value, digest: digest(value) };
  }
}
export const emptyCatalog = (): PluginCatalog => new PluginRegistry().catalog();
export function validateCapabilities(test: TestCase, catalog: PluginCatalog): void {
  for (const fixture of Object.values(test.fixtures))
    if (!catalog.fixtures.some((p) => p.name === fixture.provider && p.version === fixture.version))
      throw new FlowprobeError('FIXTURE_UNKNOWN', `${fixture.provider}@${fixture.version}`);
  if (
    test.cleanup &&
    test.cleanup.provider !== 'fixtures' &&
    !(
      Object.values(test.fixtures).length === 1 &&
      Object.values(test.fixtures)[0]?.provider === test.cleanup.provider
    )
  )
    throw new FlowprobeError('CLEANUP_UNKNOWN', test.cleanup.provider);
  for (const step of test.steps) {
    for (const name of step.preconditions)
      if (!catalog.preconditions.some((p) => p.name === name))
        throw new FlowprobeError('PRECONDITION_UNKNOWN', name);
    const action = step.action;
    if (action.type === 'plugin' && !catalog.actions.some((p) => p.name === action.plugin))
      throw new FlowprobeError('ACTION_PLUGIN_UNKNOWN', action.plugin);
    if (action.type === 'intent')
      for (const name of action.strategy)
        if (name !== 'approved-replay' && !catalog.planners.some((p) => p.name === name))
          throw new FlowprobeError('PLANNER_UNKNOWN', name);
  }
  for (const assertion of test.assertions)
    if (assertion.type === 'plugin' && !catalog.assertions.some((p) => p.name === assertion.plugin))
      throw new FlowprobeError('ASSERTION_PLUGIN_UNKNOWN', assertion.plugin);
}
export function validateActionTemplate(input: unknown): Action[] {
  const actions = z.array(actionSchema).min(1).max(100).parse(input);
  if (actions.some((a) => a.type === 'intent' || a.type === 'plugin'))
    throw new FlowprobeError(
      'REPLAY_UNSAFE',
      'Replay templates only support host-owned primitive actions',
    );
  return actions;
}
