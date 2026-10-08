/**
 * `@Idempotent(options?)` — makes a decorated route idempotent by a client key
 * (M109a §3.9).
 *
 * Appended LAST in a decorated route's middleware chain — after guards,
 * declarative authorization, the interceptor/middleware/filter band and the
 * validation band — so an unkeyed or invalid request never consumes a key. The
 * decorator only RECORDS its options; the plugin resolves them and refuses a
 * safe-method route or a missing provider at `register()`.
 *
 * @module
 * @since 0.9.0
 */
import type { IdempotentRouteOptions } from '@setu-ts/common';
import { methodDecorator } from '../metadata/context-bridge.ts';
import type { SetuMethodDecorator } from '../metadata/context-bridge.ts';

/**
 * Declares that a route's handler runs once per idempotency key.
 *
 * @param options - The route's idempotency options (key source, lease, ttl, …)
 * @returns A standard method decorator
 * @throws {Error} At `register()`, when the route is a safe method or no
 *   `CAPABILITIES.IDEMPOTENCY` provider is registered
 * @example
 * ```typescript
 * @Controller('/payments')
 * class PaymentController {
 *   @Post('/')
 *   @Idempotent()
 *   @Params(Body())
 *   create(input: PaymentInput) {
 *     return this.payments.create(input);
 *   }
 * }
 * ```
 * @since 0.9.0
 */
export function Idempotent(options?: IdempotentRouteOptions): SetuMethodDecorator {
  return methodDecorator((store, target, handler) => {
    store.mutateMethod(target, handler, (meta) => {
      // Replace-scalar: decorators apply bottom-up, so the TOPMOST `@Idempotent`
      // is applied last and wins.
      meta.idempotent = options ?? {};
    });
  });
}
