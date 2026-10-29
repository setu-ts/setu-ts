/**
 * Tests for the in-process backplane transport.
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import type { RealtimeFrame } from '@setu-ts/common';
import { MemoryBackplane } from '../../src/transports/memory-backplane.ts';

it('captures asynchronous non-coercible rejection values without a history-sink rejection', async () => {
  const sender = new MemoryBackplane('sender', 'non-coercible-error');
  const receiver = new MemoryBackplane('receiver', 'non-coercible-error');
  const unhandled: unknown[] = [];
  const listener = (error: unknown): void => {
    unhandled.push(error);
  };
  const error: unknown = Object.create(null);
  process.on('unhandledRejection', listener);
  try {
    await sender.connect();
    await receiver.connect();
    await receiver.subscribe(async () => {
      await Promise.resolve();
      throw error;
    });
    await sender.publish({ kind: 'ws-room', origin: 'sender', name: 'room', data: 'hi' });
    await setImmediate();
    expect(unhandled).toEqual([]);
    expect(receiver.handlerErrors).toHaveLength(1);
    expect(receiver.handlerErrors[0]).toBeInstanceOf(Error);
  } finally {
    await sender.close();
    await receiver.close();
    process.off('unhandledRejection', listener);
  }
});

it('captures asynchronous memory subscriber errors in bounded history and reporter', async () => {
  const failed = vi.fn();
  const succeeded = vi.fn();
  const sender = new MemoryBackplane('sender', 'async-errors');
  const receiver = new MemoryBackplane('receiver', 'async-errors', { failed, succeeded });
  const unhandled: unknown[] = [];
  const listener = (error: unknown): void => {
    unhandled.push(error);
  };
  process.on('unhandledRejection', listener);
  try {
    await sender.connect();
    await receiver.connect();
    const error = new Error('async subscriber');
    const bad = async (): Promise<void> => {
      await Promise.resolve();
      throw error;
    };
    await receiver.subscribe(bad);
    const good = (): void => {};
    await receiver.subscribe(good);
    const frame: RealtimeFrame = { kind: 'ws-room', origin: 'sender', name: 'room', data: 'hi' };
    for (let i = 0; i < 101; i++) await sender.publish(frame);
    await setImmediate();
    expect(unhandled).toEqual([]);
    expect(receiver.handlerErrors).toHaveLength(100);
    expect(failed).toHaveBeenCalledTimes(101);
    expect(failed).toHaveBeenCalledWith(bad, error, frame);
    expect(succeeded).toHaveBeenCalledWith(good);
  } finally {
    await sender.close();
    await receiver.close();
    process.off('unhandledRejection', listener);
  }
});

/** Builds a frame with a caller-chosen origin. */
function frame(origin: string, name = 'lobby'): RealtimeFrame {
  return { kind: 'ws-room', origin, name, data: 'hi' };
}

