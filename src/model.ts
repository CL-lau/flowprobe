import { z } from 'zod';
import { fetch } from 'undici';
import { createModelDispatcher } from './network.js';
import { FlowprobeError } from './errors.js';
import { bounded } from './deadline.js';
import { digest } from './hash.js';

export interface ModelRequest {
  task: 'plan' | 'locate' | 'extract' | 'judge' | 'summarize';
  input: unknown;
  responseSchema: Record<string, unknown>;
  maxOutputTokens: number;
}
export interface ModelQuote {
  maxCostUsd: number;
}
export const responseSchema = z
  .object({
    output: z.unknown(),
    model: z.string().min(1),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        costUsd: z.number().finite().nonnegative().nullable(),
      })
      .strict(),
  })
  .strict();
export type ModelResponse = z.infer<typeof responseSchema>;
export interface ModelProvider {
  readonly name: string;
  quote(request: ModelRequest): ModelQuote;
  generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}
export interface ModelClient {
  generate(request: ModelRequest, signal: AbortSignal): Promise<unknown>;
}
export interface UsageRecord {
  callId: number;
  provider: string;
  task: ModelRequest['task'];
  inputDigest: string;
  state: 'running' | 'completed' | 'unknown' | 'overrun' | 'invalid';
  reservedUsd: number;
  chargedUsd: number;
  actualCostUsd: number | null;
  responseModel?: string;
  inputTokens: number;
  outputTokens: number;
}
export interface ModelLimits {
  maxCalls: number;
  maxCostUsd: number;
  maxConcurrent: number;
  timeoutMs: number;
}
const micro = (usd: number): number => Math.ceil(usd * 1_000_000);

/** Reserves synchronously before yielding, preventing concurrent calls overspending the same budget. */
export class ModelGateway implements ModelClient {
  readonly records: UsageRecord[] = [];
  private calls = 0;
  private inFlight = 0;
  private committedMicro = 0;
  private poisoned = false;
  constructor(
    readonly provider: ModelProvider,
    readonly limits: ModelLimits,
    private readonly emit: (record: UsageRecord) => Promise<void> = async () => {},
  ) {
    z.object({
      maxCalls: z.number().int().nonnegative(),
      maxCostUsd: z.number().finite().nonnegative(),
      maxConcurrent: z.number().int().positive(),
      timeoutMs: z.number().int().positive(),
    }).parse(limits);
  }
  summary(): { calls: number; chargedUsd: number; unknownCalls: number; inFlight: number } {
    return {
      calls: this.calls,
      chargedUsd: this.committedMicro / 1_000_000,
      unknownCalls: this.records.filter((r) => r.actualCostUsd === null).length,
      inFlight: this.inFlight,
    };
  }
  async generate(request: ModelRequest, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (this.poisoned)
      throw new FlowprobeError('MODEL_ACCOUNTING', 'Provider violated its cost reservation');
    if (this.calls >= this.limits.maxCalls)
      throw new FlowprobeError('MODEL_CALL_BUDGET', 'Model call limit reached');
    if (this.inFlight >= this.limits.maxConcurrent)
      throw new FlowprobeError('MODEL_CONCURRENCY', 'Model concurrency limit reached');
    if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1)
      throw new FlowprobeError('MODEL_REQUEST', 'maxOutputTokens must be positive');
    const quote = this.provider.quote(request);
    if (!Number.isFinite(quote.maxCostUsd) || quote.maxCostUsd <= 0)
      throw new FlowprobeError('MODEL_QUOTE', 'A positive maximum cost reservation is required');
    const reservation = micro(quote.maxCostUsd);
    if (this.committedMicro + reservation > micro(this.limits.maxCostUsd))
      throw new FlowprobeError('MODEL_COST_BUDGET', 'Insufficient remaining cost budget');
    const record: UsageRecord = {
      callId: ++this.calls,
      provider: this.provider.name,
      task: request.task,
      inputDigest: digest(request.input),
      state: 'running',
      reservedUsd: reservation / 1_000_000,
      chargedUsd: reservation / 1_000_000,
      actualCostUsd: null,
      inputTokens: 0,
      outputTokens: 0,
    };
    this.records.push(record);
    this.committedMicro += reservation;
    this.inFlight++;
    try {
      await this.emit({ ...record });
      const response = responseSchema.parse(
        await bounded(
          (child) => this.provider.generate(request, child),
          this.limits.timeoutMs,
          signal,
        ),
      );
      record.responseModel = response.model;
      record.inputTokens = response.usage.inputTokens;
      record.outputTokens = response.usage.outputTokens;
      record.actualCostUsd = response.usage.costUsd;
      if (response.usage.costUsd === null) record.state = 'unknown';
      else {
        const actual = micro(response.usage.costUsd);
        this.committedMicro += actual - reservation;
        record.chargedUsd = actual / 1_000_000;
        if (actual > reservation) {
          record.state = 'overrun';
          this.poisoned = true;
          throw new FlowprobeError('MODEL_COST_OVERRUN', 'Provider exceeded reserved cost');
        }
        record.state = 'completed';
      }
      if (response.usage.outputTokens > request.maxOutputTokens) {
        record.state = 'invalid';
        throw new FlowprobeError('MODEL_OUTPUT_LIMIT', 'Provider exceeded output token limit');
      }
      if (!Object.hasOwn(response, 'output'))
        throw new FlowprobeError('MODEL_OUTPUT_MISSING', 'Missing structured output');
      return response.output;
    } catch (error) {
      if (record.state === 'running') record.state = 'unknown';
      // Failed or timed-out requests may already be billed. Never refund an unknown call.
      throw error;
    } finally {
      this.inFlight--;
      await this.emit({ ...record });
    }
  }
}

