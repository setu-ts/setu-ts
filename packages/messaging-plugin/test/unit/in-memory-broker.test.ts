import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { InMemoryBroker } from '../../src/brokers/in-memory-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { RemoteHandlerError, RequestTimeoutError } from '../../src/errors.ts';

/**
 * InMemoryBroker unit tests.
 *
 * Tests fanout delivery, queue round-robin, lifecycle, and error handling.
 */
describe('InMemoryBroker', () => {
  it('fanout delivery (no-queue subscribers all receive)', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new InMemoryBroker(runtime, serializer);

    await broker.connect();

    const received: string[] = [];

    // Subscribe without queue (fanout)
    await broker.subscribe('test.topic', (msg) => {
      received.push(`handler1: ${msg}`);
    });

    await broker.subscribe('test.topic', (msg) => {
      received.push(`handler2: ${msg}`);
    });

    await broker.publish('test.topic', 'hello');

    expect(received.length).toBe(2);
    expect(received).toContain('handler1: hello');
    expect(received).toContain('handler2: hello');

    await broker.disconnect();
  });

  it('queue round-robin delivery', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new InMemoryBroker(runtime, serializer);

    await broker.connect();

    const received: string[] = [];

    // Subscribe with same queue (load-balanced)
    await broker.subscribe('test.topic', (_msg) => {
      received.push('handler1');
    }, { queue: 'my-queue' });

    await broker.subscribe('test.topic', (_msg) => {
      received.push('handler2');
    }, { queue: 'my-queue' });

    // First publish - should go to handler1 (cursor at 0)
    await broker.publish('test.topic', 'msg1');

    // Second publish - should go to handler2 (cursor at 1)
    await broker.publish('test.topic', 'msg2');

    // Third publish - should go to handler1 (cursor wraps to 0)
    await broker.publish('test.topic', 'msg3');

    expect(received).toEqual(['handler1', 'handler2', 'handler1']);

    await broker.disconnect();
  });

  it('messageId and timestamp populated', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new InMemoryBroker(runtime, serializer);

    await broker.connect();

    let capturedMetadata: unknown = null;

    await broker.subscribe('test.topic', (_msg, metadata) => {
      capturedMetadata = metadata;
    });

    await broker.publish('test.topic', 'test');

    expect(capturedMetadata).toBeDefined();
    expect((capturedMetadata as Record<string, unknown>).topic).toBe('test.topic');
    expect((capturedMetadata as Record<string, unknown>).messageId).toBeDefined();
    expect((capturedMetadata as Record<string, unknown>).timestamp).toBeInstanceOf(Date);

    await broker.disconnect();
  });

  it('sequential handler ordering', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new InMemoryBroker(runtime, serializer);

    await broker.connect();

    const order: string[] = [];

    await broker.subscribe('test.topic', async () => {
      order.push('first');
      // Simulate async work
      await new Promise((r) => setTimeout(r, 10));
    });

    await broker.subscribe('test.topic', async () => {
      order.push('second');
      await new Promise((r) => setTimeout(r, 10));
    });

    await broker.publish('test.topic', 'test');

    // Handlers should be called in subscription order
    expect(order).toEqual(['first', 'second']);

    await broker.disconnect();
  });

  it('handler rejection propagates to publish', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new InMemoryBroker(runtime, serializer);

    await broker.connect();

    await broker.subscribe('test.topic', () => {
      throw new Error('handler failed');
    });

    await expect(broker.publish('test.topic', 'test')).rejects.toThrow('handler failed');

    await broker.disconnect();
  });

  it('unsubscribe removes subscription', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new InMemoryBroker(runtime, serializer);

    await broker.connect();

    let called = false;

    const subscription = await broker.subscribe('test.topic', () => {
      called = true;
    });

    await subscription.unsubscribe();

    await broker.publish('test.topic', 'test');

    expect(called).toBe(false);

    await broker.disconnect();
  });

  it('idempotent connect', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new InMemoryBroker(runtime, serializer);

    await broker.connect();
    expect(broker.isReady()).toBe(true);

    // Second connect should be a no-op
    await broker.connect();
    expect(broker.isReady()).toBe(true);

    await broker.disconnect();
  });

  it('disconnect clears subscriptions', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new InMemoryBroker(runtime, serializer);

    await broker.connect();

    let called = false;

    await broker.subscribe('test.topic', () => {
      called = true;
    });

    await broker.disconnect();
    expect(broker.isReady()).toBe(false);

    await broker.connect();

    await broker.publish('test.topic', 'test');

    // Old subscription should be cleared
    expect(called).toBe(false);

    await broker.disconnect();
  });

  it('READ-BACK: publish and receive same payload', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new InMemoryBroker(runtime, serializer);

    await broker.connect();

    const original = { userId: 123, name: 'test', data: [1, 2, 3] };
    let received: unknown = null;

    await broker.subscribe('test.topic', (msg) => {
      received = msg;
    });

    await broker.publish('test.topic', original);

    expect(received).toEqual(original);

    await broker.disconnect();
  });
});

describe('InMemoryBroker request-reply', () => {
  it('round-trips request() to respond() and resolves with the handler result', async () => {
    const broker = new InMemoryBroker(createFakeRuntime(), new JsonSerializer());
    await broker.connect();

    await broker.respond<{ n: number }, number>('math.square', (msg) => msg.n * msg.n);
    const result = await broker.request<{ n: number }, number>('math.square', { n: 9 });

    expect(result).toBe(81);
    await broker.disconnect();
  });

  it('propagates a responder throw as RemoteHandlerError', async () => {
    const broker = new InMemoryBroker(createFakeRuntime(), new JsonSerializer());
    await broker.connect();

    await broker.respond('failing', () => {
      throw new Error('nope');
    });

    let caught: unknown;
    try {
      await broker.request('failing', {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RemoteHandlerError);
    expect((caught as RemoteHandlerError).remoteMessage).toBe('nope');
    await broker.disconnect();
  });

  it('rejects with RequestTimeoutError when no responder replies', async () => {
    const broker = new InMemoryBroker(createFakeRuntime(), new JsonSerializer());
    await broker.connect();

    let caught: unknown;
    try {
      await broker.request('unanswered', {}, { timeoutMs: 20 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RequestTimeoutError);
    await broker.disconnect();
  });

  it('load-balances requests across queued responders', async () => {
    const broker = new InMemoryBroker(createFakeRuntime(), new JsonSerializer());
    await broker.connect();

    await broker.respond<number, string>('work', (n) => `a:${n}`, { queue: 'workers' });
    await broker.respond<number, string>('work', (n) => `b:${n}`, { queue: 'workers' });

    const r1 = await broker.request<number, string>('work', 1);
    const r2 = await broker.request<number, string>('work', 2);

    // Round-robin across the two queued responders.
    expect([r1, r2].sort()).toEqual(['a:1', 'b:2']);
    await broker.disconnect();
  });
});
