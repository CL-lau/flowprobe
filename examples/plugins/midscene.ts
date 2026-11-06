import { createMidscenePlugins } from '../../packages/adapters-midscene/src/index.js';
export default createMidscenePlugins({
  modelName: 'configured-at-gateway',
  modelFamily: 'qwen3-vl',
  maxOutputTokens: 4096,
  replanningCycleLimit: 3,
});
