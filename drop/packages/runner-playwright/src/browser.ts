import type { Locator, Page } from '@playwright/test';
import type { Target, Action } from '../../protocol/src/index.js';
import { FlowprobeError } from '../../core/src/errors.js';

export function scopedUrl(path: string, baseUrl: string): string {
  const target = new URL(path, baseUrl),
    base = new URL(baseUrl);
  if (target.origin !== base.origin || target.username || target.password)
    throw new FlowprobeError('ORIGIN_FORBIDDEN', target.href);
  return target.href;
}
export function locator(page: Page, target: Target): Locator {
  const frame = target.frame ? page.frameLocator(target.frame) : page;
  const root = target.scopeTestId ? frame.getByTestId(target.scopeTestId) : frame;
  let result: Locator;
  if (target.testId !== undefined) result = root.getByTestId(target.testId);
  else if (target.role !== undefined)
    result = root.getByRole(
      target.role as Parameters<Page['getByRole']>[0],
      target.name === undefined ? {} : { name: target.name, exact: true },
    );
  else if (target.label !== undefined) result = root.getByLabel(target.label, { exact: true });
  else if (target.css !== undefined) result = root.locator(target.css);
  else throw new FlowprobeError('LOCATOR_INVALID', 'Missing target');
  return target.matchText === undefined ? result : result.filter({ hasText: target.matchText });
}
export async function executeAction(
  page: Page,
  action: Action,
  baseUrl: string,
  timeout: number,
): Promise<void> {
  switch (action.type) {
    case 'navigate':
      await page.goto(scopedUrl(action.path, baseUrl), { timeout, waitUntil: 'domcontentloaded' });
      return;
    case 'click':
      await locator(page, action.target).click({ timeout });
      return;
    case 'fill':
      await locator(page, action.target).fill(action.value, { timeout });
      return;
    case 'select':
      await locator(page, action.target).selectOption(action.value, { timeout });
      return;
    case 'check':
      await locator(page, action.target).setChecked(action.checked, { timeout });
      return;
    case 'point': {
      const target = locator(page, action.target);
      const box = await target.boundingBox({ timeout });
      if (
        !box ||
        Math.abs(box.width - action.expectedSize.width) > 1 ||
        Math.abs(box.height - action.expectedSize.height) > 1
      )
        throw new FlowprobeError(
          'VISUAL_GEOMETRY_CHANGED',
          'Target geometry differs from the verified visual plan',
        );
      await target.click({
        position: { x: action.x * box.width, y: action.y * box.height },
        timeout,
      });
      return;
    }
    case 'press':
      await locator(page, action.target).press(action.key, { timeout });
      return;
    default:
      throw new FlowprobeError(
        'CAPABILITY_UNSUPPORTED',
        `No executor registered for ${action.type}`,
      );
  }
}
