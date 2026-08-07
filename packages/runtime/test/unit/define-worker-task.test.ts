/**
 * Unit tests for the worker-side task wiring: channel detection
 * (`resolveTaskPort`), protocol handling (`wireWorkerTask`), and the
 * public `defineWorkerTask` guard when called outside a worker.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { resolveTaskPort, wireWorkerTask } from '../../src/worker/task-port.ts';
import type { NodePortLike, TaskPort } from '../../src/worker/task-port.ts';
import { defineWorkerTask } from '../../src/worker/define-worker-task.ts';
import type { WorkerTaskReply } from '@setu-ts/common';
import { isWorkerTaskReply } from '@setu-ts/common';

/** In-memory TaskPort for driving wireWorkerTask directly. */
class FakePort implements TaskPort {
  readonly posted: unknown[] = [];
  private listener: ((message: unknown) => void) | null = null;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  onMessage(listener: (message: unknown) => void): void {
    this.listener = listener;
  }

  deliver(message: unknown): void {
    this.listener?.(message);
  }
}

/** Waits until the port has posted `count` messages. */
async function postedAtLeast(port: FakePort, count: number): Promise<void> {
  for (let i = 0; i < 50 && port.posted.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe('resolveTaskPort', () => {
  it('should prefer the web channel when the scope exposes postMessage', () => {
    const posted: unknown[] = [];
    const scope: {
      postMessage: (message: unknown) => void;
      onmessage: ((event: { data: unknown }) => void) | null;
    } = {
      postMessage: (message) => posted.push(message),
      onmessage: null,
    };
    const nodePort: NodePortLike = {
      postMessage: () => {
        throw new Error('node channel must not be used when web channel exists');
      },
      on: () => undefined,
    };

    const port = resolveTaskPort(scope, nodePort);
    port.postMessage({ via: 'web' });
    expect(posted).toEqual([{ via: 'web' }]);

    const received: unknown[] = [];
    port.onMessage((message) => received.push(message));
    scope.onmessage?.({ data: { n: 1 } });
    expect(received).toEqual([{ n: 1 }]);
  });

  it('should fall back to parentPort when the scope has no postMessage', () => {
    const posted: unknown[] = [];
    const listeners: Array<(message: unknown) => void> = [];
    const nodePort: NodePortLike = {
      postMessage: (value) => posted.push(value),
      on: (_event, listener) => listeners.push(listener),
    };

    const port = resolveTaskPort({}, nodePort);
    port.postMessage({ via: 'node' });
    expect(posted).toEqual([{ via: 'node' }]);

    const received: unknown[] = [];
    port.onMessage((message) => received.push(message));
    listeners[0]?.({ n: 2 });
    expect(received).toEqual([{ n: 2 }]);
  });

  it('should throw when neither channel exists', () => {
    expect(() => resolveTaskPort({}, null)).toThrow('inside a worker');
  });
});

describe('wireWorkerTask', () => {
  it('should post the ready signal immediately after wiring', () => {
    const port = new FakePort();
    wireWorkerTask((input: number) => input, port);
    expect(port.posted).toEqual([{ __hewp: 1, kind: 'ready' }]);
  });

  it('should reply ok with the handler result, correlated by id', async () => {
    const port = new FakePort();
    wireWorkerTask((input: number) => input * 2, port);
    port.deliver({ __hewp: 1, kind: 'task', id: 41, input: 21 });
    await postedAtLeast(port, 2);
    const reply = port.posted[1] as WorkerTaskReply;
    expect(isWorkerTaskReply(reply)).toBe(true);
    expect(reply.id).toBe(41);
    expect(reply.ok).toBe(true);
    expect(reply.result).toBe(42);
  });

  it('should support async handlers', async () => {
    const port = new FakePort();
    wireWorkerTask((input: string) => Promise.resolve(input.toUpperCase()), port);
    port.deliver({ __hewp: 1, kind: 'task', id: 1, input: 'abc' });
    await postedAtLeast(port, 2);
    expect((port.posted[1] as WorkerTaskReply).result).toBe('ABC');
  });

  it('should reply ok:false with the serialized error when the handler throws', async () => {
    const port = new FakePort();
    wireWorkerTask(() => {
      throw new RangeError('out of range');
    }, port);
    port.deliver({ __hewp: 1, kind: 'task', id: 7, input: null });
    await postedAtLeast(port, 2);
    const reply = port.posted[1] as WorkerTaskReply;
    expect(reply.ok).toBe(false);
    expect(reply.error?.name).toBe('RangeError');
    expect(reply.error?.message).toBe('out of range');
    expect(typeof reply.error?.stack).toBe('string');
  });

  it('should serialize non-Error throws with String()', async () => {
    const port = new FakePort();
    wireWorkerTask(() => {
      throw 'plain string failure';
    }, port);
    port.deliver({ __hewp: 1, kind: 'task', id: 8, input: null });
    await postedAtLeast(port, 2);
    const reply = port.posted[1] as WorkerTaskReply;
    expect(reply.error).toEqual({ name: 'Error', message: 'plain string failure' });
  });

  it('should ignore non-protocol messages', async () => {
    const port = new FakePort();
    wireWorkerTask((input: number) => input, port);
    port.deliver({ anything: 'else' });
    port.deliver(null);
    port.deliver({ __hewp: 1, kind: 'ready' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(port.posted).toHaveLength(1);
  });
});

describe('defineWorkerTask', () => {
  it('should throw when called outside a worker (no channel on the main thread)', () => {
    expect(() => defineWorkerTask((input: number) => input)).toThrow('inside a worker');
  });
});
