import { HttpModelProvider } from '../../models/src/index.js';
import { loadPluginBundle } from '../../plugins/src/bundle.js';
import { PluginRegistry } from '../../plugins/src/index.js';
import { ReplayCache } from '../../cache/src/index.js';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Plan, CaseResult } from '../../protocol/src/index.js';
import { verifyPlan } from '../../compiler/src/index.js';
import { runAttempt } from './attempt.js';
import { safePath, writeJson } from '../../storage/src/index.js';

const planFile = process.env['FLOWPROBE_PLAN'];
if (!planFile) throw new Error('FLOWPROBE_PLAN is required');
const plan = JSON.parse(await readFile(planFile, 'utf8')) as Plan;
verifyPlan(plan);
const modelProvider = plan.models ? new HttpModelProvider(plan.models) : undefined;
const registry = plan.plugins ? await loadPluginBundle(plan.plugins) : new PluginRegistry();
const cache = plan.cache ? new ReplayCache(plan.cache) : undefined;
const output = resolve(process.env['FLOWPROBE_OUTPUT']!);
for (const compiled of plan.cases) {
  for (const projectName of compiled.test.projects) {
    const project = plan.projects.find((p) => p.name === projectName)!;
    test(`${compiled.test.id} [${projectName}]`, async ({ playwright }) => {
      test.setTimeout(
        compiled.test.policy.maxAttempts * (compiled.test.policy.attemptTimeoutMs + 15000) + 15000,
      );
      const browser = await playwright[project.browser].launch(
        project.channel ? { channel: project.channel } : {},
      );
      const attempts: CaseResult['attempts'] = [];
      try {
        for (let i = 0; i < compiled.test.policy.maxAttempts; i++) {
          const attempt = await runAttempt({
            browser,
            compiled,
            project,
            baseUrl: plan.baseUrl,
            runId: process.env['FLOWPROBE_RUN_ID']!,
            outputDirectory: output,
            registry,
            mode: plan.mode,
            ...(modelProvider
              ? {
                  modelProvider,
                  modelTimeoutMs: plan.models!.timeoutMs,
                  modelConcurrency: plan.models!.maxConcurrent,
                }
              : {}),
            ...(cache ? { cache } : {}),
            ...(plan.plugins ? { pluginDigest: plan.plugins.sha256 } : {}),
          });
          attempts.push(attempt);
          if (
            attempt.outcome === 'passed' ||
            attempt.outcome === 'cancelled' ||
            compiled.test.steps.some((s) => s.action.effect === 'non-idempotent')
          )
            break;
        }
      } finally {
        await browser.close();
      }
      const result: CaseResult = {
        caseId: compiled.test.id,
        project: projectName,
        outcome: attempts.at(-1)?.outcome ?? 'error',
        flaky: attempts.length > 1 && attempts.at(-1)?.outcome === 'passed',
        attempts,
      };
      await writeJson(safePath(output, `results/${compiled.test.id}--${projectName}.json`), result);
      expect(result.outcome).toBe('passed');
    });
  }
}
