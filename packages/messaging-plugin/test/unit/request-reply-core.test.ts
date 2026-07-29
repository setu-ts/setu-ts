import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ISubscription, MessageMetadata, SubscribeOptions } from '@hono-enterprise/common';
import { RequestReplyCore } from '../../src/brokers/request-reply-core.ts';
import type { RequestReplyDeps } from '../../src/brokers/request-reply-core.ts';
import { createTopicInbox } from '../../src/brokers/inbox.ts';
import type { ReplyInbox } from '../../src/brokers/inbox.ts';
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
  subscribeOptions: Array<{ topic: string; queue?: string }> = [];
  autoDeliver = true;
  clearTimeoutCalls = 0;
  unsubscribeCalls = 0;
  openInboxCalls = 0;
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

  subscribe(topic: string, handler: Handler, options?: SubscribeOptions): Promise<ISubscription> {
    const arr = this.subscribers.get(topic) ?? [];
    arr.push(handler);
    this.subscribers.set(topic, arr);
    this.subscribeOptions.push({
      topic,
      ...(options?.queue !== undefined && { queue: options.queue }),
    });
    return Promise.resolve({
      unsubscribe: (): Promise<void> => {
        this.unsubscribeCalls++;
        return Promise.resolve();
      },
    });
  }

  /**
   * Opens the inbox through the REAL `createTopicInbox` helper — the same one
   * the four generic brokers pass — so this suite exercises the shipped seam
   * rather than a bespoke stand-in. `subscribe` is resolved at call time so a
   * test that monkey-patches it still intercepts the inbox subscription.
   */
  openInbox(onReply: (message: unknown) => void): Promise<ReplyInbox> {
    this.openInboxCalls++;
    return createTopicInbox({
      subscribe: (topic, handler, options) => this.subscribe(topic, handler, options),
      uuid: () => this.uuid(),
    })(onReply);
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

    // uuid #0 is consumed lazily by openInbox on the first request, #1 by the
    // correlation id — the inbox is no longer minted in the constructor.
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

    await t.deliver('rr.req.topic', { not: 'an-envelope' });
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
    // And the seam itself was entered exactly once, not merely deduped downstream.
    expect(t.openInboxCalls).toBe(1);
  });

  it('publishes requests to the derived rr.req channel, never the caller topic', async () => {
    const t = new FakeTransport();
    const core = new RequestReplyCore(t);

    await core.respond('user.lookup', () => 'ok');
    await core.request('user.lookup', { id: 1 });

    const requestPublish = t.published.find((p) => p.topic.startsWith('rr.req.'));
    expect(requestPublish?.topic).toBe('rr.req.user.lookup');
    // Nothing was ever published to the bare caller topic.
    expect(t.published.some((p) => p.topic === 'user.lookup')).toBe(false);
  });

  it('subscribes responders to the derived rr.req channel, never the caller topic', async () => {
    const t = new FakeTransport();
    const core = new RequestReplyCore(t);

    await core.respond('user.lookup', () => 'ok');

    expect(t.subscribers.has('rr.req.user.lookup')).toBe(true);
    expect(t.subscribers.has('user.lookup')).toBe(false);
  });

  it('stamps the inbox address returned by openInbox as the request replyTo', async () => {
    const t = new FakeTransport();
    const core = new RequestReplyCore(t);
    t.autoDeliver = false;

    const pending = core.request('q', { a: 1 }, { timeoutMs: 20 });
    await flush();

    const envelope = t.published[0]?.message as { replyTo?: string };
    // createTopicInbox minted rr.inbox.id-0; the envelope must carry exactly it.
    expect(envelope.replyTo).toBe('rr.inbox.id-0');

    await expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);
  });

  it('opens the inbox with its own queue name so delivery is not load-balanced', async () => {
    const t = new FakeTransport();
    const core = new RequestReplyCore(t);
    t.autoDeliver = false;

    const pending = core.request('q', {}, { timeoutMs: 20 });
    await flush();

    const inboxSub = t.subscribeOptions.find((s) => s.topic.startsWith('rr.inbox.'));
    expect(inboxSub?.queue).toBe(inboxSub?.topic);

    await expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);
  });

  it('close() then a later request reopens the inbox rather than reusing a closed one', async () => {
    const t = new FakeTransport();
    const core = new RequestReplyCore(t);
    await core.respond('echo', (n) => n);

    await expect(core.request<number>('echo', 1)).resolves.toBe(1);
    await core.close();
    expect(t.unsubscribeCalls).toBe(1);

    // A second cycle must open a FRESH inbox (memo cleared by close()).
    await expect(core.request<number>('echo', 2)).resolves.toBe(2);
    expect(t.openInboxCalls).toBe(2);
  });

  it('closes an inbox whose open was still in flight when close() ran', async () => {
    // Disconnecting mid-open used to leave a live subscription nothing owned:
    // close() saw a null #inbox, and the open then resolved into it.
    const t = new FakeTransport();
    let releaseOpen: (() => void) | undefined;
    let inboxClosed = false;

    const core = new RequestReplyCore({
      publish: (topic, message) => t.publish(topic, message),
      subscribe: (topic, handler, options) => t.subscribe(topic, handler, options),
      uuid: () => t.uuid(),
      setTimeout: (fn, ms) => t.setTimeout(fn, ms),
      clearTimeout: (handle) => t.clearTimeout(handle),
      openInbox: (): Promise<ReplyInbox> =>
        new Promise<ReplyInbox>((resolve) => {
          releaseOpen = (): void =>
            resolve({
              address: 'rr.inbox.pending',
              close: (): Promise<void> => {
                inboxClosed = true;
                return Promise.resolve();
              },
            });
        }),
    });

    const pending = core.request('t', {}, { timeoutMs: 50 }).catch(() => {});
    await flush();

    const closing = core.close();
    releaseOpen!();
    await closing;
    await pending;

    expect(inboxClosed).toBe(true);
  });

  it('close() tolerates an in-flight open that ends up failing', async () => {
    // Nothing was allocated, so there is nothing to release — close() must
    // still resolve rather than surfacing the open's error to the caller.
    const t = new FakeTransport();
    let rejectOpen: ((reason: Error) => void) | undefined;

    const core = new RequestReplyCore({
      publish: (topic, message) => t.publish(topic, message),
      subscribe: (topic, handler, options) => t.subscribe(topic, handler, options),
      uuid: () => t.uuid(),
      setTimeout: (fn, ms) => t.setTimeout(fn, ms),
      clearTimeout: (handle) => t.clearTimeout(handle),
      openInbox: (): Promise<ReplyInbox> =>
        new Promise<ReplyInbox>((_resolve, reject) => {
          rejectOpen = reject;
        }),
    });

    const pending = core.request('t', {}, { timeoutMs: 50 }).catch(() => {});
    await flush();

    const closing = core.close();
    rejectOpen!(new Error('broker down'));
    await expect(closing).resolves.toBeUndefined();
    await pending;
  });

  it('recovers when the first inbox subscribe fails', async () => {
    const transport = new FakeTransport();
    let failNext = true;
    const originalSubscribe = transport.subscribe.bind(transport);
    transport.subscribe = (topic: string, handler: Handler): Promise<ISubscription> => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('broker down'));
      }
      return originalSubscribe(topic, handler);
    };

    const core = new RequestReplyCore(transport);

    // First request fails while the broker is down.
    await expect(core.request('topic', { a: 1 })).rejects.toThrow('broker down');

    // The broker is back. A cached rejected inbox promise would make every
    // later request fail with the same stale error forever.
    await core.respond('topic', (msg) => ({ echo: msg }));
    await expect(core.request('topic', { a: 1 })).resolves.toEqual({ echo: { a: 1 } });
  });
});
