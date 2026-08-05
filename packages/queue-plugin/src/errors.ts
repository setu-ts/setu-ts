/**
 * Queue plugin error classes exported for consumer `instanceof` handling.
 *
 * @module
 */

/**
 * Thrown by a queue backend's `connect()` when the runtime platform is
 * Cloudflare Workers and the SDK cannot function. The throw fails
 * `app.start()` at the earliest possible point.
 *
 * @since 0.1.0
 */
export class QueueBackendUnavailableError extends Error {
  constructor(backend: string, specifier: string) {
    super(
      `${backend} (${specifier}) is not available on Cloudflare Workers — ` +
        'the SDK requires Node/Deno/Bun',
    );
    this.name = 'QueueBackendUnavailableError';
  }
}

/**
 * Thrown by {@linkcode SqsQueue} when a job name is not mapped in the
 * `queues` configuration. The error message names the job name and the
 * configured names.
 *
 * @since 0.1.0
 */
export class SqsQueueNotConfiguredError extends Error {
  constructor(jobName: string, configuredNames: readonly string[]) {
    super(
      `SQS queue for job "${jobName}" is not configured — ` +
        `configured names: ${configuredNames.join(', ')}`,
    );
    this.name = 'SqsQueueNotConfiguredError';
  }
}

/**
 * Thrown by {@linkcode SqsQueue} when a job delay exceeds SQS's 900 s
 * `DelaySeconds` ceiling. The delay is NOT clamped (a clamp runs the job
 * early); the caller must adjust the value.
 *
 * @since 0.1.0
 */
export class SqsDelayTooLongError extends Error {
  constructor(delayMs: number) {
    super(
      `Job delay ${delayMs}ms exceeds SQS maximum of 900000ms (900s) — ` +
        'SQS does not clamp the value, so the job would run early',
    );
    this.name = 'SqsDelayTooLongError';
  }
}
