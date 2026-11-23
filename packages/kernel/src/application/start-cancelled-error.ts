/**
 * The rejection of a `start()` that `stop()` cancelled before it finished.
 *
 * @module
 */

/**
 * Thrown by `start()` when `stop()` cancelled a start that had not yet
 * passed its last step. A `stop()` that lands after that point, but before
 * `start()` settles, does not cancel: `start()` resolves and `stop()` shuts
 * down normally.
 *
 * The close hooks registered before the cancellation have run by the time it
 * is thrown; a close hook an abandoned step registers afterwards is started
 * at once but not awaited. No later startup step runs: a `listen()` already
 * pending may still bind, and the kernel closes that handle as soon as it
 * resolves. An entry point can tell a cancelled start (the process is being
 * stopped on purpose) from a start that failed with `instanceof`.
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
