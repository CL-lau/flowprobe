import type { PluginRegistry, PluginContext } from '../../plugins/src/index.js';
import { bounded } from '../../core/src/deadline.js';
import { z } from 'zod';
import type { Page } from '@playwright/test';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { Assertion, AssertionResult } from '../../protocol/src/index.js';
import { EvidenceStore } from '../../storage/src/index.js';
import { locator, scopedUrl } from '../../runner-playwright/src/browser.js';
import { readPath } from '../../core/src/variables.js';
import { errorInfo, FlowprobeError } from '../../core/src/errors.js';

export async function evaluateAssertion(
  spec: Assertion,
  page: Page,
  baseUrl: string,
  store: EvidenceStore,
  signal: AbortSignal,
  plugins?: { registry: PluginRegistry; context: PluginContext },
): Promise<AssertionResult> {
  const started = Date.now();
  let actual: unknown = null,
    passed = false,
    readError: unknown;
  let expected: unknown = 'expected' in spec ? spec.expected : spec.input;
  let semanticStatus: 'passed' | 'failed' | 'inconclusive' = 'failed';
  let lastObservation:
    | {
        actual: unknown;
        expected: unknown;
        status: 'passed' | 'failed' | 'inconclusive';
        passed: boolean;
      }
    | undefined;
  const deadline = started + spec.timeoutMs;
  do {
    signal.throwIfAborted();
    try {
      const timeout = Math.max(1, deadline - Date.now());
      switch (spec.type) {
        case 'dom.text': {
          actual = await locator(page, spec.target).textContent({ timeout });
          passed =
            'equals' in spec.expected
              ? actual === spec.expected.equals
              : typeof actual === 'string' && actual.includes(spec.expected.contains);
          break;
        }
        case 'dom.visible':
          actual = await locator(page, spec.target).isVisible();
          passed = actual === spec.expected;
          break;
        case 'dom.count':
          actual = await locator(page, spec.target).count();
          passed = actual === spec.expected;
          break;
        case 'dom.value':
          actual = await locator(page, spec.target).inputValue({ timeout });
          passed = actual === spec.expected;
          break;
        case 'url':
          actual = page.url();
          passed = actual === scopedUrl(spec.expected, baseUrl);
          break;
        case 'api': {
          const response = await page.request.get(scopedUrl(spec.path, baseUrl), {
            timeout,
            maxRedirects: 0,
          });
          const text = await response.text();
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
          actual = { status: response.status(), body };
          passed = response.status() === spec.expected.status;
          if ('body' in spec.expected) passed &&= isDeepStrictEqual(body, spec.expected.body);
          for (const [path, value] of Object.entries(spec.expected.fields ?? {})) {
            try {
              passed &&= isDeepStrictEqual(readPath(body, path), value);
            } catch {
              passed = false;
            }
          }
          await response.dispose();
          break;
        }
        case 'plugin': {
          const plugin = plugins?.registry.assertions.get(spec.plugin);
          if (!plugin || !plugins)
            throw new FlowprobeError(
              'CAPABILITY_UNSUPPORTED',
              `Assertion plugin not registered: ${spec.plugin}`,
            );
          actual = await bounded(
            (childSignal) =>
              plugin.observe(spec.input, { ...plugins.context, signal: childSignal }),
            timeout,
            signal,
          );
          const evaluated = z
            .object({ status: z.enum(['passed', 'failed', 'inconclusive']), expected: z.unknown() })
            .strict()
            .parse(plugin.evaluate(actual, spec.input));
          expected = evaluated.expected;
          semanticStatus = evaluated.status;
          passed = semanticStatus === 'passed';
          break;
        }
      }
      lastObservation = {
        actual: structuredClone(actual),
        expected: structuredClone(expected),
        status: semanticStatus,
        passed,
      };
      readError = undefined;
      if (passed) break;
    } catch (error) {
      readError = error;
      if (error instanceof FlowprobeError) break;
    }
    if (Date.now() < deadline)
      await delay(Math.min(100, deadline - Date.now()), undefined, { signal });
  } while (Date.now() < deadline);
  // A later read error must not erase an already observed business violation.
  // Preserve the observation and attach the read failure as diagnostic evidence.
  if (lastObservation) {
    actual = lastObservation.actual;
    expected = lastObservation.expected;
    semanticStatus = lastObservation.status;
    passed = lastObservation.passed;
  }
  const fatalReadError = readError && !lastObservation;
  const evidence = await store.record(`assertion:${spec.id}`, {
    actual,
    error: readError ? errorInfo(readError) : null,
    pageUrl: page.url(),
  });
  const result: AssertionResult = {
    assertionId: spec.id,
    status: fatalReadError
      ? 'error'
      : passed
        ? 'passed'
        : spec.type === 'plugin'
          ? semanticStatus
          : 'failed',
    evidenceIds: [evidence.id],
    expected,
    actual,
    evaluatorVersion:
      spec.type === 'plugin'
        ? `${spec.plugin}@${plugins?.registry.assertions.get(spec.plugin)?.version}`
        : 'flowprobe/1',
    durationMs: Date.now() - started,
    ...(readError
      ? { errorCode: errorInfo(readError).code, message: errorInfo(readError).message }
      : {}),
  };
  await store.event('assertion.evaluated', result);
  return result;
}
