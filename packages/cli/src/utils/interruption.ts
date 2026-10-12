/** Internal cooperative-interruption helpers for CLI write boundaries. */

import { escapeName } from './names.ts';

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

/**
 * Stops awaiting a plugin handler when interrupted; its owning application must
 * then run shutdown hooks to release the handler's resources. The handler's
 * promise remains observed, including any late rejection.
 *
 * @param operation - The plugin handler to start and observe
 * @param signal - Rejects the await with InterruptedError when aborted
 * @returns The handler result if it settles before interruption
 * @throws {InterruptedError} When the signal is aborted
 */
export async function awaitInterruptibly<T>(
  operation: () => Promise<T> | T,
  signal?: AbortSignal,
): Promise<T> {
  throwIfInterrupted(signal);
  if (signal === undefined) return await operation();
  let rejectInterrupted: (cause: InterruptedError) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupted = reject;
  });
  const abort = (): void => rejectInterrupted(new InterruptedError());
  signal.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        throwIfInterrupted(signal);
        return operation();
      }),
      interrupted,
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Returns the user-facing interruption result, including incomplete rollback detail. */
export function interruptionMessage(cause: unknown): string | undefined {
  if (cause instanceof InterruptedError) {
    return 'Interrupted; the files this run wrote were removed.';
  }
  if (cause instanceof AggregateError && cause.cause instanceof InterruptedError) {
    return `Interrupted; rollback was incomplete: ${escapeName(cause.message)}`;
  }
  return undefined;
}
