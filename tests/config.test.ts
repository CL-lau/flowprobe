import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelConfig } from '../src/config.js';

test('OpenAI environment resolves official endpoint and key name without a config file', () => {
  const config = resolveModelConfig(undefined, { OPENAI_MODEL: 'test-model' });
  assert.equal(config.endpoint, 'https://api.openai.com/v1/chat/completions');
  assert.equal(config.keyEnv, 'OPENAI_API_KEY');
  assert.equal(config.model, 'test-model');
  assert.equal(config.protocol, 'chat-completions');
  assert.equal(resolveModelConfig(undefined, {}).model, 'gpt-6-luna');
});

test('OpenAI base URL is normalized and explicit file config takes precedence', () => {
  assert.equal(
    resolveModelConfig(undefined, {
      OPENAI_MODEL: 'test',
      OPENAI_BASE_URL: 'https://api.example.test/v1/',
    }).endpoint,
    'https://api.example.test/v1/chat/completions',
  );
  const config = resolveModelConfig(
    {
      endpoint: 'https://api.openai.com/v1/chat/completions',
      model: 'from-file',
      maxCostPerCallUsd: 0.01,
    },
    { OPENAI_MODEL: 'from-env' },
  );
  assert.equal(config.model, 'from-file');
  assert.equal(config.keyEnv, 'OPENAI_API_KEY');
  assert.equal(
    resolveModelConfig({
      endpoint: 'http://127.0.0.1/model',
      model: 'fixture',
      maxCostPerCallUsd: 0.01,
    }).keyEnv,
    undefined,
  );
});
