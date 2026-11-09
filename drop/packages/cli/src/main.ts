#!/usr/bin/env node
import { gatewayConfigSchema } from '../../models/src/index.js';
import { Command } from 'commander';
import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { loadCases, createPlan, verifyPlan, defaultProjects } from '../../compiler/src/index.js';
import { runPlan } from '../../runner-playwright/src/index.js';
import { readJson, writeJson, safePath } from '../../storage/src/index.js';
import { writeReports } from '../../reports/src/index.js';
import { errorInfo } from '../../core/src/errors.js';
import { bundlePlugins } from '../../plugins/src/bundle.js';
import { emptyCatalog } from '../../plugins/src/index.js';
import { ReplayCache } from '../../cache/src/index.js';
import type { Plan, Mode, RunReport } from '../../protocol/src/index.js';

const program = new Command()
  .name('flowprobe')
  .description('Contract-driven web testing')
  .version('0.1.0');
program
  .command('validate')
  .requiredOption('--cases <directory>')
  .option('--plugins <file>', 'trusted TypeScript plugin entry')
  .action(async (options) => {
    const plugins = options.plugins
      ? await bundlePlugins(options.plugins as string, '.flowprobe/plugins')
      : undefined;
    const cases = await loadCases(options.cases as string, {
      catalog: plugins?.catalog ?? emptyCatalog(),
    });
    // Validate plugin capabilities and engine declarations as well as individual schemas.
    createPlan(cases, 'http://validation.local', 'hybrid-frozen', defaultProjects, plugins);
    console.log(`Validated ${cases.length} cases`);
  });
program
  .command('plan')
  .requiredOption('--cases <directory>')
  .requiredOption('--base-url <url>')
  .option('--model-config <file>', 'JSON model gateway configuration without credentials')
  .option('--plugins <file>', 'trusted TypeScript plugin entry')
  .option('--cache-dir <directory>', 'replay cache directory')
  .option('--app-id <identity>')
  .option('--build-id <version>')
  .option('--channel <channel>', 'installed Chromium channel: chrome or msedge')
  .option('--mode <mode>', 'deterministic, hybrid-frozen, learn or explore', 'deterministic')
  .option('--output <path>', 'plan file', '.flowprobe/plan.json')
  .action(async (options) => {
    if (!['deterministic', 'hybrid-frozen', 'learn', 'explore'].includes(options.mode as string))
      throw new Error('Invalid execution mode');
    const mode = options.mode as Mode;
    if (options.channel && !['chrome', 'msedge'].includes(options.channel as string))
      throw new Error('Unsupported channel');
    if (options.cacheDir && (!options.appId || !options.buildId))
      throw new Error('Cache requires --app-id and --build-id');
    const projects = defaultProjects.map((p) => ({
      ...p,
      ...(options.channel ? { channel: options.channel as 'chrome' | 'msedge' } : {}),
    }));
    const plugins = options.plugins
      ? await bundlePlugins(options.plugins as string, '.flowprobe/plugins')
      : undefined;
    const models = options.modelConfig
      ? gatewayConfigSchema.parse(await readJson(resolve(options.modelConfig as string)))
      : undefined;
    const cache = options.cacheDir
      ? {
          directory: resolve(options.cacheDir as string),
          appIdentity: options.appId as string,
          buildId: options.buildId as string,
        }
      : undefined;
    const plan = createPlan(
      await loadCases(options.cases as string, {
        mode,
        catalog: plugins?.catalog ?? emptyCatalog(),
      }),
      options.baseUrl as string,
      mode,
      projects,
      plugins,
      cache,
      models,
    );
    await writeJson(resolve(options.output as string), plan);
    console.log(`Plan ${plan.id}: ${plan.cases.length} cases → ${options.output}`);
  });
program
  .command('run')
  .requiredOption('--plan <path>')
  .option('--output <directory>', 'artifact root', 'artifacts')
  .option('--workers <count>', 'parallel workers', '2')
  .action(async (options) => {
    const workers = Number(options.workers);
    if (!Number.isInteger(workers) || workers < 1 || workers > 64)
      throw new Error('workers must be an integer in 1..64');
    const plan = await readJson<Plan>(resolve(options.plan as string));
    verifyPlan(plan);
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      const report = await runPlan(plan, {
        outputRoot: options.output as string,
        workers,
        signal: controller.signal,
      });
      console.log(
        `Gate: ${report.gate.passed ? 'PASS' : 'FAIL'} · ${report.gate.reasons.join(', ')}`,
      );
      console.log(`Report: ${resolve(options.output as string, report.runId, 'index.html')}`);
      process.exitCode = report.gate.exitCode;
    } finally {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
    }
  });
program
  .command('report')
  .requiredOption('--run <directory>')
  .action(async (options) => {
    const directory = resolve(options.run as string);
    await writeReports(directory, await readJson<RunReport>(resolve(directory, 'report.json')));
    console.log(resolve(directory, 'index.html'));
  });
const cache = program.command('cache').description('Review and promote verified replay templates');
cache
  .command('list')
  .requiredOption('--plan <path>')
  .action(async (options) => {
    const plan = await readJson<Plan>(resolve(options.plan as string));
    verifyPlan(plan);
    if (!plan.cache) throw new Error('Plan has no cache configuration');
    const store = new ReplayCache(plan.cache);
    const files = await readdir(safePath(plan.cache.directory, 'entries'));
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      const entry = await store.read(file.slice(0, -5));
      console.log(
        JSON.stringify({
          id: entry.id,
          state: entry.state,
          attemptId: entry.attemptId,
          verificationIds: entry.verificationIds,
        }),
      );
    }
  });
cache
  .command('promote')
  .requiredOption('--plan <path>')
  .requiredOption('--id <entryId>')
  .requiredOption('--reviewer <name>')
  .action(async (options) => {
    const plan = await readJson<Plan>(resolve(options.plan as string));
    verifyPlan(plan);
    if (!plan.cache) throw new Error('Plan has no cache configuration');
    const entry = await new ReplayCache(plan.cache).promote(
      options.id as string,
      options.reviewer as string,
    );
    console.log(`${entry.id}: ${entry.state}`);
  });
try {
  await program.parseAsync();
} catch (error) {
  console.error(errorInfo(error));
  process.exitCode = 2;
}
