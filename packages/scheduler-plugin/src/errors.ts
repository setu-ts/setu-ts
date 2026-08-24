/**
 * Scheduler error types.
 *
 * @module
 */

/**
 * Thrown when `SchedulerPlugin` is registered on a runtime whose platform
 * cannot run its timers.
 *
 * Cloudflare Workers evicts the isolate between invocations, so the
 * `setTimeout`/`setInterval` arming the whole scheduler surface rests on never
 * fires: an `every` or `delay` job registered there is silent forever. The
 * replacement is the platform's own Cron Triggers, driven by
 * `WorkersCron` from `@setu-ts/cloudflare-plugin`.
 *
 * @example
 * ```typescript
 * try {
 *   app.register(SchedulerPlugin());
 * } catch (error) {
 *   if (error instanceof SchedulerUnavailableError) {
 *     // fall back to WorkersCron + `[triggers] crons`
 *   }
 * }
 * ```
 * @since 0.2.0
 */
export class SchedulerUnavailableError extends Error {
  /** The platform the plugin refused to register on. */
  readonly platform: string;

  /**
   * Constructs the error, carrying the platform identifier for branching.
   *
   * @param platform - The offending runtime platform identifier
   */
  constructor(platform: string) {
    super(
      `SchedulerPlugin cannot run on ${platform}: every/delay jobs arm in-process ` +
        `timers that do not survive isolate eviction. Use WorkersCron with ` +
        `\`[triggers] crons\` in wrangler.toml instead — Cron Triggers are ` +
        `platform-driven and fire reliably.`,
    );
    this.name = 'SchedulerUnavailableError';
    this.platform = platform;
  }
}
