import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ISubscription, MessageMetadata } from '@hono-enterprise/common';
import { RequestReplyCore } from '../../src/brokers/request-reply-core.ts';
import type { RequestReplyDeps } from '../../src/brokers/request-reply-core.ts';
import { RemoteHandlerError, RequestTimeoutError } from '../../src/errors.ts';

type Handler = (message: unknown, metadata: MessageMetadata) => void | Promise<void>;

/** Flush all pending microtasks (a request's async setup) before acting. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Controllable in-process transport implementing RequestReplyDeps. Delivers
 * published messages synchronously to subscribers (auto-deliver), with hooks to
 * disable delivery and to deliver manually — enough to exercise every branch of
 * RequestReplyCore deterministically without a real broker.
 */
class FakeTransport implements RequestReplyDeps {
  subscribers = new Map<string, Handler[]>();
  published: Array<{ topic: string; message: unknown }> = [];
  autoDeliver = true;
  clearTimeoutCalls = 0;
  unsubscribeCalls = 0;
  publishError: Error | null = null;
  #uuidN = 0;

  async publish(topic: string, message: unknown): Promise<void> {
    if (this.publishError) {
      throw this.publishError;
    }
    this.published.push({ topic, message });
    if (this.autoDeliver) {
      await this.deliver(topic, message);
    }
  }

  subscribe(topic: string, handler: Handler): Promise<ISubscription> {
    const arr = this.subscribers.get(topic) ?? [];
    arr.push(handler);
    this.subscribers.set(topic, arr);
    return Promise.resolve({
      unsubscribe: (): Promise<void> => {
        this.unsubscribeCalls++;
        return Promise.resolve();
      },
    });
  }

  uuid(): string {
    return `id-${this.#uuidN++}`;
  }

  setTimeout(fn: () => void, ms: number): number {
    return setTimeout(fn, ms) as unknown as number;
  }

  clearTimeout(handle: unknown): void {
    this.clearTimeoutCalls++;
    clearTimeout(handle as number);
  }

  /** Deliver a message to every subscriber of a topic. */
  async deliver(topic: string, message: unknown): Promise<void> {
    const subs = this.subscribers.get(topic) ?? [];
    for (const s of subs) {
      await s(message, { topic });
    }
  }
}

describe('RequestReplyCore', () => {
  it('round-trips a request to a responder and resolves with its result', async () => {
    const t = new FakeTransport();
    const core = new RequestReplyCore(t);

    await core.respond('math.double', (n) => (n as number) * 2);
    const result = await core.request<number>('math.double', 21);

    expect(result).toBe(42);
    // The reply timer was cleared on resolve.
    expect(t.clearTimeoutCalls).toBeGreaterThanOrEqual(1);
  });

  it('propagates a responder throw as RemoteHandlerError with the remote message', async () => {
    const t = new FakeTransport();
    const core = new RequestReplyCore(t);

    await core.respond('boom', () => {
      throw new Error('handler exploded');
    });

    let caught: unknown;
    try {
      await core.request('boom', {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RemoteHandlerError);
    expect((caught as RemoteHandlerError).remoteMessage).toBe('handler exploded');
  });

  it('propagates a non-Error responder throw via String(err)', async () => {
    const t = new FakeTransport();
    const core = new RequestReplyCore(t);

    await core.respond('boom.string', () => {
      throw 'plain string failure';
    });

    let caught: unknown;
    try {
      await core.request('boom.string', {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RemoteHandlerError);
    expect((caught as RemoteHandlerError).remoteMessage).toBe('plain string failure');
  });

  it('rejects with RequestTimeoutError when no reply arrives, then drops a late reply', async () => {
    const t = new FakeTransport();
    const core = new RequestReplyCore(t);

    // uuid #0 was consumed by the constructor for the inbox topic.
    const inboxTopic = 'rr.inbox.id-0';

    let caught: unknown;
    try {
      await core.request('no.responder', {}, { timeoutMs: 10 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RequestTimeoutError);

    // A late reply (correlationId id-1) must be dropped: pending was removed on
    // timeout, so onReply finds nothing and does not clear a timer.
    const before = t.clearTimeoutCalls;
    await t.deliver(inboxTopic, {
      kind: 'rr-reply',
      correlationId: 'id-1',
      ok: true,
      payload: 'x',
    });
    expect(t.clearTimeoutCalls).toBe(before);
  });

  it('cleans up and rethrows when publishing the request fails', async () => {
    const t = new FakeTransport();
    const core = new RequestReplyCore(t);
    t.publishError = new Error('broker down');

    let caught: unknown;
    try {
      await core.request('x', {}, { timeoutMs: 1000 });
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toBe('broker down');
    // The pending timer was cleared during cleanup.
    expect(t.clearTimeoutCalls).toBe(1);
  });

  it('close() rejects in-flight requests and unsubscribes the inbox', async () => {
    const t = new FakeTransport();
    const core = new RequestReplyCore(t);
    t.autoDeliver = false; // no responder will ever reply

    const pending = core.request('slow', {}, { timeoutMs: 60_000 });
    // Let the inbox subscription settle.
    await flush();
    await core.close();

    let caught: unknown;
    try {
      await pending;
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toContain('disconnected');
    expect(t.unsubscribeCalls).toBe(1);
  });

  it('ignores a delivered message that is not a request envelope', async () => {
    const t = new FakeTransport();
    const core = new RequestReplyCore(t);
    let called = false;
    await core.respond('topic', () => {
      called = true;
      return 'ok';
    });

    await t.deliver('topic', { not: 'an-envelope' });
    expect(called).toBe(false);
  });

  it('ignores an inbox message that is not a reply envelope', async () => {
    const t = new FakeTransport();
    const core = new RequestReplyCore(t);
    t.autoDeliver = false;

    const pending = core.request('q', {}, { timeoutMs: 40 });
    await flush();
    // Deliver garbage to the inbox — must be ignored (no resolve).
    await t.deliver('rr.inbox.id-0', { garbage: true });

    let caught: unknown;
    try {
      await pending;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RequestTimeoutError);
  });

  it('maps an ok:false reply with no error field to "unknown error"', async () => {
    const t = new FakeTransport();
    const core = new RequestReplyCore(t);
    t.autoDeliver = false;

    const pending = core.request('u', {}, { timeoutMs: 1000 });
    await flush();
    await t.deliver('rr.inbox.id-0', { kind: 'rr-reply', correlationId: 'id-1', ok: false });

    let caught: unknown;
    try {
      await pending;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RemoteHandlerError);
    expect((caught as RemoteHandlerError).remoteMessage).toBe('unknown error');
  });

  it('shares one inbox subscription across concurrent requests', async () => {
    const t = new FakeTransport();
    const core = new RequestReplyCore(t);
    await core.respond('echo', (n) => n);

    const [a, b] = await Promise.all([
      core.request<number>('echo', 1),
      core.request<number>('echo', 2),
    ]);
    expect(a).toBe(1);
    expect(b).toBe(2);

    // Inbox topic subscribed once (plus the one responder subscription).
    const inboxSubs = t.subscribers.get('rr.inbox.id-0') ?? [];
    expect(inboxSubs.length).toBe(1);
  });
});