describe('MemoryBackplane', () => {
  it('exposes the origin it was built with', () => {
    expect(new MemoryBackplane('node-a').origin).toBe('node-a');
  });

  it('delivers a published frame to another connected instance', async () => {
    const a = new MemoryBackplane('node-a', 'bus-1');
    const b = new MemoryBackplane('node-b', 'bus-1');
    await a.connect();
    await b.connect();

    const received: RealtimeFrame[] = [];
    await b.subscribe((f) => received.push(f));

    await a.publish(frame('node-a'));

    expect(received).toEqual([frame('node-a')]);
    await a.close();
    await b.close();
  });

  it('never delivers a frame back to its own publisher', async () => {
    const a = new MemoryBackplane('node-a', 'bus-2');
    await a.connect();

    const received: RealtimeFrame[] = [];
    await a.subscribe((f) => received.push(f));
    await a.publish(frame('node-a'));

    // Local members already received the broadcast directly; redelivering it
    // here would double-send.
    expect(received).toEqual([]);
    await a.close();
  });

  it('drops a frame carrying the receiving instance own origin', async () => {
    const a = new MemoryBackplane('node-a', 'bus-3');
    const b = new MemoryBackplane('shared-origin', 'bus-3');
    await a.connect();
    await b.connect();

    const received: RealtimeFrame[] = [];
    await b.subscribe((f) => received.push(f));

    // A publishes a frame stamped with B's origin — the echo-suppression case.
    await a.publish(frame('shared-origin'));

    expect(received).toEqual([]);
    await a.close();
    await b.close();
  });

  it('isolates separate named buses', async () => {
    const a = new MemoryBackplane('node-a', 'bus-x');
    const b = new MemoryBackplane('node-b', 'bus-y');
    await a.connect();
    await b.connect();

    const received: RealtimeFrame[] = [];
    await b.subscribe((f) => received.push(f));
    await a.publish(frame('node-a'));

    expect(received).toEqual([]);
    await a.close();
    await b.close();
  });

  it('supports several handlers and removes only the unsubscribed one', async () => {
    const a = new MemoryBackplane('node-a', 'bus-4');
    const b = new MemoryBackplane('node-b', 'bus-4');
    await a.connect();
    await b.connect();

    const first: RealtimeFrame[] = [];
    const second: RealtimeFrame[] = [];
    const unsubscribeFirst = await b.subscribe((f) => first.push(f));
    await b.subscribe((f) => second.push(f));

    await a.publish(frame('node-a', 'one'));
    unsubscribeFirst();
    await a.publish(frame('node-a', 'two'));

    expect(first.map((f) => f.name)).toEqual(['one']);
    expect(second.map((f) => f.name)).toEqual(['one', 'two']);
    await a.close();
    await b.close();
  });

  it('is idempotent on connect', async () => {
    const a = new MemoryBackplane('node-a', 'bus-5');
    const b = new MemoryBackplane('node-b', 'bus-5');
    await a.connect();
    await a.connect();
    await b.connect();

    const received: RealtimeFrame[] = [];
    await b.subscribe((f) => received.push(f));
    await a.publish(frame('node-a'));

    // A double connect must not register A twice, which would double-deliver.
    expect(received.length).toBe(1);
    await a.close();
    await b.close();
  });

  it('stops delivering after close', async () => {
    const a = new MemoryBackplane('node-a', 'bus-6');
    const b = new MemoryBackplane('node-b', 'bus-6');
    await a.connect();
    await b.connect();

    const received: RealtimeFrame[] = [];
    await b.subscribe((f) => received.push(f));
    await b.close();
    await a.publish(frame('node-a'));

    expect(received).toEqual([]);
    await a.close();
  });

  it('publishing on a closed instance is a no-op rather than a throw', async () => {
    const a = new MemoryBackplane('node-a', 'bus-7');
    await a.connect();
    await a.close();
    await a.publish(frame('node-a'));
  });
});

describe('MemoryBackplane handler isolation', () => {
  it('D3 retains only the latest 100 of 1,000 handler errors in delivery order', async () => {
    const sender = new MemoryBackplane('sender', 'bounded-errors');
    const receiver = new MemoryBackplane('receiver', 'bounded-errors');
    await sender.connect();
    await receiver.connect();
    const thrown = Array.from({ length: 1_000 }, (_, i) => new Error(`failure-${i}`));
    let calls = 0;
    await receiver.subscribe(() => {
      const index = calls++;
      throw index === 0 ? 'non-Error subscriber failure' : thrown[index];
    });
    try {
      for (let i = 0; i < 1_000; i++) await sender.publish(frame('sender'));
      expect(calls).toBe(1_000);
      expect(receiver.handlerErrors).toHaveLength(100);
      expect(receiver.handlerErrors).toEqual(thrown.slice(-100));
    } finally {
      await sender.close();
      await receiver.close();
    }
  });

  it('continues delivering after a handler throws, and records the error', async () => {
    const a = new MemoryBackplane('node-a', 'iso-1');
    const b = new MemoryBackplane('node-b', 'iso-1');
    await a.connect();
    await b.connect();

    const reached: string[] = [];
    await b.subscribe(() => {
      throw new Error('websocket consumer blew up');
    });
    await b.subscribe(() => reached.push('sse consumer'));

    await a.publish(frame('node-a'));

    // Both plugins subscribe to one backplane; one throwing must not starve
    // the other, and publish() must not reject for the publisher either.
    expect(reached).toEqual(['sse consumer']);
    expect(b.handlerErrors.map((e) => e.message)).toEqual(['websocket consumer blew up']);
    await a.close();
    await b.close();
  });
});

it('can publish and close before connecting without registering a bus', async () => {
  const unopened = new MemoryBackplane('unopened', 'unopened-bus');
  await unopened.publish(frame('unopened'));
  await unopened.close();
  await unopened.close();
  const receiver = new MemoryBackplane('receiver', 'unopened-bus');
  await receiver.connect();
  const received: RealtimeFrame[] = [];
  await receiver.subscribe((value) => received.push(value));
  await unopened.publish(frame('unopened'));
  expect(received).toEqual([frame('unopened')]);
  await receiver.close();
});
