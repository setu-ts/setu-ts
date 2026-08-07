/**
 * Contract-honouring in-memory stand-in for {@linkcode ISqsTransport}.
 *
 * It reproduces the SQS behaviour the adapter actually depends on, rather than
 * recording calls and returning empty: a received message becomes INVISIBLE for
 * its visibility timeout and returns to the queue when that lapses,
 * `ApproximateReceiveCount` climbs per delivery, `delete` removes the message
 * permanently, and `changeVisibility` moves the invisibility deadline.
 *
 * A fake that merely records is what let a settle path that never reached the
 * transport pass its own tests — the adapter looked correct while no message
 * was ever removed. Here, a missing `delete` shows up as redelivery.
 *
 * @module
 */

import type { ISqsTransport, SqsReceivedMessage } from '../../src/adapters/sqs-queue.ts';

/** A message held by the fake queue. */
interface FakeMessage {
  receiptHandle: string;
  body: string;
  /** Wall-clock ms before which the message is not receivable. */
  visibleAtMs: number;
  /** Delivery count, mirroring SQS `ApproximateReceiveCount`. */
  receiveCount: number;
}

/**
 * In-memory SQS stand-in. One instance backs every queue URL handed to it.
 *
 * @since 0.1.0
 */
export class FakeSqsTransport implements ISqsTransport {
  /** Every `SendMessage` seen, in order. */
  readonly sent: { queueUrl: string; body: string; delaySeconds: number | undefined }[] = [];
  /** Every `DeleteMessage` seen, in order. */
  readonly deleted: { queueUrl: string; receiptHandle: string }[] = [];
  /** Every `ChangeMessageVisibility` seen, in order. */
  readonly visibilityChanges: { receiptHandle: string; seconds: number }[] = [];
  /** `true` after {@linkcode close} runs. */
  closed = false;

  #queues: Map<string, FakeMessage[]> = new Map();
  #handleCounter = 0;
  #now: () => number;

  /**
   * @param now - Clock used for visibility deadlines; pass the same clock the
   * adapter under test uses so the two agree on when a claim lapses.
   */
  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  /** Messages currently held for a queue URL, visible or not. */
  depth(queueUrl: string): number {
    return this.#queues.get(queueUrl)?.length ?? 0;
  }

  send(queueUrl: string, body: string, delaySeconds?: number): Promise<void> {
    this.sent.push({ queueUrl, body, delaySeconds });
    const queue = this.#queues.get(queueUrl) ?? [];
    queue.push({
      receiptHandle: `rh-${++this.#handleCounter}`,
      body,
      visibleAtMs: this.#now() + (delaySeconds ?? 0) * 1000,
      receiveCount: 0,
    });
    this.#queues.set(queueUrl, queue);
    return Promise.resolve();
  }

  receive(
    queueUrl: string,
    max: number,
    visibilitySeconds: number,
  ): Promise<readonly SqsReceivedMessage[]> {
    const now = this.#now();
    const queue = this.#queues.get(queueUrl) ?? [];
    const out: SqsReceivedMessage[] = [];

    for (const message of queue) {
      if (out.length >= max) break;
      if (message.visibleAtMs > now) continue;

      // Claim it: invisible for the visibility window, delivery count climbs.
      message.receiveCount++;
      message.visibleAtMs = now + visibilitySeconds * 1000;
      out.push({
        receiptHandle: message.receiptHandle,
        body: message.body,
        approximateReceiveCount: String(message.receiveCount),
      });
    }

    return Promise.resolve(out);
  }

  delete(queueUrl: string, receiptHandle: string): Promise<void> {
    this.deleted.push({ queueUrl, receiptHandle });
    const queue = this.#queues.get(queueUrl) ?? [];
    const index = queue.findIndex((m) => m.receiptHandle === receiptHandle);
    if (index >= 0) queue.splice(index, 1);
    return Promise.resolve();
  }

  changeVisibility(queueUrl: string, receiptHandle: string, seconds: number): Promise<void> {
    this.visibilityChanges.push({ receiptHandle, seconds });
    const queue = this.#queues.get(queueUrl) ?? [];
    const message = queue.find((m) => m.receiptHandle === receiptHandle);
    if (message) message.visibleAtMs = this.#now() + seconds * 1000;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
