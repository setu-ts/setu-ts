/**
 * The `scheduled` export a Worker needs in order to receive Cron Triggers.
 *
 * Like the `queue` export, Cloudflare invokes a **module-level `scheduled`
 * export** rather than routing through `fetch`, so the application assembles
 * its module from the pieces:
 *
 * ```typescript
 * export default { fetch: app.fetch, scheduled: createScheduledHandler(cron) };
 * ```
 *
 * @module
 */

import type { IScheduledController } from '../bindings/facades.ts';
import type { WorkersCron } from './workers-cron.ts';

/**
 * The `scheduled` export's shape, as Cloudflare invokes it.
 *
 * @param controller - The firing trigger
 * @returns Resolves when the work is done; the invocation is kept alive until
 * it settles
 * @since 0.2.0
 */
export type ScheduledHandler = (controller: IScheduledController) => Promise<void>;

/**
 * Builds the handler an application exports as `scheduled`.
 *
 * Takes the {@linkcode WorkersCron} directly rather than the application,
 * unlike `createQueueHandler`. That asymmetry follows from a decision rather
 * than an oversight: `WorkersCron` deliberately does not claim
 * `CAPABILITIES.SCHEDULER` (see its module doc), so it is not in the registry
 * to resolve — and it needs neither an id source nor a clock, so the
 * application can construct it directly.
 *
 * @example
 * ```typescript
 * const cron = new WorkersCron({ logger });
 * cron.on('*\/5 * * * *', () => sweepExpiredSessions(app));
 *
 * export default { fetch: app.fetch, scheduled: createScheduledHandler(cron) };
 * ```
 * @param cron - The registry carrying the handlers
 * @returns The handler to assign to the Worker's `scheduled` export
 * @since 0.2.0
 */
export function createScheduledHandler(cron: WorkersCron): ScheduledHandler {
  return (controller: IScheduledController): Promise<void> => cron.dispatch(controller);
}
