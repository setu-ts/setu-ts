/**
 * Logging that cannot change an idempotency outcome.
 *
 * @module
 */
import type { ILogger } from '@setu-ts/common';

/**
 * Writes one log line through a call-time logger thunk, discarding anything
 * the logger throws.
 *
 * Every idempotency log line sits on a request or delivery path, between a
 * claim and its settlement. A logger that throws there (a broken transport)
 * used to propagate: a request whose handler had already run answered 500,
 * the claim was never completed, and the key stayed locked; inside a `catch`,
 * the logger's error replaced the original one (M109a audit, round 3, O1).
 * A log line is never worth more than the outcome it describes.
 *
 * @internal
 * @param logger - The logger thunk, read at call time
 * @param level - The log level
 * @param message - The message
 * @param meta - Structured metadata
 */
export function safeLog(
  logger: () => ILogger | undefined,
  level: 'debug' | 'warn' | 'error',
  message: string,
  meta: Record<string, unknown>,
): void {
  try {
    logger()?.[level](message, meta);
  } catch {
    // Deliberately discarded: see the module comment.
  }
}

/**
 * Describes a thrown value for a log line without ever throwing itself.
 *
 * `String(value)` throws for a value with no usable conversion, such as
 * `Object.create(null)`. A store that rejects with one made the log line's
 * metadata throw outside `safeLog`'s guard, which changed the outcome it
 * described (M109a audit round 5): a store outage answered `500` instead of
 * `503`, and an ingress settle failure became a redelivery.
 *
 * @internal
 * @param value - Whatever was thrown or rejected
 * @returns The error's message, else its string form, else its `typeof`
 */
export function describeThrown(value: unknown): string {
  try {
    return value instanceof Error ? String(value.message) : String(value);
  } catch {
    return typeof value;
  }
}
