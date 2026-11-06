import type { TestCase } from '../../protocol/src/index.js';
import { FlowprobeError } from './errors.js';
/** Stable topological order: fixtures may refer to earlier or later declarations. */
export function fixtureOrder(test: TestCase): string[] {
  const output: string[] = [],
    active = new Set<string>(),
    visited = new Set<string>();
  const visit = (name: string): void => {
    if (active.has(name)) throw new FlowprobeError('FIXTURE_CYCLE', name);
    if (visited.has(name)) return;
    const fixture = test.fixtures[name];
    if (!fixture) throw new FlowprobeError('FIXTURE_REFERENCE', name);
    active.add(name);
    for (const match of JSON.stringify(fixture.input).matchAll(/\$\{fixtures\.([\w-]+)\./g))
      visit(match[1]!);
    active.delete(name);
    visited.add(name);
    output.push(name);
  };
  for (const name of Object.keys(test.fixtures)) visit(name);
  return output;
}
