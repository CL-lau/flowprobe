import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './hash.js';

/** Cache compatibility includes the consuming project's dependency lock and exact host runtime. */
export function runtimeFingerprint(directory = process.cwd()): string {
  const locks = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].flatMap((name) => {
    const path = join(directory, name);
    return existsSync(path) ? [{ name, content: readFileSync(path, 'utf8') }] : [];
  });
  return digest({
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    locks,
  });
}
