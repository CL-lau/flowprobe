import { FlowprobeError } from './errors.js';
/** Propagate cancellation and reject callers even if a trusted plugin ignores its signal.
 * Resource owners must close contexts/processes on abort; rejection alone is not cancellation. */
export async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent: AbortSignal,
): Promise<T> {
  parent.throwIfAborted();
  const controller = new AbortController();
  const parentAbort = (): void => controller.abort(parent.reason);
  parent.addEventListener('abort', parentAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new FlowprobeError('TOOL_TIMEOUT', `Tool exceeded ${timeoutMs}ms`)),
    timeoutMs,
  );
  let rejectAbort: () => void = () => {};
  try {
    const abort = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    return await Promise.race([operation(controller.signal), abort]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', parentAbort);
    controller.signal.removeEventListener('abort', rejectAbort);
    controller.abort(new FlowprobeError('TOOL_FINISHED', 'Tool lifetime ended'));
  }
}
