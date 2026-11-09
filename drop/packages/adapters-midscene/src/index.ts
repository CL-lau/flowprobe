import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { z } from 'zod';
import type { PluginContext, PluginSet } from '../../plugins/src/index.js';
import { FlowprobeError } from '../../core/src/errors.js';

export const midsceneConfigSchema = z
  .object({
    modelName: z.string().min(1),
    modelFamily: z.enum(['qwen3-vl', 'qwen2.5-vl', 'gemini', 'doubao-vision', 'gpt-5', 'gpt-6']),
    maxOutputTokens: z.number().int().positive().max(32768).default(4096),
    replanningCycleLimit: z.number().int().min(1).max(10).default(3),
  })
  .strict();
export type MidsceneConfig = z.infer<typeof midsceneConfigSchema>;
const logScopeKey = Symbol.for('flowprobe.midscene.log-scope.v1');
const processState = globalThis as typeof globalThis & {
  [logScopeKey]?: { scope: AsyncLocalStorage<string>; configured: boolean };
};
const nativeLogs = (processState[logScopeKey] ??= {
  scope: new AsyncLocalStorage<string>(),
  configured: false,
});
interface NativeAgent {
  aiLocate(prompt: string): Promise<{ center?: [number, number]; dpr?: number }>;
  aiAct(prompt: string): Promise<unknown>;
  destroy(): Promise<void>;
}
export interface NativeAgentOptions {
  modelConfig: Record<string, unknown>;
  createOpenAIClient(client: unknown, metadata: Record<string, unknown>): Promise<unknown>;
  cache: false;
  generateReport: false;
  autoPrintReportMsg: false;
  replanningCycleLimit: number;
}
export type MidsceneFactory = (page: Page, options: NativeAgentOptions) => Promise<NativeAgent>;
const completionSchema = z
  .object({
    choices: z
      .array(
        z
          .object({ message: z.object({ content: z.string().min(1).max(64000) }).passthrough() })
          .passthrough(),
      )
      .min(1),
    model: z.string().optional(),
  })
  .passthrough();