export const gatewayConfigSchema = z
  .object({
    endpoint: z.url(),
    protocol: z.enum(['chat-completions', 'gateway']).default('chat-completions'),
    model: z.string().min(1),
    keyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
    maxCostPerCallUsd: z.number().finite().positive(),
    maxOutputTokens: z.number().int().positive().max(32768).default(4096),
    timeoutMs: z.number().int().positive().max(180000).default(30000),
    maxConcurrent: z.number().int().positive().max(16).default(1),
  })
  .strict();
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

/** Supports chat-completions endpoints and the archived provider-neutral gateway protocol. */
export class HttpModelProvider implements ModelProvider {
  readonly name = 'http-json';
  private readonly dispatcher = createModelDispatcher();
  readonly config: GatewayConfig;
  constructor(input: GatewayConfig) {
    this.config = gatewayConfigSchema.parse(input);
    const url = new URL(this.config.endpoint);
    if (
      url.username ||
      url.password ||
      url.hash ||
      (!['https:'].includes(url.protocol) &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
      throw new FlowprobeError('MODEL_ENDPOINT', 'Model gateway requires HTTPS or loopback HTTP');
  }
  quote(request: ModelRequest): ModelQuote {
    if (request.maxOutputTokens > this.config.maxOutputTokens)
      throw new FlowprobeError(
        'MODEL_OUTPUT_LIMIT',
        'Requested output exceeds provider configuration',
      );
    return { maxCostUsd: this.config.maxCostPerCallUsd };
  }
  async close(): Promise<void> {
    await this.dispatcher.close();
  }
  async generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const secret = this.config.keyEnv ? process.env[this.config.keyEnv] : undefined;
    if (this.config.keyEnv && !secret)
      throw new FlowprobeError(
        'MODEL_CREDENTIAL',
        `Missing environment variable ${this.config.keyEnv}`,
      );
    const input = request.input as { observation?: { image?: { data: string; mimeType: string } } };
    const image = input.observation?.image;
    const textInput = structuredClone(request.input) as typeof input;
    if (textInput.observation) delete textInput.observation.image;
    const prompt = JSON.stringify({
      task: request.task,
      input: textInput,
      responseSchema: request.responseSchema,
    });
    const body =
      this.config.protocol === 'gateway'
        ? { ...request, model: this.config.model }
        : {
            model: this.config.model,
            messages: [
              {
                role: 'system',
                content:
                  'Execute the user browser task using the supplied observations. Follow input.rules. Return only JSON matching responseSchema.',
              },
              {
                role: 'user',
                content: image
                  ? [
                      { type: 'text', text: prompt },
                      {
                        type: 'image_url',
                        image_url: { url: `data:${image.mimeType};base64,${image.data}` },
                      },
                    ]
                  : prompt,
              },
            ],
            response_format: { type: 'json_object' },
            max_completion_tokens: request.maxOutputTokens,
          };
    const response = await fetch(this.config.endpoint, {
      ...(['localhost', '127.0.0.1', '[::1]'].includes(new URL(this.config.endpoint).hostname)
        ? {}
        : { dispatcher: this.dispatcher }),
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'content-type': 'application/json',
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new FlowprobeError(
        response.status === 429 ? 'MODEL_RATE_LIMIT' : 'MODEL_HTTP',
        `Model gateway returned HTTP ${response.status}`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new FlowprobeError('MODEL_RESPONSE', 'Missing body');
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 2_000_000) {
          await reader.cancel();
          throw new FlowprobeError('MODEL_RESPONSE_SIZE', 'Model response exceeds 2 MB');
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (this.config.protocol === 'gateway') return responseSchema.parse(parsed);
    const chat = z
      .object({
        model: z.string().optional(),
        choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
        usage: z
          .object({
            prompt_tokens: z.number().int().nonnegative(),
            completion_tokens: z.number().int().nonnegative(),
          })
          .optional(),
      })
      .parse(parsed);
    return {
      output: JSON.parse(chat.choices[0]!.message.content),
      model: chat.model ?? this.config.model,
      usage: {
        inputTokens: chat.usage?.prompt_tokens ?? 0,
        outputTokens: chat.usage?.completion_tokens ?? 0,
        costUsd: null,
      },
    };
  }
}
