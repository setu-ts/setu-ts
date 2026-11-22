/** Consumer-only SQS target resolution. Internal; never barrel-exported. */
import { withDeadline } from '@setu-ts/common';
import type { IRuntimeServices, TimerHandle } from '@setu-ts/common';
import type { ISqsTransport } from './sqs-queue.ts';
import { SqsDeadLetterTargetMissingError } from '../errors.ts';

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
    const refusal = (): SqsDeadLetterTargetMissingError =>
      new SqsDeadLetterTargetMissingError(name, queueUrl);
    const bounded = <T>(read: () => Promise<T>): Promise<T> => {
      if (this.#closed) return Promise.reject(refusal());
      return withDeadline(read, {
        timeoutMs: 10_000,
        onTimeout: refusal,
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
    };
    try {
      if (!transport.getQueueAttributes) throw refusal();
      const attributes = await bounded(() =>
        transport.getQueueAttributes!(queueUrl, ['RedrivePolicy']),
      );
      if (attributes.RedrivePolicy === undefined) {
        if (explicit) return { url: explicit };
        throw refusal();
      }
      const policy: unknown = JSON.parse(attributes.RedrivePolicy);
      if (typeof policy !== 'object' || policy === null) throw refusal();
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
      if (!arn || !Number.isInteger(count) || count < 1 || count > 1000) throw refusal();
      let url = explicit;
      if (!url) {
        if (!transport.getQueueUrl) throw refusal();
        url = await bounded(() => transport.getQueueUrl!(arn[4]!, arn[3]!));
        if (!url) throw refusal();
      }
      return { url, maxReceiveCount: count };
    } catch {
      if (explicit && !this.#closed) {
        warn(
          `SQS "${name}": the queue's RedrivePolicy cannot be read; redrive policy cannot be detected; using explicit deadLetterQueues target without an attempt clamp`,
        );
        return { url: explicit };
      }
      throw refusal();
    }
  }
}
