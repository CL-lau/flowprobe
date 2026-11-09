import { gatewayConfigSchema, type GatewayConfig } from './model.js';

/** A supplied file takes precedence; otherwise use the OpenAI environment directly. */
export function resolveModelConfig(
  input?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  if (input !== undefined) {
    const config = gatewayConfigSchema.parse(input);
    if (!config.keyEnv && new URL(config.endpoint).hostname === 'api.openai.com')
      config.keyEnv = 'OPENAI_API_KEY';
    return config;
  }
  const base = (env['OPENAI_BASE_URL'] || 'https://api.openai.com/v1').replace(/\/+$/, '');
  return gatewayConfigSchema.parse({
    endpoint: `${base}/chat/completions`,
    protocol: 'chat-completions',
    model: env['OPENAI_MODEL'] || 'gpt-6-luna',
    keyEnv: 'OPENAI_API_KEY',
    maxCostPerCallUsd: 0.05,
  });
}
