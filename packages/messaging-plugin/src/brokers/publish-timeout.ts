import { deadlineRangeError } from '@setu-ts/common';

/** Default bound on one publish, including its confirm, in ms. */
export const DEFAULT_PUBLISH_TIMEOUT_MS = 15_000;

/**
 * Resolves and validates `publishTimeoutMs`. Shared by
 * `MessagingPlugin(...)` (which refuses a bad value at construction) and the
 * broker constructor, so both read one rule.
 *
 * @param value - The configured bound, or `undefined` for the default
 * @returns The bound in milliseconds (`0` = unbounded)
 * @throws {RangeError} When the value is outside `0`–`2147483647` or not finite
 */
export function resolvePublishTimeoutMs(value: number | undefined): number {
  const resolved = value ?? DEFAULT_PUBLISH_TIMEOUT_MS;
  const refusal = deadlineRangeError('messaging-plugin: publishTimeoutMs', resolved);
  if (refusal !== null) {
    throw refusal;
  }
  return resolved;
}
