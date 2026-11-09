import { runtimeFingerprint } from '../../core/src/runtime.js';
import { ModelGateway, type ModelProvider } from '../../models/src/index.js';
import { fixtureOrder } from '../../core/src/fixture-order.js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type {
  Action,
  AttemptResult,
  CompiledCase,
  Mode,
  Project,
} from '../../protocol/src/index.js';
import { EvidenceStore, safePath, writeJson } from '../../storage/src/index.js';
import { errorInfo, FlowprobeError } from '../../core/src/errors.js';
import { resolveVariables } from '../../core/src/variables.js';
import { attemptOutcome } from '../../core/src/verdict.js';
import { bounded } from '../../core/src/deadline.js';
import {
  PluginRegistry,
  validateActionTemplate,
  validateCapabilities,
  type PluginContext,
  type FixturePlugin,
} from '../../plugins/src/index.js';
import { ReplayCache, type CacheIdentity } from '../../cache/src/index.js';
import { executeAction } from './browser.js';
import { evaluateAssertion } from '../../assertions/src/index.js';

export interface AttemptOptions {
  browser: Browser;
  compiled: CompiledCase;
  project: Project;
  baseUrl: string;
  runId: string;
  outputDirectory: string;
  signal?: AbortSignal;
  registry?: PluginRegistry;
  mode?: Mode;
  cache?: ReplayCache;
  pluginDigest?: string;
  modelProvider?: ModelProvider;
  modelTimeoutMs?: number;
  modelConcurrency?: number;
}
interface FixtureState {
  name: string;
  plugin: FixturePlugin;
  resources: Record<string, unknown>[];
}
export async function runAttempt(options: AttemptOptions): Promise<AttemptResult> {
  const { browser, compiled, project, baseUrl, runId, outputDirectory } = options;
  const registry = options.registry ?? new PluginRegistry(),
    mode = options.mode ?? 'deterministic';
  const test = compiled.test,
    attemptId = randomUUID(),
    start = performance.now();
  const directory = safePath(outputDirectory, `cases/${test.id}/${project.name}/${attemptId}`);
  const store = new EvidenceStore(directory, runId, test.id, attemptId);
  const result: AttemptResult = {
    caseId: test.id,
    project: project.name,
    attemptId,
    outcome: 'error',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    assertions: [],
    completedSteps: [],
    evidence: store.evidence,
    errors: [],
    cleanupSucceeded: true,
    artifacts: [],
    repaired: false,
  };
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(new FlowprobeError('CANCELLED', 'Run cancelled'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(
    () =>
      controller.abort(
        new FlowprobeError('ATTEMPT_TIMEOUT', `Exceeded ${test.policy.attemptTimeoutMs}ms`),
      ),
    test.policy.attemptTimeoutMs,
  );
  let context: BrowserContext | undefined,
    page: Page | undefined,
    traceStarted = false;
  let storageState: Awaited<ReturnType<BrowserContext['storageState']>> = {
    cookies: [],
    origins: [],
  };
  const model = options.modelProvider
    ? new ModelGateway(
        options.modelProvider,
        {
          ...test.policy.model,
          timeoutMs: options.modelTimeoutMs ?? 30000,
          maxConcurrent: options.modelConcurrency ?? 1,
        },
        mode,
        (record) => store.event('model.usage', record),
      )
    : undefined;
  const fixtureStates: FixtureState[] = [];
  const templates: Record<string, Action[]> = {};
  const cacheIdentity: CacheIdentity = {
    sourceDigest: compiled.sourceDigest,
    runtimeDigest: runtimeFingerprint(),
    project,
    baseUrl,
    browserVersion: browser.version(),
    pluginDigest: options.pluginDigest ?? registry.catalog().digest,
  };
  const closeOnAbort = (): void => {
    void context?.close().catch(() => undefined);
  };
  controller.signal.addEventListener('abort', closeOnAbort, { once: true });
  const pluginContext = (
    activePage: Page,
    signal: AbortSignal,
    resources?: Record<string, unknown>[],
  ): PluginContext => ({
    page: activePage,
    api: activePage.context().request,
    baseUrl,
    signal,
    runId,
    caseId: test.id,
    attemptId,
    artifactDirectory: directory,
    ...(model ? { model } : {}),
    async recordObservation(source, value) {
      signal.throwIfAborted();
      return (await store.record(`observation:${source}`, value)).id;
    },
    async recordResource(resource) {
      signal.throwIfAborted();
      if (!resources)
        throw new FlowprobeError('RESOURCE_SCOPE', 'Only fixtures may register resources');
      resources.push(structuredClone(resource));
      await store.event('fixture.resource', resource);
    },
  });
  await store.event('attempt.started', {
    project,
    sourceDigest: compiled.sourceDigest,
    mode,
    pluginDigest: cacheIdentity.pluginDigest,
  });
  try {
    controller.signal.throwIfAborted();
    validateCapabilities(test, registry.catalog());
    context = await browser.newContext({
      baseURL: baseUrl,
      locale: project.locale,
      timezoneId: project.timezoneId,
      viewport: project.viewport,
    });
    controller.signal.throwIfAborted();
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== new URL(baseUrl).origin)
        await route.abort('blockedbyclient');
      else await route.continue();
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    traceStarted = true;
    page = await context.newPage();
    const activePage = page;
    const variables: Record<string, unknown> & { fixtures: Record<string, unknown> } = {
      fixtures: {},
      run: { id: runId },
      case: { id: test.id },
      attempt: { id: attemptId },
    };
    for (const name of fixtureOrder(test)) {
      const definition = test.fixtures[name]!;
      const plugin = registry.fixtures.get(definition.provider)!;
      const state: FixtureState = { name, plugin, resources: [] };
      fixtureStates.push(state);
      await store.event('fixture.preparing', {
        name,
        provider: plugin.name,
        version: plugin.version,
      });
      const value = await bounded(
        (signal) =>
          plugin.setup(
            resolveVariables(definition.input, variables),
            pluginContext(activePage, signal, state.resources),
          ),
        15000,
        controller.signal,
      );
      variables.fixtures[name] = value;
      storageState = await context.storageState();
      await store.event('fixture.ready', { name });
    }
    const approved = options.cache ? await options.cache.lookup(cacheIdentity) : undefined;
    for (const step of test.steps) {
      controller.signal.throwIfAborted();
      for (const name of step.preconditions) {
        const passed = await bounded(
          (signal) => registry.preconditions.get(name)!.check(pluginContext(activePage, signal)),
          step.timeoutMs,
          controller.signal,
        );
        await store.record(`precondition:${name}`, { passed, url: activePage.url() });
        if (passed !== true) throw new FlowprobeError('PRECONDITION_FAILED', name);
      }
      await store.event('action.started', { stepId: step.id, type: step.action.type });
      const action = step.action;
      if (action.type === 'intent') {
        const replay = action.strategy.includes('approved-replay')
          ? approved?.templates[step.id]
          : undefined;
        let actions: Action[];
        if (replay) {
          actions = validateActionTemplate(replay);
          await store.event('cache.decision', {
            stepId: step.id,
            decision: 'hit',
            entryId: approved!.id,
          });
        } else {
          await store.event('cache.decision', { stepId: step.id, decision: 'miss' });
          if (mode === 'deterministic') throw new FlowprobeError('CACHE_REQUIRED', step.id);
          const planner = action.strategy.map((name) => registry.planners.get(name)).find(Boolean);
          if (!planner) throw new FlowprobeError('PLANNER_UNKNOWN', step.id);
          if (planner.modelBased && !model)
            throw new FlowprobeError(
              'MODEL_PROVIDER_REQUIRED',
              'Configure a metered model gateway',
            );
          actions = validateActionTemplate(
            await bounded(
              (signal) => planner.plan(action, pluginContext(activePage, signal)),
              step.timeoutMs,
              controller.signal,
            ),
          );
          templates[step.id] = actions;
        }
        // The complete template is parameter-bound and validated before any side effect occurs.
        const bound = validateActionTemplate(resolveVariables(actions, variables));
        await bounded(
          async (signal) => {
            for (const primitive of bound) {
              signal.throwIfAborted();
              await executeAction(activePage, primitive, baseUrl, step.timeoutMs);
            }
          },
          step.timeoutMs,
          controller.signal,
        );
      } else if (action.type === 'plugin') {
        await bounded(
          (signal) =>
            registry.actions
              .get(action.plugin)!
              .execute(
                resolveVariables(action.input, variables),
                pluginContext(activePage, signal),
              ),
          step.timeoutMs,
          controller.signal,
        );
      } else
        await executeAction(
          activePage,
          resolveVariables(action, variables),
          baseUrl,
          step.timeoutMs,
        );
      controller.signal.throwIfAborted();
      result.completedSteps.push(step.id);
      await store.event('action.completed', { stepId: step.id, url: activePage.url() });
      for (const assertion of test.assertions.filter((a) => a.after === step.id)) {
        const evaluated = await evaluateAssertion(
          resolveVariables(assertion, variables),
          activePage,
          baseUrl,
          store,
          controller.signal,
          { registry, context: pluginContext(activePage, controller.signal) },
        );
        result.assertions.push(evaluated);
      }
      if (
        result.assertions.some(
          (a) =>
            a.status !== 'passed' && test.assertions.find((s) => s.id === a.assertionId)?.required,
        )
      )
        break;
    }
  } catch (error) {
    result.errors.push(errorInfo(controller.signal.aborted ? controller.signal.reason : error));
    if (errorInfo(error).code === 'TOOL_TIMEOUT') controller.abort(error);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    controller.signal.removeEventListener('abort', closeOnAbort);
    if (context) {
      if (!controller.signal.aborted) {
        try {
          storageState = await context.storageState();
        } catch {
          /* Keep last known state for cleanup. */
        }
        try {
          if (page && !page.isClosed()) {
            const screenshot = safePath(directory, 'final.png');
            await page.screenshot({ path: screenshot, fullPage: true, timeout: 3000 });
            result.artifacts.push(screenshot);
          }
        } catch (error) {
          result.errors.push({ code: 'EVIDENCE_INCOMPLETE', message: errorInfo(error).message });
        }
      }
      // Cleanup has a separate lifetime and isolated context, so cancellation cannot suppress teardown.
      if (fixtureStates.length) {
        const cleanupSignal = new AbortController();
        const cleanupTimer = setTimeout(
          () =>
            cleanupSignal.abort(
              new FlowprobeError('CLEANUP_TIMEOUT', 'Cleanup grace period expired'),
            ),
          10000,
        );
        for (const state of fixtureStates.reverse()) {
          let cleanupContext: BrowserContext | undefined;
          try {
            cleanupSignal.signal.throwIfAborted();
            cleanupContext = await browser.newContext({ baseURL: baseUrl, storageState });
            const cleanupPage = await cleanupContext.newPage();
            await bounded(
              (signal) => state.plugin.cleanup(state.resources, pluginContext(cleanupPage, signal)),
              5000,
              cleanupSignal.signal,
            );
            await store.event('fixture.cleaned', { name: state.name });
          } catch (error) {
            result.cleanupSucceeded = false;
            result.errors.push({
              code: 'CLEANUP_FAILED',
              message: `${state.name}: ${errorInfo(error).message}`,
            });
            await store.event('fixture.cleanup-failed', {
              name: state.name,
              resources: state.resources,
            });
          } finally {
            await cleanupContext?.close().catch((error) => {
              result.cleanupSucceeded = false;
              result.errors.push(errorInfo(error));
            });
          }
        }
        clearTimeout(cleanupTimer);
        cleanupSignal.abort();
      }
      try {
        if (traceStarted && !controller.signal.aborted) {
          const trace = safePath(directory, 'trace.zip');
          await context.tracing.stop({ path: trace });
          result.artifacts.push(trace);
        }
      } catch (error) {
        result.errors.push({ code: 'EVIDENCE_INCOMPLETE', message: errorInfo(error).message });
      }
      try {
        await context.close();
      } catch (error) {
        result.cleanupSucceeded = false;
        result.errors.push(errorInfo(error));
      }
    }
  }
  if (model) result.modelUsage = structuredClone(model.records);
  result.durationMs = Math.round(performance.now() - start);
  result.outcome = attemptOutcome(test, result);
  if (
    options.cache &&
    mode === 'learn' &&
    Object.keys(templates).length &&
    !controller.signal.aborted
  ) {
    try {
      const entry = await options.cache.record(cacheIdentity, compiled, result, templates);
      await store.event('cache.recorded', { entryId: entry.id, state: entry.state });
    } catch (error) {
      result.errors.push(errorInfo(error));
      result.outcome = attemptOutcome(test, result);
    }
  }
  await store.event('attempt.finished', { outcome: result.outcome, durationMs: result.durationMs });
  await writeJson(safePath(directory, 'result.json'), result);
  return result;
}
