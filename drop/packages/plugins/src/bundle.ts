import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { PluginRegistry, type PluginSet, type PluginCatalog } from './index.js';
import { FlowprobeError } from '../../core/src/errors.js';

export interface PluginBundle {
  path: string;
  sha256: string;
  catalog: PluginCatalog;
}
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
export async function bundlePlugins(entry: string, directory: string): Promise<PluginBundle> {
  const result = await build({
    entryPoints: [resolve(entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    packages: 'bundle',
    metafile: true,
  });
  const code = result.outputFiles[0]!.text,
    sha256 = hash(code);
  // Every package dependency is bundled; external Node built-ins remain a trusted-code boundary.
  for (const output of Object.values(result.metafile.outputs))
    for (const dependency of output.imports) {
      if (dependency.external && !dependency.path.startsWith('node:'))
        throw new FlowprobeError('PLUGIN_EXTERNAL', dependency.path);
    }
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `${sha256}.mjs`);
  await writeFile(path, code, { mode: 0o600 });
  const registry = await importBundle(path, sha256);
  return { path, sha256, catalog: registry.catalog() };
}
async function importBundle(path: string, expectedHash: string): Promise<PluginRegistry> {
  const code = await readFile(path, 'utf8');
  if (hash(code) !== expectedHash) throw new FlowprobeError('PLUGIN_TAMPERED', path);
  const imported = (await import(`${pathToFileURL(resolve(path)).href}?sha=${expectedHash}`)) as {
    default?: PluginSet;
  };
  if (!imported.default)
    throw new FlowprobeError('PLUGIN_INVALID', 'Plugin module must default-export a PluginSet');
  return new PluginRegistry([imported.default]);
}
export async function loadPluginBundle(bundle: PluginBundle): Promise<PluginRegistry> {
  const registry = await importBundle(bundle.path, bundle.sha256);
  if (registry.catalog().digest !== bundle.catalog.digest)
    throw new FlowprobeError('PLUGIN_TAMPERED', 'Catalog mismatch');
  return registry;
}
