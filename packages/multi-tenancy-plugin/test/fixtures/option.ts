/**
 * Option narrowing helper for tests.
 *
 * `expect(...)` matchers do not narrow types the way an `asserts` function
 * does, so reading `.value` off an `Option<T>` after `expect(o.present)` fails
 * to type-check. This helper asserts presence AND narrows, keeping the
 * assertion explicit at the call site.
 *
 * @module
 */
import type { Option, Some } from '@setu-ts/common';

/**
 * Asserts the option is `Some`, narrowing it for subsequent `.value` access.
 *
 * @param option - The option under test
 * @throws {Error} When the option is `None`
 */
export function assertSome<T>(option: Option<T>): asserts option is Some<T> {
  if (!option.present) {
    throw new Error('expected Some, received None');
  }
}
