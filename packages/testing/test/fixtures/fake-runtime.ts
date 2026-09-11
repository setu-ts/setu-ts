import type { IRuntimeServices } from '@setu-ts/common';
import { _getDefaults } from '../../src/mock-context.ts';

/**
 * A runtime double for tests in this package.
 *
 * `@setu-ts/testing` depends on `common` and `kernel` only, so its own tests
 * cannot import `RuntimePlugin` — the kernel nevertheless requires the
 * `runtime` capability at `start()`.
 *
 * It **delegates to `createTestContext`'s own default** rather than declaring a
 * fifth hand-written copy. That default is the contract-faithful one: M33's
 * review corrected three infidelities in it that hand-written copies still
 * carry — `randomBytes(n)` returning zero bytes instead of `n`, `subtle` being
 * `null` instead of an empty `SubtleCrypto` (so a missing method reads as
 * `undefined` rather than throwing on property access), and REAL timers, which
 * fire after the test that armed them has finished and leak an op into whatever
 * runs next. Delegating means a future correction there cannot leave this copy
 * behind.
 *
 * Each call returns a fresh object, so a test that overrides a member cannot
 * perturb another test's runtime.
 */
export function createFakeRuntime(): IRuntimeServices {
  return { ..._getDefaults() };
}
