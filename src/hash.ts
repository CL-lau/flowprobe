import { createHash } from 'node:crypto';
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const result = JSON.stringify(value);
    if (result === undefined) throw new TypeError('Cannot hash undefined');
    return result;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`;
}
export const digest = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');
