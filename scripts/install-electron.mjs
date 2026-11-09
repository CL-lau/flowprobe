import { createRequire } from 'node:module';
import { readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const directory = dirname(require.resolve('electron/package.json'));
try {
  const executable = (await readFile(join(directory, 'path.txt'), 'utf8')).trim();
  await access(join(directory, 'dist', executable));
} catch {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {setGlobalDispatcher} from 'undici';import {createModelDispatcher} from './dist/network.js';setGlobalDispatcher(createModelDispatcher());await import('./node_modules/electron/install.js');`,
    ],
    { cwd: process.cwd(), stdio: 'inherit' },
  );
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) throw new Error('Electron 下载失败，请检查系统代理和证书配置');
}
