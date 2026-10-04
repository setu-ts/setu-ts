/** Internal cooperative-interruption helpers for CLI write boundaries. */

/** Raised when an interrupted CLI run reaches a safe stopping point. */
export class InterruptedError extends Error {
  constructor() {
    super('CLI operation interrupted');
    this.name = 'InterruptedError';
  }
}

/** Throws when the supplied interruption signal has been aborted. */
export function throwIfInterrupted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new InterruptedError();
}

/** Returns the user-facing interruption result, including incomplete rollback detail. */
export function interruptionMessage(cause: unknown): string | undefined {
  if (cause instanceof InterruptedError) {
    return 'Interrupted; the files this run wrote were removed.';
  }
  if (cause instanceof AggregateError && cause.cause instanceof InterruptedError) {
    return `Interrupted; rollback was incomplete: ${cause.message}`;
  }
  return undefined;
}
