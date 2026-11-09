export class FlowprobeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FlowprobeError';
  }
}
export function errorInfo(error: unknown): { code: string; message: string } {
  return {
    code: error instanceof FlowprobeError ? error.code : 'EXECUTION_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}