async function nativeFactory(page: Page, options: NativeAgentOptions): Promise<NativeAgent> {
  // Optional SDK is imported only when selected. The pinned package is exercised by native smoke tests.
  const moduleName = '@midscene/web/playwright';
  let imported: { PlaywrightAgent: new (page: Page, options: NativeAgentOptions) => NativeAgent };
  try {
    let runtimeRequire = createRequire(import.meta.url);
    try {
      runtimeRequire.resolve(moduleName);
    } catch {
      runtimeRequire = createRequire(join(process.cwd(), 'package.json'));
    }
    let packageDirectory = dirname(runtimeRequire.resolve(moduleName));
    let version: string | undefined;
    for (let level = 0; level < 8; level++) {
      const manifest = join(packageDirectory, 'package.json');
      if (existsSync(manifest)) {
        const data = JSON.parse(readFileSync(manifest, 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (data.name === '@midscene/web') {
          version = data.version;
          break;
        }
      }
      packageDirectory = dirname(packageDirectory);
    }
    if (version !== '1.17.7')
      throw new FlowprobeError('MIDSCENE_VERSION', `Expected 1.17.7, found ${version}`);
    const loggerModule = '@midscene/shared/logger';
    const logger = runtimeRequire(loggerModule) as {
      setLogDirectoryResolver(resolver: () => string): void;
    };
    if (!nativeLogs.configured) {
      logger.setLogDirectoryResolver(
        () => nativeLogs.scope.getStore() ?? join(process.cwd(), '.flowprobe', 'native-unscoped'),
      );
      nativeLogs.configured = true;
    }
    imported = runtimeRequire(moduleName) as typeof imported;
  } catch (cause) {
    throw new FlowprobeError(
      'MIDSCENE_UNAVAILABLE',
      'Install the pinned optional @midscene/web dependency',
      { cause },
    );
  }
  return new imported.PlaywrightAgent(page, options);
}
export function createMidscenePlugins(
  input: MidsceneConfig,
  factory: MidsceneFactory = nativeFactory,
): PluginSet {
  const config = midsceneConfigSchema.parse(input);
  async function withAgent<T>(
    ctx: PluginContext,
    operation: (agent: NativeAgent) => Promise<T>,
  ): Promise<T> {
    if (!ctx.model)
      throw new FlowprobeError(
        'MODEL_PROVIDER_REQUIRED',
        'Midscene requires the metered model gateway',
      );
    ctx.signal.throwIfAborted();
    const model = ctx.model;
    const logDirectory = join(ctx.artifactDirectory, 'native', 'midscene', 'logs');
    await mkdir(logDirectory, { recursive: true });
    return nativeLogs.scope.run(logDirectory, async () => {
      const agent = await factory(ctx.page, {
        cache: false,
        generateReport: false,
        autoPrintReportMsg: false,
        replanningCycleLimit: config.replanningCycleLimit,
        modelConfig: {
          MIDSCENE_MODEL_NAME: config.modelName,
          MIDSCENE_MODEL_FAMILY: config.modelFamily,
          MIDSCENE_MODEL_API_KEY: 'flowprobe-gateway',
          MIDSCENE_MODEL_BASE_URL: 'http://127.0.0.1:1/disabled',
          MIDSCENE_MODEL_STREAM_MODE: 'non-stream',
          MIDSCENE_MODEL_PROTOCOL: 'openai-chat',
        },
        async createOpenAIClient(_client, metadata) {
          // Every completion passes through the host gateway. Never return the SDK's original client.
          return {
            chat: {
              completions: {
                async create(body: Record<string, unknown>, options?: { signal?: AbortSignal }) {
                  ctx.signal.throwIfAborted();
                  if (body['stream'] === true)
                    throw new FlowprobeError(
                      'MIDSCENE_STREAM',
                      'Streaming is disabled for metered calls',
                    );
                  const signal = options?.signal
                    ? AbortSignal.any([ctx.signal, options.signal])
                    : ctx.signal;
                  const requestBody = {
                    ...body,
                    stream: false,
                    max_tokens: config.maxOutputTokens,
                  };
                  delete requestBody['max_completion_tokens' as keyof typeof requestBody];
                  const evidenceId = await ctx.recordObservation('midscene.request', {
                    intent: metadata['intent'] ?? 'unknown',
                    requestBody,
                  });
                  return completionSchema.parse(
                    await model.generate(
                      {
                        task: metadata['intent'] === 'locate' ? 'locate' : 'plan',
                        input: {
                          protocol: 'openai-chat-completions',
                          adapter: 'midscene/1.17.7',
                          evidenceId,
                          requestBody,
                        },
                        responseSchema: { type: 'object', required: ['choices'] },
                        maxOutputTokens: config.maxOutputTokens,
                      },
                      signal,
                    ),
                  );
                },
              },
            },
            responses: {
              async create() {
                throw new FlowprobeError('MIDSCENE_PROTOCOL', 'Responses protocol is not enabled');
              },
            },
          };
        },
      });
      try {
        ctx.signal.throwIfAborted();
        return await operation(agent);
      } finally {
        await agent.destroy();
      }
    });
  }
  return {
    protocolMajor: 1,
    planners: [
      {
        name: 'midscene.locate',
        version: '1.17.7',
        modelBased: true,
        async plan(action, ctx) {
          const target = ctx.page.getByTestId(action.scope.component);
          if ((await target.count()) !== 1)
            throw new FlowprobeError('MIDSCENE_SCOPE', 'Scope must identify one component');
          if ((await ctx.page.evaluate(() => devicePixelRatio)) !== 1)
            throw new FlowprobeError(
              'MIDSCENE_DPR',
              'Native locator replay currently requires devicePixelRatio 1',
            );
          await target.scrollIntoViewIfNeeded();
          const before = await target.boundingBox();
          if (!before) throw new FlowprobeError('MIDSCENE_SCOPE', 'Scope is not visible');
          const location = await withAgent(ctx, (agent) => agent.aiLocate(action.text));
          const box = await target.boundingBox();
          if (
            !box ||
            Math.abs(before.x - box.x) > 1 ||
            Math.abs(before.y - box.y) > 1 ||
            Math.abs(before.width - box.width) > 1 ||
            Math.abs(before.height - box.height) > 1
          )
            throw new FlowprobeError(
              'VISUAL_GEOMETRY_CHANGED',
              'Scope moved during native localization',
            );
          if (!location.center || !location.center.every(Number.isFinite))
            throw new FlowprobeError('MIDSCENE_LOCATION', 'No valid target center');
          const [x, y] = location.center;
          if (x < box.x || x >= box.x + box.width || y < box.y || y >= box.y + box.height)
            throw new FlowprobeError(
              'MIDSCENE_SCOPE',
              'Native target lies outside the declared component',
            );
          await ctx.recordObservation('midscene.location', {
            location,
            component: action.scope.component,
            box,
          });
          return [
            {
              type: 'point',
              target: { testId: action.scope.component },
              x: (x - box.x) / box.width,
              y: (y - box.y) / box.height,
              expectedSize: { width: box.width, height: box.height },
              effect: action.effect,
            },
          ];
        },
      },
    ],
    actions: [
      {
        name: 'midscene.act',
        version: '1.17.7',
        async execute(input, ctx) {
          const { instruction } = z
            .object({ instruction: z.string().min(1).max(10000) })
            .strict()
            .parse(input);
          // This explicit action is page-scoped. Only locate supports bounded component primitives/replay.
          await withAgent(ctx, async (agent) => {
            await agent.aiAct(instruction);
          });
        },
      },
    ],
  };
}
