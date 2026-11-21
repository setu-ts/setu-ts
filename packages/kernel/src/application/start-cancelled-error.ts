/**
 * The rejection of a `start()` that `stop()` cancelled before it finished.
 *
 * @module
 */

/**
 * Thrown by `start()` when `stop()` was called before the start finished.
 *
 * The close hooks of every plugin that registered have run by the time it is
 * thrown, and the application never listens afterwards. An entry point can
 * tell a cancelled start (the process is being stopped on purpose) from a
 * start that failed with `instanceof`.
 *
 * @example
 * ```typescript
 * import { StartCancelledError } from '@setu-ts/kernel';
 *
 * try {
 *   await app.start({ port: 3000 });
 * } catch (error) {
 *   if (!(error instanceof StartCancelledError)) throw error;
 * }
 * ```
 * @since 0.14.0
 */
export class StartCancelledError extends Error {
  /** Creates the error with its fixed message. */
  constructor() {
    super('start() was cancelled by stop()');
    this.name = 'StartCancelledError';
  }
}
