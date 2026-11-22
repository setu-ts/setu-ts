/**
 * Queue plugin errors. StaleClaimError is internal; the others are public.
 *
 * @module
 */

/**
 * A settlement belongs to a delivery that no longer owns the job.
 * Internal — never barrel-exported. Tokens are delivery fences, not authorization.
 */
export class StaleClaimError extends Error {
  constructor() {
    super('queue job claim is stale');
    this.name = 'StaleClaimError';
  }
}

/**
 * A consumer has no proven dead-letter target. Raised before its first poll.
 * @since 0.14.0
 */
export class SqsDeadLetterTargetMissingError extends Error {
  /**
   * @param jobName - The consumed name
   * @param queueUrl - Source queue URL
   * @returns The refusal error
   * @throws Never
   * @since 0.14.0
   */
  constructor(jobName: string, queueUrl: string) {
    super(
      `SQS job "${jobName}" at "${queueUrl}": the queue's RedrivePolicy cannot be read or no dead-letter target is available. ` +
        `Add a deadLetterQueues entry, configure a redrive policy on the queue, or set deadLetterQueues: { '${jobName}': false } to discard exhausted jobs. ` +
        'Required IAM rights: sqs:GetQueueAttributes on the source, sqs:GetQueueUrl for a policy target, sqs:SendMessage on the target, and kms:GenerateDataKey for a customer-managed encrypted target.',
    );
    this.name = 'SqsDeadLetterTargetMissingError';
  }
}

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
