import type { Command } from 'commander';
import { chromium, type Page } from '@playwright/test';
import { setTimeout as delay } from 'node:timers/promises';
import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpModelProvider, ModelGateway } from './model.js';
import { resolveModelConfig } from './config.js';
import { executeTask } from './task.js';
import { readJson, writeJson } from './files.js';
import { errorInfo } from './errors.js';

export function registerTask(program: Command): void {
  program
    .command('task')
    .description('Execute a natural-language browser task directly')
    .requiredOption('--url <url>', 'starting page')
    .requiredOption('--task <instruction>', 'task to execute')
    .option('--model-config <file>', 'optional JSON configuration; defaults to OpenAI environment')
    .option('--channel <channel>', 'chrome or msedge')
    .option('--headless', 'run without a visible browser window', false)
    .option('--no-preview', 'disable the on-page cursor and progress overlay')
    .option('--keep-open <ms>', 'keep the final preview visible before closing', '5000')
    .option('--slow-mo <ms>', 'optional delay between browser operations for observation', '0')
    .option('--vision', 'include viewport screenshots in model observations', false)
    .option('--max-turns <count>', 'maximum model calls', '20')
    .option('--timeout <ms>', 'total task timeout', '180000')
    .option('--max-cost <usd>', 'maximum model cost reservation', '1')
    .option('--output <directory>', 'execution artifact root', 'artifacts/tasks')
    .action(async (options) => {
      const maxTurns = Number(options.maxTurns);
      const timeout = Number(options.timeout);
      const maxCost = Number(options.maxCost);
      const keepOpen = Number(options.keepOpen);
      const slowMo = Number(options.slowMo);
      if (!Number.isInteger(slowMo) || slowMo < 0 || slowMo > 5000)
        throw new Error('slow-mo must be an integer in 0..5000');
      if (!Number.isInteger(keepOpen) || keepOpen < 0 || keepOpen > 300000)
        throw new Error('keep-open must be an integer in 0..300000');
      if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 200)
        throw new Error('max-turns must be an integer in 1..200');
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600000)
        throw new Error('timeout must be an integer in 1..3600000');
      if (!Number.isFinite(maxCost) || maxCost <= 0) throw new Error('max-cost must be positive');
      if (options.channel && !['chrome', 'msedge'].includes(options.channel as string))
        throw new Error('Unsupported channel');
      const config = resolveModelConfig(
        options.modelConfig ? await readJson(resolve(options.modelConfig as string)) : undefined,
      );
      const provider = new HttpModelProvider(config);
      if (config.keyEnv && !process.env[config.keyEnv])
        throw new Error(`Missing environment variable ${config.keyEnv}`);
      const directory = resolve(options.output as string, randomUUID());
      await mkdir(directory, { recursive: true });
      console.log(`Task artifacts: ${directory}`);
      const controller = new AbortController();
      const cancel = () => controller.abort(new Error('Task cancelled'));
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      const timer = setTimeout(() => controller.abort(new Error('Task timeout')), timeout);
      const emit = async (event: Record<string, unknown>) => {
        await appendFile(resolve(directory, 'events.jsonl'), JSON.stringify(event) + '\n');
      };
      const model = new ModelGateway(
        provider,
        {
          maxCalls: maxTurns,
          maxCostUsd: maxCost,
          maxConcurrent: 1,
          timeoutMs: config.timeoutMs,
        },
        async (record) => emit({ type: 'model.usage', ...record }),
      );
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
      let page: Page | undefined;
      let context: Awaited<ReturnType<NonNullable<typeof browser>['newContext']>> | undefined;
      const closeOnAbort = () => {
        void browser?.close().catch(() => {});
      };
      controller.signal.addEventListener('abort', closeOnAbort, { once: true });
      try {
        browser = await chromium.launch({
          headless: options.headless as boolean,
          slowMo,
          ...(options.channel ? { channel: options.channel as string } : {}),
          timeout: Math.min(timeout, 30000),
        });
        controller.signal.throwIfAborted();
        context = await browser.newContext({
          viewport: { width: 1280, height: 800 },
          deviceScaleFactor: 1,
        });
        await context.tracing.start({ screenshots: true, snapshots: true });
        page = await context.newPage();
        const result = await executeTask({
          page,
          model,
          task: options.task as string,
          url: options.url as string,
          signal: controller.signal,
          maxTurns,
          actionTimeoutMs: Math.min(timeout, 10000),
          maxOutputTokens: config.maxOutputTokens,
          vision: options.vision as boolean,
          preview: options.preview as boolean,
          emit,
        });
        clearTimeout(timer);
        await page.screenshot({ path: resolve(directory, 'final.png') });
        await writeJson(resolve(directory, 'result.json'), {
          ...result,
          completionSource: 'model',
          usage: model.summary(),
        });
        console.log(`${result.status}: ${result.summary}`);
        process.exitCode = result.status === 'done' ? 0 : 1;
        if (!options.headless && keepOpen > 0 && !controller.signal.aborted) {
          await delay(keepOpen, undefined, { signal: controller.signal }).catch(() => {});
        }
      } catch (error) {
        clearTimeout(timer);
        await page
          ?.screenshot({ path: resolve(directory, 'final.png'), timeout: 2000 })
          .catch(() => {});
        await writeJson(resolve(directory, 'result.json'), {
          status: 'error',
          error: errorInfo(error),
          usage: model.summary(),
        });
        if (!options.headless && keepOpen > 0 && !controller.signal.aborted) {
          await delay(keepOpen, undefined, { signal: controller.signal }).catch(() => {});
        }
        throw error;
      } finally {
        clearTimeout(timer);
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
        controller.signal.removeEventListener('abort', closeOnAbort);
        await context?.tracing.stop({ path: resolve(directory, 'trace.zip') }).catch(() => {});
        await browser?.close();
        await provider.close();
      }
    });
}
