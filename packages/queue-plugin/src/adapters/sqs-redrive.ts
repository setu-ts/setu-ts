/** Consumer-only SQS target resolution. Internal; never barrel-exported. */
import { withDeadline } from '@setu-ts/common';
import type { IRuntimeServices, TimerHandle } from '@setu-ts/common';
import type { ISqsTransport } from './sqs-queue.ts';
import { SqsDeadLetterTargetMissingError } from '../errors.ts';
import type { SqsDeadLetterTargetMissingReason } from '../errors.ts';

/** Warning text per refusal reason, for an explicit target that is kept. */
const TARGET_TEXT: Readonly<Record<SqsDeadLetterTargetMissingReason, string>> = {
  'no-target': 'the queue has no RedrivePolicy',
  'policy-unreadable': "the queue's RedrivePolicy cannot be read",
  'attributes-unavailable': "the queue's attributes (RedrivePolicy) could not be read",
  'target-unresolvable': "the RedrivePolicy target's queue URL could not be resolved",
};

/** Resolved target and optional native receive budget. @since 0.14.0 */
export interface ISqsRedriveTarget {
  readonly url: string | false;
  readonly maxReceiveCount?: number;
}

/** Owns bounded preparation reads, including their shutdown boundary. @since 0.14.0 */
export class SqsRedrive {
  readonly #timers = new Map<TimerHandle, () => void>();
  #closed = false;

  /**
   * Cancels every outstanding read deadline, rejecting its preparation.
   * @returns Nothing
   * @throws Never
   * @since 0.14.0
   */
  close(): void {
    this.#closed = true;
    for (const cancel of this.#timers.values()) cancel();
  }

  /**
   * Resolves a consumer target; explicit discard bypasses all reads.
   * @param runtime - Runtime clock and timers
   * @param transport - Connected transport
   * @param name - Consumed job name
   * @param queueUrl - Source URL
   * @param explicit - Explicit URL or discard opt-out
   * @param warn - Optional value-free policy warning sink
   * @returns Proven target with a native budget when readable
   * @throws {SqsDeadLetterTargetMissingError} When no target can be proved
   * @since 0.14.0
   */
  async resolve(
    runtime: IRuntimeServices,
    transport: ISqsTransport,
    name: string,
    queueUrl: string,
    explicit: string | false | undefined,
    warn: (message: string) => void,
  ): Promise<ISqsRedriveTarget> {
    if (explicit === false) return { url: false };
    type Refusal = SqsDeadLetterTargetMissingReason;
    let refusal: { reason: Refusal; cause?: unknown } = { reason: 'no-target' };
    const refuse = (reason: Refusal, cause?: unknown): never => {
      refusal = cause === undefined ? { reason } : { reason, cause };
      throw new SqsDeadLetterTargetMissingError(name, queueUrl, reason, cause);
    };
    const bounded = async <T>(read: () => Promise<T>, reason: Refusal): Promise<T> => {
      if (this.#closed) return refuse(reason, new Error('SqsQueue is disconnecting'));
      try {
        return await withDeadline(read, {
          timeoutMs: 10_000,
          onTimeout: () =>
            new Error(
              this.#closed ? 'SqsQueue is disconnecting' : 'SQS read timed out after 10000 ms',
            ),
          timing: {
            setTimer: (fn, ms) => {
              const handle = runtime.setTimeout(fn, ms);
              this.#timers.set(handle, fn);
              return handle;
            },
            clearTimer: (handle) => {
              runtime.clearTimeout(handle);
              this.#timers.delete(handle);
            },
          },
        });
      } catch (error) {
        return refuse(reason, error);
      }
    };
    try {
      if (!transport.getQueueAttributes) return refuse('attributes-unavailable');
      const read = transport.getQueueAttributes.bind(transport);
      const attributes = await bounded(
        () => read(queueUrl, ['RedrivePolicy']),
        'attributes-unavailable',
      );
      if (attributes.RedrivePolicy === undefined) {
        if (explicit) return { url: explicit };
        return refuse('no-target');
      }
      let policy: unknown;
      try {
        policy = JSON.parse(attributes.RedrivePolicy);
      } catch {
        return refuse('policy-unreadable');
      }
      if (typeof policy !== 'object' || policy === null) return refuse('policy-unreadable');
      const { deadLetterTargetArn, maxReceiveCount } = policy as Record<string, unknown>;
      const arn =
        typeof deadLetterTargetArn === 'string'
          ? /^arn:([^:]+):sqs:([^:]+):([0-9]+):([A-Za-z0-9_-]+(?:\.fifo)?)$/.exec(
              deadLetterTargetArn,
            )
          : null;
      const count =
        typeof maxReceiveCount === 'number'
          ? maxReceiveCount
          : typeof maxReceiveCount === 'string' && /^\d+$/.test(maxReceiveCount)
            ? Number(maxReceiveCount)
            : NaN;
      if (!arn || !Number.isInteger(count) || count < 1 || count > 1000) {
        return refuse('policy-unreadable');
      }
      if (explicit) return { url: explicit, maxReceiveCount: count };
      if (!transport.getQueueUrl) return refuse('target-unresolvable');
      const resolveUrl = transport.getQueueUrl.bind(transport);
      const url = await bounded(() => resolveUrl(arn[4]!, arn[3]!), 'target-unresolvable');
      if (!url) return refuse('target-unresolvable');
      return { url, maxReceiveCount: count };
    } catch (error) {
      if (explicit && !this.#closed) {
        warn(
          `SQS "${name}": ${TARGET_TEXT[refusal.reason]}, so a redrive policy cannot be detected; using the explicit deadLetterQueues target without an attempt clamp`,
        );
        return { url: explicit };
      }
      throw error;
    }
  }
}
