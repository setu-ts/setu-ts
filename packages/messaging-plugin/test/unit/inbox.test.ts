import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ISubscription, MessageMetadata, SubscribeOptions } from '@hono-enterprise/common';
import { createTopicInbox } from '../../src/brokers/inbox.ts';

type Handler = (message: unknown, metadata: MessageMetadata) => void | Promise<void>;

/** Records what `createTopicInbox` asks of a broker's subscribe/uuid. */
class RecordingDeps {
  calls: Array<{ topic: string; options?: SubscribeOptions }> = [];
  handlers: Handler[] = [];
  unsubscribeCalls = 0;
  subscribeError: Error | null = null;
  #uuidN = 0;

  subscribe(topic: string, handler: Handler, options?: SubscribeOptions): Promise<ISubscription> {
    if (this.subscribeError) {
      return Promise.reject(this.subscribeError);
    }
    this.calls.push({ topic, ...(options !== undefined && { options }) });
    this.handlers.push(handler);
    return Promise.resolve({
      unsubscribe: (): Promise<void> => {
        this.unsubscribeCalls++;
        return Promise.resolve();
      },
    });
  }

  uuid(): string {
    return `u${this.#uuidN++}`;
  }
}

describe('createTopicInbox', () => {
  it('mints a per-instance rr.inbox address and subscribes to it', async () => {
    const deps = new RecordingDeps();
    const inbox = await createTopicInbox(deps)(() => {});

    expect(inbox.address).toBe('rr.inbox.u0');
    expect(deps.calls[0]?.topic).toBe('rr.inbox.u0');
  });

  it('claims the inbox topic as its own queue name (exclusive, not load-balanced)', async () => {
    const deps = new RecordingDeps();
    const inbox = await createTopicInbox(deps)(() => {});

    // Without a queue, a broker that defaults to a shared consumer group would
    // hand this instance's replies to whichever member owns the partition.
    expect(deps.calls[0]?.options).toEqual({ queue: inbox.address });
  });

  it('mints a distinct address per open so instances never share an inbox', async () => {
    const deps = new RecordingDeps();
    const open = createTopicInbox(deps);

    const first = await open(() => {});
    const second = await open(() => {});

    expect(first.address).not.toBe(second.address);
  });

  it('routes a delivered message to the onReply callback', async () => {
    const deps = new RecordingDeps();
    const received: unknown[] = [];
    await createTopicInbox(deps)((message) => {
      received.push(message);
    });

    await deps.handlers[0]?.({ kind: 'rr-reply' }, { topic: 'rr.inbox.u0' });

    expect(received).toEqual([{ kind: 'rr-reply' }]);
  });

  it('close() unsubscribes exactly once', async () => {
    const deps = new RecordingDeps();
    const inbox = await createTopicInbox(deps)(() => {});

    await inbox.close();

    expect(deps.unsubscribeCalls).toBe(1);
  });

  it('propagates a failing subscribe rather than returning a dead inbox', async () => {
    const deps = new RecordingDeps();
    deps.subscribeError = new Error('broker down');

    await expect(createTopicInbox(deps)(() => {})).rejects.toThrow('broker down');
  });
});
