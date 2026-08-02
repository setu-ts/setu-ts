/**
 * The `queue` export a Worker needs in order to consume a Cloudflare queue.
 *
 * Cloudflare delivers a batch by invoking a **module-level `queue` export**,
 * not through `fetch`. Nothing in the kernel can express that, so the
 * application assembles its module from the pieces:
 *
 * ```typescript
 * export default { fetch: app.fetch, queue: createQueueHandler(app) };
 * ```
 *
 * @module
 */

import type { CapabilityToken, IApplication, IQueue } from '@hono-enterprise/common';
import { CAPABILITIES, createCapabilityToken } from '@hono-enterprise/common';
import type { IQueueMessageBatch } from '../bindings/facades.ts';
import { CloudflareUnsupportedError } from '../errors.ts';
import { WorkersQueue } from './workers-queue.ts';

/**
 * The `queue` export's shape, as Cloudflare invokes it.
 *
 * The platform passes `env` and an execution context after the batch; neither
 * is needed here, because the queue's processors were registered against the
 * application and the invocation ends when the returned promise settles.
 *
 * @param batch - The delivered batch
 * @returns Resolves once every message has been acked or retried
 * @since 0.2.0
 */
export type QueueHandler = (batch: IQueueMessageBatch) => Promise<void>;

/**
 * Options for {@linkcode createQueueHandler}.
 *
 * @since 0.2.0
 */
export interface QueueHandlerOptions {
  /**
   * Which queue instance to dispatch into, matching
   * `CloudflarePluginOptions.queue.name`. Omitted resolves the bare
   * `CAPABILITIES.QUEUE` token.
   */
  readonly name?: string;
}

/**
 * Builds the handler an application exports as `queue`.
 *
 * The queue is resolved from the application's registry rather than passed in,
 * so the processors registered through `IQueue.process` anywhere in the
 * application are the processors this handler dispatches into — there is only
 * ever one instance.
 *
 * Resolution is lazy: the token is read on each invocation, not when this
 * factory runs, so the export can be built before `app.start()` has registered
 * anything.
 *
 * @example
 * ```typescript
 * const app = createApplication({
 *   plugins: [RuntimePlugin({ env }), CloudflarePlugin({ env, queue: { binding: 'JOBS' } })],
 * });
 * await app.start();
 *
 * export default { fetch: app.fetch, queue: createQueueHandler(app) };
 * ```
 * @param app - The application whose registry carries the queue
 * @param options - Which named queue instance to dispatch into
 * @returns The handler to assign to the Worker's `queue` export
 * @throws {CloudflareUnsupportedError} At invocation time, when the resolved
 * token holds an `IQueue` that is not a {@linkcode WorkersQueue} — a memory or
 * Redis queue has no batch to dispatch and would silently drop the delivery
 * @since 0.2.0
 */
export function createQueueHandler(
  app: IApplication,
  options?: QueueHandlerOptions,
): QueueHandler {
  const token = queueToken(options?.name);

  return (batch: IQueueMessageBatch): Promise<void> => {
    const service = app.services.get<IQueue>(token);

    // A runtime `instanceof` on an exported class, not a cast to a different
    // interface: the token is resolved as its own documented type, and this
    // narrows within it. Registering some other IQueue under `queue` and
    // exporting this handler is a wiring mistake that would otherwise present
    // as messages vanishing.
    if (!(service instanceof WorkersQueue)) {
      throw new CloudflareUnsupportedError(
        `The service registered under '${token}' is not a WorkersQueue, so a Cloudflare queue ` +
          'batch cannot be dispatched into it. Register CloudflarePlugin with a `queue` arm ' +
          '(or construct a WorkersQueue yourself) instead of QueuePlugin on this token.',
      );
    }

    return service.dispatch(batch);
  };
}

/** Derives the token an instance name registers under, matching the plugin. */
function queueToken(name: string | undefined): CapabilityToken {
  return name === undefined || name === 'default'
    ? CAPABILITIES.QUEUE
    : createCapabilityToken(`${CAPABILITIES.QUEUE}.${name}`);
}
