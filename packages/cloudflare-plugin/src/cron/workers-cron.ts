/**
 * `WorkersCron` — the Cron Trigger registry a Worker's `scheduled` export
 * dispatches into.
 *
 * **This deliberately does not implement `IScheduler`.** Of that port's eight
 * methods only `cron` is expressible on Workers:
 *
 * - `every` and `delay` arm a timer, and a Worker isolate is evicted between
 *   invocations — a `setInterval` armed in one invocation never fires in the
 *   next. (That is also exactly why `scheduler-plugin` cannot run on Workers,
 *   rather than anything about its implementation.)
 * - `pause`, `resume` and `remove` need state that survives between
 *   invocations, and there is none.
 * - `getNextRun` is owned by the `wrangler.toml` `[triggers]` block, which no
 *   code in the process can read.
 *
 * Registering `CAPABILITIES.SCHEDULER` with six of eight methods throwing would
 * break every consumer written against the port, which is what Liskov
 * substitution (AI_GUIDELINES §1.1) forbids. A small honest surface is the
 * correct trade, so this class is reached directly rather than through the
 * service registry.
 *
 * @module
 */

import type { ILogger } from '@setu-ts/common';
import type { IScheduledController } from '../bindings/facades.ts';

/**
 * Invoked when a Cron Trigger fires.
 *
 * @param controller - The firing trigger, carrying its expression and the time
 * it was scheduled for
 * @returns Resolves when the work is done; the invocation stays alive until
 * every handler for the expression settles
 * @since 0.2.0
 */
export type CronHandler = (controller: IScheduledController) => void | Promise<void>;

/**
 * Options for {@linkcode WorkersCron}.
 *
 * @since 0.2.0
 */
export interface WorkersCronOptions {
  /**
   * Reports the two paths that would otherwise be silent: a trigger firing
   * with no handler registered for its expression, and a handler that rejects.
   * Omitted leaves both silent.
   */
  readonly logger?: ILogger;
}

/**
 * A registry of Cron Trigger handlers, keyed by cron expression.
 *
 * The key is the expression rather than a name of our choosing because that is
 * all the platform reports: `ScheduledController.cron` is the exact string from
 * `wrangler.toml`. **Both lists must agree** — an expression registered here
 * but absent from `[triggers] crons` never fires, and a trigger configured
 * there with nothing registered here is reported through the logger on every
 * occurrence. {@linkcode expressions} exists so an application can assert its
 * own coverage.
 *
 * @example
 * ```typescript
 * // wrangler.toml: [triggers] crons = ["0 * * * *"]
 * const cron = new WorkersCron({ logger });
 * cron.on('0 * * * *', async () => {
 *   await app.services.get<IQueue>(CAPABILITIES.QUEUE).add('rebuild-report', {});
 * });
 *
 * export default { fetch: app.fetch, scheduled: createScheduledHandler(cron) };
 * ```
 * @since 0.2.0
 */
export class WorkersCron {
  readonly #handlers = new Map<string, CronHandler[]>();
  readonly #logger: ILogger | undefined;

  /**
   * @param options - Logger for the unmatched-trigger and handler-failure paths
   */
  constructor(options?: WorkersCronOptions) {
    this.#logger = options?.logger;
  }

  /**
   * Registers a handler for a cron expression.
   *
   * Several handlers may share one expression; all of them run, and one that
   * rejects does not prevent the others. The expression is matched **exactly**
   * against `ScheduledController.cron`, so it must be written the same way it
   * appears in `wrangler.toml`.
   *
   * @param expression - The cron expression, exactly as configured
   * @param handler - Invoked when that trigger fires
   * @returns This registry, for chaining
   */
  on(expression: string, handler: CronHandler): this {
    const existing = this.#handlers.get(expression);
    if (existing === undefined) this.#handlers.set(expression, [handler]);
    else existing.push(handler);
    return this;
  }

  /**
   * Every expression that has at least one handler.
   *
   * Intended for an application to check against its own `wrangler.toml`, since
   * nothing in the process can read that file.
   *
   * @returns The registered expressions, in registration order
   */
  expressions(): readonly string[] {
    return [...this.#handlers.keys()];
  }

  /**
   * Runs every handler registered for the firing trigger's expression.
   *
   * Handlers run concurrently and are all awaited, so the Worker invocation
   * stays alive until the slowest finishes. A rejection is reported and
   * swallowed rather than propagated: one failing handler must not abandon the
   * others, and the platform's only response to a thrown `scheduled` is to
   * count the whole invocation as failed.
   *
   * @param controller - The firing trigger
   * @returns Resolves once every handler for the expression has settled
   */
  async dispatch(controller: IScheduledController): Promise<void> {
    const handlers = this.#handlers.get(controller.cron);

    if (handlers === undefined || handlers.length === 0) {
      this.#logger?.warn('cloudflare-cron: trigger fired with no handler registered', {
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
        registered: this.expressions(),
      });
      return;
    }

    await Promise.all(handlers.map((handler) => this.#runOne(controller, handler)));
  }

  /** Runs one handler, reporting rather than propagating a rejection. */
  async #runOne(controller: IScheduledController, handler: CronHandler): Promise<void> {
    try {
      await handler(controller);
    } catch (error: unknown) {
      this.#logger?.error('cloudflare-cron: handler failed', {
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
