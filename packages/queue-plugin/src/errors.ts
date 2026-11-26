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
 * Why {@linkcode SqsDeadLetterTargetMissingError} was raised.
 *
 * - `no-target`: no `deadLetterQueues` entry and the queue has no `RedrivePolicy`.
 * - `policy-unreadable`: the `RedrivePolicy` is not JSON, or its target ARN or
 *   `maxReceiveCount` is malformed.
 * - `attributes-unavailable`: the transport has no `getQueueAttributes`, or the
 *   read was refused, failed or timed out (the error is the `cause`).
 * - `target-unresolvable`: the policy names a target but the transport has no
 *   `getQueueUrl`, or resolving it failed (the error is the `cause`).
 *
 * @since 0.14.0
 */
export type SqsDeadLetterTargetMissingReason =
  'no-target' | 'policy-unreadable' | 'attributes-unavailable' | 'target-unresolvable';

const TARGET_MISSING_TEXT: Readonly<Record<SqsDeadLetterTargetMissingReason, string>> = {
  'no-target': 'no deadLetterQueues entry and the queue has no RedrivePolicy',
  'policy-unreadable': "the queue's RedrivePolicy cannot be read",
  'attributes-unavailable': "the queue's attributes (RedrivePolicy) could not be read",
  'target-unresolvable': "the RedrivePolicy target's queue URL could not be resolved",
};

/**
 * A consumer has no proven dead-letter target. Raised before its first poll.
 * @since 0.14.0
 */
export class SqsDeadLetterTargetMissingError extends Error {
  /** Why no target could be proved. @since 0.14.0 */
  readonly reason: SqsDeadLetterTargetMissingReason;

  /**
   * @param jobName - The consumed name
   * @param queueUrl - Source queue URL
   * @param reason - Why no target could be proved (default `no-target`)
   * @param cause - The underlying read error, when one occurred
   * @returns The refusal error
   * @throws Never
   * @since 0.14.0
   */
  constructor(
    jobName: string,
    queueUrl: string,
    reason: SqsDeadLetterTargetMissingReason = 'no-target',
    cause?: unknown,
  ) {
    super(
      `SQS job "${jobName}" at "${queueUrl}" has no dead-letter target: ${TARGET_MISSING_TEXT[reason]}. ` +
        `Add a deadLetterQueues entry, configure a redrive policy on the queue, or set deadLetterQueues: { '${jobName}': false } to discard exhausted jobs. ` +
        'Required IAM rights: sqs:GetQueueAttributes on the source, sqs:GetQueueUrl for a policy target, sqs:SendMessage on the target, and kms:GenerateDataKey and kms:Decrypt for a customer-managed encrypted target.',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'SqsDeadLetterTargetMissingError';
    this.reason = reason;
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
