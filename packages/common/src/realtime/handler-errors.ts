/**
 * Clock-free, per-subscriber failure reporting for realtime transports.
 *
 * @module
 * @since 0.11.0
 */
import { describeError } from '../errors/describe-error.ts';
import type { ConnectionErrorLogger } from '../health/connection-errors.ts';
import type { RealtimeFrame, RealtimeFrameHandler } from '../services/realtime.ts';

/**
 * Failure and recovery sink used by {@linkcode dispatchRealtimeFrame}.
 * Methods must not throw, including when called from a promise reaction.
 *
 * @since 0.11.0
 */
export interface IRealtimeHandlerErrorReporter {
  /**
   * Records a synchronous throw or asynchronous rejection.
   * @param handler - The failed subscriber, used as a weak identity key
   * @param error - The thrown or rejected value
   * @param frame - The arriving frame; its payload must never be logged
   * @returns Nothing
   */
  failed(handler: RealtimeFrameHandler, error: unknown, frame: RealtimeFrame): void;
  /**
   * Records a synchronous return or asynchronous fulfilment.
   * @param handler - The subscriber that completed successfully
   * @returns Nothing
   */
  succeeded(handler: RealtimeFrameHandler): void;
}

/**
 * Configuration for {@linkcode createRealtimeHandlerErrorReporter}.
 *
 * @since 0.11.0
 */
export interface RealtimeHandlerErrorReporterOptions {
  /** Source label included in every diagnostic line and its metadata. */
  readonly source: string;
  /** Call-time logger accessor; returning undefined drops the diagnostic. */
  readonly logger: () => ConnectionErrorLogger | undefined;
  /** Receives every failure instead of default logging; thrown hook errors are swallowed. */
  readonly onHandlerError?: (error: unknown, frame: RealtimeFrame) => void;
}

/**
 * Builds a reporter that warns on the first failure per subscriber, debugs
 * subsequent failures with a running repeat count, and reports recovery once
 * at info. A success rearms the warning. Subscriber identities are weakly held.
 *
 * The optional hook replaces all default logging. Logger and hook failures
 * are swallowed so driver callbacks and promise reactions remain safe.
 * Diagnostics use describeError and never include frame data.
 *
 * @param options - Source, call-time logger and optional replacement hook
 * @returns A reporter whose methods never throw
 * @example
 * ```typescript
 * const reporter = createRealtimeHandlerErrorReporter({
 *   source: 'my-backplane', logger: () => ctx.logger,
 * });
 * dispatchRealtimeFrame(handlers, frame, reporter);
 * ```
 * @since 0.11.0
 */
export function createRealtimeHandlerErrorReporter(
  options: RealtimeHandlerErrorReporterOptions,
): IRealtimeHandlerErrorReporter {
  const failures = new WeakMap<RealtimeFrameHandler, number>();
  const { source } = options;
  const write = (action: (logger: ConnectionErrorLogger) => void): void => {
    try {
      const logger = options.logger();
      if (logger !== undefined) action(logger);
    } catch {
      // Reporting must not create an uncaught exception or rejected reaction.
    }
  };
  return {
    failed(handler, error, frame): void {
      if (options.onHandlerError !== undefined) {
        try {
          options.onHandlerError(error, frame);
        } catch {
          // The application owns this replacement sink; a sink failure is dropped.
        }
        return;
      }
      const previous = failures.get(handler) ?? 0;
      failures.set(handler, previous + 1);
      const description = describeError(error);
      const metadata = { source, error: description, frameKind: frame.kind, frameName: frame.name };
      if (previous === 0) {
        write((logger) => logger.warn(`${source}: subscriber failed: ${description}`, metadata));
      } else {
        write((logger) =>
          logger.debug(`${source}: subscriber failed: ${description}`, {
            ...metadata,
            repeats: previous,
          }),
        );
      }
    },
    succeeded(handler): void {
      const count = failures.get(handler);
      if (count === undefined) return;
      failures.delete(handler);
      write((logger) =>
        logger.info(`${source}: subscriber recovered after ${count} failures`, {
          source,
          failures: count,
        }),
      );
    },
  };
}
