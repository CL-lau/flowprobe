export type ControlState = 'running' | 'pausing' | 'manual';

/** Pauses at operation boundaries and invalidates every plan made before a handoff. */
export class TaskControl {
  private paused = false;
  private active = 0;
  private revision = 0;
  private wake = new Set<() => void>();
  private idle = new Set<() => void>();
  constructor(private readonly onState: (state: ControlState) => void = () => {}) {}
  isCurrent(revision: number): boolean {
    return !this.paused && revision === this.revision;
  }
  async checkpoint(signal: AbortSignal): Promise<number> {
    signal.throwIfAborted();
    while (this.paused) {
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          this.wake.delete(done);
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          this.wake.delete(done);
          signal.removeEventListener('abort', abort);
          reject(signal.reason);
        };
        this.wake.add(done);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    signal.throwIfAborted();
    return this.revision;
  }
  beginOperation(revision: number): boolean {
    if (!this.isCurrent(revision)) return false;
    this.active++;
    return true;
  }
  endOperation(): void {
    this.active = Math.max(0, this.active - 1);
    if (this.active === 0) {
      if (this.paused) this.onState('manual');
      for (const done of this.idle) done();
      this.idle.clear();
    }
  }
  async pause(): Promise<void> {
    this.paused = true;
    this.revision++;
    this.onState(this.active ? 'pausing' : 'manual');
    if (this.active) await new Promise<void>((resolve) => this.idle.add(resolve));
  }
  resume(): void {
    if (this.active) throw new Error('Wait for the active operation to finish before resuming');
    this.paused = false;
    this.revision++;
    this.onState('running');
    for (const done of this.wake) done();
  }
}
