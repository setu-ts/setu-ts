/**
 * The `queue` export a Worker needs in order to consume messages.
 *
 * Cloudflare delivers a batch by invoking a **module-level `queue` export**,
 * not through `fetch`. Nothing in the kernel can express that, so the
 * application assembles its module from the pieces:
 *
 * ```typescript
 * export default { fetch: app.fetch, queue: createMessagingHandler(app) };
 * ```
 *
 * A Worker consuming both a job queue and a message queue gets one `queue`
 * export for both, distinguished by `batch.queue` — the queue's name from
 * `wrangler.toml`, which the application knows and this package does not:
 *
 * ```typescript
 * const jobs = createQueueHandler(app);
 * const messages = createMessagingHandler(app);
 * export default {
 *   fetch: app.fetch,
 *   queue: (batch) => (batch.queue === 'jobs' ? jobs(batch) : messages(batch)),
 * };
 * ```
 *
 * @module
 * @since 0.2.0
 */

import type { IApplication, IMessageBroker } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { instanceToken } from '../instance-token.ts';
import type { IQueueMessageBatch } from '../bindings/facades.ts';
import { CloudflareUnsupportedError } from '../errors.ts';
import { WorkersBroker } from './workers-broker.ts';

/**
 * The `queue` export's shape, as Cloudflare invokes it.
 *
 * @param batch - The delivered batch
 * @returns Resolves once every message has been acked or retried
 * @since 0.2.0
 */
export type MessagingHandler = (batch: IQueueMessageBatch) => Promise<void>;

/**
 * Options for {@linkcode createMessagingHandler}.
 *
 * @since 0.2.0
 */
export interface MessagingHandlerOptions {
  /**
   * Which broker instance to dispatch into, matching
   * `CloudflarePluginOptions.messaging.name`. Omitted resolves the bare
   * `CAPABILITIES.MESSAGING` token.
   */
  readonly name?: string;
}

/**
 * Builds the handler an application exports as `queue` to consume messages.
 *
 * The broker is resolved from the application's registry rather than passed in,
 * so the subscriptions registered through `IMessageBroker.subscribe` anywhere
 * in the application are the ones this handler delivers into — there is only
 * ever one instance.
 *
 * Resolution is lazy: the token is read on each invocation, not when this
 * factory runs, so the export can be built before `app.start()` has registered
 * anything.
 *
 * @param app - The application whose registry carries the broker
 * @param options - Which named broker instance to dispatch into
 * @returns The handler to assign to the Worker's `queue` export
 * @throws {CloudflareUnsupportedError} At invocation time, when the resolved
 * token holds an `IMessageBroker` that is not a {@linkcode WorkersBroker} — an
 * in-memory or Redis broker has no batch to dispatch and would silently drop
 * the delivery
 * @example
 * ```typescript
 * export default { fetch: app.fetch, queue: createMessagingHandler(app) };
 * ```
 * @since 0.2.0
 */
export function createMessagingHandler(
  app: IApplication,
  options?: MessagingHandlerOptions,
): MessagingHandler {
  const token = instanceToken(CAPABILITIES.MESSAGING, options?.name);

  // `async`, so a resolution failure arrives as a REJECTED promise rather than
  // a synchronous throw: `MessagingHandler` is declared `=> Promise<void>` and
  // the application assigns this straight to its `queue` export, where a caller
  // writing `queue: (b) => handler(b).catch(report)` would not catch a
  // synchronous throw.
  return async (batch: IQueueMessageBatch): Promise<void> => {
    const service = app.services.get<IMessageBroker>(token);

    // A runtime `instanceof` on an exported class, not a cast to a different
    // interface: the token is resolved as its own documented type and narrowed
    // within it. Registering some other IMessageBroker under `messaging` and
    // exporting this handler is a wiring mistake that would otherwise present
    // as messages vanishing.
    if (!(service instanceof WorkersBroker)) {
      throw new CloudflareUnsupportedError(
        `The service registered under '${token}' is not a WorkersBroker, so a Cloudflare queue ` +
          'batch cannot be dispatched into it. Register CloudflarePlugin with a `messaging` arm ' +
          'instead of MessagingPlugin on this token.',
      );
    }

    await service.dispatch(batch);
  };
}
