/**
 * Shared subscriber isolation for every realtime backplane transport.
 * @module
 * @since 0.11.0
 */
import type { RealtimeFrame, RealtimeFrameHandler } from '../services/realtime.ts';
import type { IRealtimeHandlerErrorReporter } from './handler-errors.ts';

/**
 * Delivers a frame to a snapshot of the handlers, isolating synchronous throws
 * and returned thenable rejections so one subscriber cannot starve another.
 * Successful completion calls succeeded, including asynchronous fulfilment.
 *
 * @param handlers - Subscribers to snapshot before delivery
 * @param frame - The frame to deliver
 * @param reporter - Non-throwing per-subscriber failure and recovery sink
 * @returns False if a handler throws synchronously, true otherwise. Async
 * outcomes are unknown at return and do not change this M98l receive result.
 * @example
 * ```typescript
 * const delivered = dispatchRealtimeFrame(handlers, frame, reporter);
 * observer.observe('backplane-receive', delivered);
 * ```
 * @since 0.11.0
 */
export function dispatchRealtimeFrame(
  handlers: Iterable<RealtimeFrameHandler>,
  frame: RealtimeFrame,
  reporter: IRealtimeHandlerErrorReporter,
): boolean {
  let delivered = true;
  for (const handler of [...handlers]) {
    try {
      const result: unknown = handler(frame);
      if (
        result !== null &&
        (typeof result === 'object' || typeof result === 'function') &&
        typeof (result as { then?: unknown }).then === 'function'
      ) {
        void Promise.resolve(result).then(
          () => reporter.succeeded(handler),
          (error: unknown) => reporter.failed(handler, error, frame),
        );
      } else {
        reporter.succeeded(handler);
      }
    } catch (error) {
      delivered = false;
      reporter.failed(handler, error, frame);
    }
  }
  return delivered;
}
