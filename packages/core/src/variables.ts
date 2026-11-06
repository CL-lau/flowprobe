import { FlowprobeError } from './errors.js';
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
export function readPath(root: unknown, path: string): unknown {
  let value = root;
  for (const part of path.split('.')) {
    if (
      !/^[\w-]+$/.test(part) ||
      unsafe.has(part) ||
      value === null ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, part)
    )
      throw new FlowprobeError('VARIABLE_MISSING', `Unknown or unsafe path: ${path}`);
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
export function resolveVariables<T>(value: T, context: Record<string, unknown>): T {
  if (typeof value === 'string') {
    const exact = /^\$\{([\w.-]+)\}$/.exec(value);
    if (exact) return readPath(context, exact[1]!) as T;
    const result = value.replace(/\$\{([\w.-]+)\}/g, (_, path: string) => {
      const resolved = readPath(context, path);
      if (!['string', 'number', 'boolean'].includes(typeof resolved))
        throw new FlowprobeError('VARIABLE_TYPE', `Non-scalar substitution: ${path}`);
      return String(resolved);
    });
    if (result.includes('${'))
      throw new FlowprobeError('VARIABLE_SYNTAX', `Unsupported expression: ${value}`);
    return result as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolveVariables(v, context)) as T;
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveVariables(v, context)]),
    ) as T;
  return value;
}
