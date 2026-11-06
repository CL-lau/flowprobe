import { loadPluginBundle } from '../../plugins/src/bundle.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { Plan, RunReport, CaseResult } from '../../protocol/src/index.js';
import { verifyPlan } from '../../compiler/src/index.js';
import { readJson, safePath, writeJson } from '../../storage/src/index.js';
import { evaluateGate } from '../../core/src/verdict.js';
import { writeReports } from '../../reports/src/index.js';

export async function runPlan(
  plan: Plan,
  options: { outputRoot: string; workers?: number; signal?: AbortSignal },
): Promise<RunReport> {
  verifyPlan(plan);
  if (plan.plugins) await loadPluginBundle(plan.plugins);
  const runId = randomUUID(),
    startedAt = new Date().toISOString();
  const output = safePath(resolve(options.outputRoot), runId);
  await mkdir(output, { recursive: true });
  const planPath = safePath(output, 'plan.json');
  await writeJson(planPath, plan);
  const testDir = dirname(fileURLToPath(import.meta.url));
  const configPath = safePath(output, 'playwright.config.cjs');
  await writeFile(
    configPath,
    `module.exports = ${JSON.stringify({ testDir, testMatch: '**/harness.spec.*', workers: options.workers ?? 2, retries: 0, fullyParallel: true, reporter: [['list']], outputDir: safePath(output, 'playwright') })};\n`,
  );
  const require = createRequire(import.meta.url);
  const cli = require.resolve('@playwright/test/cli');
  let spawnError: Error | undefined;
  const child = spawn(process.execPath, [cli, 'test', '--config', configPath], {
    stdio: 'inherit',
    env: {
      ...process.env,
      FLOWPROBE_PLAN: planPath,
      FLOWPROBE_OUTPUT: output,
      FLOWPROBE_RUN_ID: runId,
    },
  });
  const cancel = (): void => {
    child.kill('SIGTERM');
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const exitCode = await new Promise<number | null>((resolveExit) => {
    child.once('error', (error) => {
      spawnError = error;
      resolveExit(null);
    });
    child.once('close', (code) => resolveExit(code));
  });
  options.signal?.removeEventListener('abort', cancel);
  const results: CaseResult[] = [];
  const resultsDir = safePath(output, 'results');
  try {
    for (const file of (await readdir(resultsDir)).filter((f) => f.endsWith('.json')).sort())
      results.push(await readJson<CaseResult>(safePath(resultsDir, file)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const gate = evaluateGate(plan, results);
  if (options.signal?.aborted) {
    gate.passed = false;
    gate.exitCode = 4;
    gate.reasons.push('CANCELLED');
  } else if (spawnError || (exitCode !== 0 && gate.passed)) {
    gate.passed = false;
    gate.exitCode = 3;
    gate.reasons.push(`RUNNER_ERROR:${spawnError?.message ?? exitCode}`);
  }
  const report: RunReport = {
    schemaVersion: 1,
    runId,
    plan,
    startedAt,
    finishedAt: new Date().toISOString(),
    cases: results,
    gate,
  };
  await writeReports(output, report);
  return report;
}
