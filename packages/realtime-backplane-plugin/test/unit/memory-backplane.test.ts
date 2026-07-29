/**
 * Tests for the in-process backplane transport.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { RealtimeFrame } from '@hono-enterprise/common';
import { MemoryBackplane } from '../../src/transports/memory-backplane.ts';

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
