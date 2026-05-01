// Minimal in-process FIFO queue with bounded concurrency. Acceptable per the
// spec for a 3-hour timebox; in production this would be BullMQ/SQS/SNS so
// jobs survive restarts and can be observed/retried out-of-band.
//
// Tradeoff: jobs in flight or queued at process exit are LOST (status will
// remain RECEIVED or ANALYZING in the DB). The retry endpoint exists to
// recover stuck items.

export type JobHandler<T> = (payload: T) => Promise<void>;

export interface QueueOptions {
  concurrency?: number;
  // Called when a handler throws after all internal recovery has been
  // exhausted. Defaults to console.error -- production would route to Sentry.
  onUnhandledError?: (err: unknown, payload: unknown) => void;
}

export class InMemoryQueue<T> {
  private readonly buffer: T[] = [];
  private handler: JobHandler<T> | null = null;
  private readonly concurrency: number;
  private active = 0;
  private draining = false;
  private resolveDrain: (() => void) | null = null;
  private readonly onUnhandledError: (err: unknown, payload: unknown) => void;

  constructor(opts: QueueOptions = {}) {
    this.concurrency = Math.max(1, opts.concurrency ?? 1);
    this.onUnhandledError =
      opts.onUnhandledError ??
      ((err, payload) => {
        // eslint-disable-next-line no-console
        console.error("[queue] unhandled job error", { err, payload });
      });
  }

  public registerHandler(handler: JobHandler<T>): void {
    if (this.handler) {
      throw new Error("InMemoryQueue: handler already registered");
    }
    this.handler = handler;
  }

  public enqueue(payload: T): void {
    if (this.draining) {
      throw new Error("InMemoryQueue: cannot enqueue while draining");
    }
    this.buffer.push(payload);
    this.pump();
  }

  public size(): number {
    return this.buffer.length;
  }

  public inFlight(): number {
    return this.active;
  }

  // Wait until the queue is empty AND all in-flight jobs have settled.
  // Useful for tests; production code should call shutdown().
  public async idle(): Promise<void> {
    if (this.buffer.length === 0 && this.active === 0) return;
    await new Promise<void>((resolve) => {
      const tick = () => {
        if (this.buffer.length === 0 && this.active === 0) {
          resolve();
        } else {
          setTimeout(tick, 5);
        }
      };
      tick();
    });
  }

  // Stop accepting new work and wait for in-flight jobs to settle.
  public async shutdown(): Promise<void> {
    this.draining = true;
    if (this.active === 0 && this.buffer.length === 0) return;
    await new Promise<void>((resolve) => {
      this.resolveDrain = resolve;
    });
  }

  private pump(): void {
    if (!this.handler) return;
    while (this.active < this.concurrency && this.buffer.length > 0) {
      const payload = this.buffer.shift() as T;
      this.active += 1;
      // Fire and forget; errors are caught and reported but never crash the pump.
      void this.runOne(payload);
    }
  }

  private async runOne(payload: T): Promise<void> {
    try {
      // The handler is non-null because pump() guards on it.
      await (this.handler as JobHandler<T>)(payload);
    } catch (err) {
      this.onUnhandledError(err, payload);
    } finally {
      this.active -= 1;
      if (this.draining && this.active === 0 && this.buffer.length === 0) {
        this.resolveDrain?.();
        this.resolveDrain = null;
      } else {
        this.pump();
      }
    }
  }
}
