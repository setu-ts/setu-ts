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

  // B6: Exactly-once reply inbox under concurrent first requests and partial failure
  describe('B6: concurrent first requests and partial-failure retry', () => {
    it('two concurrent FIRST request() calls → openInbox called exactly once', async () => {
      const transport = new FakeTransport();
      const core = new RequestReplyCore(transport);

      // Responder echoes payload back
      await core.respond('topic', (msg) => msg);

      // Fire two concurrent requests before either resolves
      const [r1, r2] = await Promise.all([
        core.request('topic', { a: 1 }, { timeoutMs: 2000 }),
        core.request('topic', { b: 2 }, { timeoutMs: 2000 }),
      ]);

      // Both resolve (auto-deliver routes through responder → inbox)
      expect(r1).toEqual({ a: 1 });
      expect(r2).toEqual({ b: 2 });
      // openInbox called exactly once — no duplicate creation
      expect(transport.openInboxCalls).toBe(1);
    });

    it('admin create succeeds, transport open fails → not cached; next retries', async () => {
      const transport = new FakeTransport();
      let first = true;

      // First openInbox fails
      const origOpen = transport.openInbox.bind(transport);
      transport.openInbox = (onReply) => {
        if (first) {
          first = false;
          throw new Error('transport-unavailable');
        }
        return origOpen(onReply);
      };

      const core = new RequestReplyCore(transport);
      await core.respond('topic', (msg) => msg);

      // First request fails
      await expect(core.request('topic', { a: 1 }, { timeoutMs: 2000 })).rejects.toThrow(
        'transport-unavailable',
      );

      // Next request retries and succeeds (inbox was NOT cached on failure)
      await expect(core.request('topic', { a: 2 }, { timeoutMs: 2000 })).resolves.toEqual({
        a: 2,
      });
    });

    it('disconnect after successful open → close called once', async () => {
      const transport = new FakeTransport();
      const core = new RequestReplyCore(transport);

      await core.respond('topic', (msg) => msg);
      await core.request('topic', { a: 1 }, { timeoutMs: 2000 });
      expect(transport.openInboxCalls).toBe(1);

      // Close tears down inbox (unsubscribe = the respond subscription + inbox subscription)
      await core.close();
      // close() unsubscribes the inbox; at least 1 unsubscribe call
      expect(transport.unsubscribeCalls).toBeGreaterThanOrEqual(1);

      // Close is idempotent — should not throw
      await core.close();
    });
  });

  // B1: RPC settlement semantics
  describe('B1: RPC settlement semantics', () => {
    it('two concurrent requests receive out-of-order replies to correct request', async () => {
      // Two requests fire, but the reply for request #2 arrives before request #1.
      // Each reply must resolve the correct pending request.
      const t = new FakeTransport();
      t.autoDeliver = false;
      const core = new RequestReplyCore(t);

      // Start two requests; uuid sequence: id-0 (inbox), id-1 (corrA), id-2 (corrB)
      const pendingA = core.request('echo', 'A', { timeoutMs: 10000 });
      const pendingB = core.request('echo', 'B', { timeoutMs: 10000 });
      await flush();
      await flush();

      // Deliver reply for B first (correlationId id-2), then A (id-1)
      await t.deliver('rr.inbox.id-0', {
        kind: 'rr-reply',
        correlationId: 'id-2',
        ok: true,
        payload: 'B-reply',
      });
      await t.deliver('rr.inbox.id-0', {
        kind: 'rr-reply',
        correlationId: 'id-1',
        ok: true,
        payload: 'A-reply',
      });

      // Each request resolves with its own value
      const resultB = await pendingB;
      const resultA = await pendingA;
      expect(resultB).toBe('B-reply');
      expect(resultA).toBe('A-reply');
    });

    it('foreign correlation reply (no matching pending) is silently dropped', async () => {
      // A reply with a correlationId that matches no pending request must be
      // silently ignored — it must not resolve/reject any other pending request
      // or throw.
      const t = new FakeTransport();
      t.autoDeliver = false;
      const core = new RequestReplyCore(t);

      // One pending request; uuid sequence: id-0 (inbox), id-1 (corr)
      const pending = core.request('echo', 'A', { timeoutMs: 10000 });
      await flush();
      await flush();

      // Deliver a foreign reply (correlationId never created)
      await t.deliver('rr.inbox.id-0', {
        kind: 'rr-reply',
        correlationId: 'foreign-uuid',
        ok: true,
        payload: 'foreign',
      });

      // Deliver the real reply
      await t.deliver('rr.inbox.id-0', {
        kind: 'rr-reply',
        correlationId: 'id-1',
        ok: true,
        payload: 'A-ok',
      });

      await expect(pending).resolves.toBe('A-ok');
    });

    it('malformed reply on shared inbox is silently dropped', async () => {
      // A reply that is not a valid rr-reply envelope (e.g., missing kind) must
      // be silently ignored.
      const t = new FakeTransport();
      t.autoDeliver = false;
      const core = new RequestReplyCore(t);

      const pending = core.request('echo', 'A', { timeoutMs: 10000 });
      await flush();
      await flush();

      // Deliver malformed message (no kind field)
      await t.deliver('rr.inbox.id-0', { notAReply: true });
      // Deliver well-formed reply
      await t.deliver('rr.inbox.id-0', {
        kind: 'rr-reply',
        correlationId: 'id-1',
        ok: true,
        payload: 'A-ok',
      });

      await expect(pending).resolves.toBe('A-ok');
    });

    it('ok:false reply with error field rejects with RemoteHandlerError', async () => {
      const t = new FakeTransport();
      t.autoDeliver = false;
      const core = new RequestReplyCore(t);

      const pending = core.request('boom', 'A', { timeoutMs: 10000 });
      await flush();
      await flush();

      await t.deliver('rr.inbox.id-0', {
        kind: 'rr-reply',
        correlationId: 'id-1',
        ok: false,
        error: 'remote-explosion',
      });

      await expect(pending).rejects.toBeInstanceOf(RemoteHandlerError);
    });
  });

  // Finding 2: close/initialization race test
  // A request that is waiting for inbox initialization must be rejected immediately
  // when close() is called, not after the inbox opens.
  it('Finding 2: concurrent close during first request initialization rejects immediately', async () => {
    // This test fails under the reviewed code behavior where close() could
    // complete while inbox open is pending, leaving the request to proceed
    // with a now-dead inbox.
    let releaseOpen: (() => void) | undefined;
    let inboxClosed = false;
    let publishCalls = 0;
    const t = new FakeTransport();

    const core = new RequestReplyCore({
      publish: (topic, message) => {
        publishCalls++;
        return t.publish(topic, message);
      },
      subscribe: (topic, handler, options) => t.subscribe(topic, handler, options),
      uuid: () => t.uuid(),
      setTimeout: (fn, ms) => t.setTimeout(fn, ms),
      clearTimeout: (handle) => t.clearTimeout(handle),
      openInbox: (): Promise<ReplyInbox> =>
        new Promise<ReplyInbox>((resolve) => {
          releaseOpen = (): void =>
            resolve({
              address: 'rr.inbox.pending-race',
              close: (): Promise<void> => {
                inboxClosed = true;
                return Promise.resolve();
              },
            });
        }),
    });

    // Start a request; it will wait for inbox open
    const requestPromise = core.request('test-topic', {}, { timeoutMs: 5000 }).then(
      (value) => ({ rejected: false, value }) as const,
      (err) => ({ rejected: true, error: err as Error }) as const,
    );

    // Let the request start waiting for inbox
    await flush();

    // Call close while inbox open is still pending
    const closePromise = core.close();

    // Release the inbox open after close was called
    releaseOpen!();

    // Both should complete
    const [requestResult] = await Promise.all([requestPromise, closePromise]);

    // Request must have been rejected due to close
    expect(requestResult.rejected).toBe(true);
    if (requestResult.rejected) {
      expect(requestResult.error.message).toContain('disconnected');
    }

    // Inbox must have been closed despite being opened after close() was called
    expect(inboxClosed).toBe(true);

    // No publish should have occurred because the request was rejected
    // (the generation check happens before publish)
    expect(publishCalls).toBe(0);
  });

  // Finding 2: race test with multiple concurrent requests
  it('Finding 2: multiple concurrent requests during close all reject', async () => {
    let resolveInbox: ((inbox: ReplyInbox) => void) | undefined;
    const t = new FakeTransport();

    const pendingInboxPromise = new Promise<ReplyInbox>((resolve) => {
      resolveInbox = resolve;
    });

    const core = new RequestReplyCore({
      publish: (topic, message) => t.publish(topic, message),
      subscribe: (topic, handler, options) => t.subscribe(topic, handler, options),
      uuid: () => t.uuid(),
      setTimeout: (fn, ms) => t.setTimeout(fn, ms),
      clearTimeout: (handle) => t.clearTimeout(handle),
      openInbox: (): Promise<ReplyInbox> => pendingInboxPromise,
    });

    // Fire multiple concurrent requests - they all wait for the same inbox
    const req1 = core.request('test1', {}).catch((err) => ({
      rejected: true,
      error: err as Error,
    }));
    const req2 = core.request('test2', {}).catch((err) => ({
      rejected: true,
      error: err as Error,
    }));
    const req3 = core.request('test3', {}).catch((err) => ({
      rejected: true,
      error: err as Error,
    }));

    await flush();

    // Close while all are waiting for inbox
    const closePromise = core.close();

    // Resolve the inbox promise after close was called
    resolveInbox!({
      address: 'rr.inbox.test',
      close: (): Promise<void> => Promise.resolve(),
    });

    // Wait for close to complete
    await closePromise;

    // All requests should have been rejected due to close
    type Result = { rejected: true; error: Error };
    const results = await Promise.all([req1, req2, req3]) as [Result, Result, Result];
    expect(results[0].rejected).toBe(true);
    expect(results[1].rejected).toBe(true);
    expect(results[2].rejected).toBe(true);
  });
});
