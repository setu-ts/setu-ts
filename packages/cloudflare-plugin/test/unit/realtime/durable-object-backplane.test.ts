/**
 * The replica side of the backplane.
 *
 * The connect/close lifecycle mirrors `RedisBackplane`'s, because the hazards
 * are identical: overlapping opens must not each build a socket, a failed open
 * must not poison the memo, and a `close()` landing mid-open must retire the
 * socket rather than let it arrive on a closed backplane with nothing holding a
 * reference to shut it down.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { ILogger, RealtimeFrame } from '@hono-enterprise/common';
import type { IServiceBinding } from '../../../src/bindings/facades.ts';
import type { IDurableObjectNamespace } from '../../../src/bindings/facades.ts';
import { DurableObjectBackplane } from '../../../src/realtime/durable-object-backplane.ts';
import { CloudflareUnsupportedError } from '../../../src/errors.ts';
import type { FakeClientSocket } from '../../do-fakes.ts';
import { linkedPair } from '../../do-fakes.ts';
import { RecordingLogger } from '../../fakes.ts';

const FRAME: RealtimeFrame = {
  kind: 'ws-room',
  origin: 'replica-a',
  name: 'lobby',
  data: 'hello',
};

/**
 * A namespace whose upgrades the test drives directly.
 *
 * Deliberately not the shared `FakeDurableObjectNamespace`: these tests are
 * about the CLIENT's lifecycle, so they need to control what each upgrade
 * answers, including failing.
 */
class ScriptedNamespace implements IDurableObjectNamespace {
  readonly sockets: FakeClientSocket[] = [];
  opens = 0;
  /** Set to make the next upgrade reject. */
  failNext = false;
  /** Set to answer without a `webSocket` member. */
  omitSocket = false;
  /** Invoked after each open, so a test can close mid-attempt. */
  onOpen: (() => void) | undefined;

  idFromName(name: string): unknown {
    return name;
  }

  get(_id: unknown): IServiceBinding {
    return {
      fetch: async (): Promise<Response> => {
        this.opens++;
        if (this.failNext) {
          this.failNext = false;
          throw new Error('durable object unreachable');
        }
        if (this.omitSocket) {
          return { status: 500 } as unknown as Response;
        }
        const { client } = linkedPair();
        this.sockets.push(client);
        // Awaiting a microtask makes the open genuinely asynchronous, which is
        // what lets a concurrency test overlap two connects.
        await Promise.resolve();
        this.onOpen?.();
        return { status: 101, webSocket: client } as unknown as Response;
      },
    };
  }
}

function build(namespace: IDurableObjectNamespace, logger?: () => ILogger | undefined) {
  return new DurableObjectBackplane(namespace, {
    origin: 'replica-a',
    binding: 'REALTIME',
    topic: 'realtime',
    ...(logger === undefined ? {} : { logger }),
  });
}

describe('DurableObjectBackplane.connect', () => {
  it('joins one attempt when called concurrently', async () => {
    const namespace = new ScriptedNamespace();
    const backplane = build(namespace);

    await Promise.all([backplane.connect(), backplane.connect(), backplane.connect()]);

    expect(namespace.opens).toBe(1);
    expect(namespace.sockets[0]?.accepted).toBe(true);
  });

  it('is idempotent across sequential calls', async () => {
    const namespace = new ScriptedNamespace();
    const backplane = build(namespace);

    await backplane.connect();
    await backplane.connect();

    expect(namespace.opens).toBe(1);
  });

  it('clears the memo after a failed open, so a retry genuinely reopens', async () => {
    const namespace = new ScriptedNamespace();
    namespace.failNext = true;
    const backplane = build(namespace);

    await expect(backplane.connect()).rejects.toThrow('durable object unreachable');
    await backplane.connect();

    expect(namespace.opens).toBe(2);
  });

  it('throws naming the binding when the object answers without a socket', async () => {
    const namespace = new ScriptedNamespace();
    namespace.omitSocket = true;

    await expect(build(namespace).connect()).rejects.toThrow(CloudflareUnsupportedError);
  });

  it('retires the socket when a close lands mid-open', async () => {
    const namespace = new ScriptedNamespace();
    const backplane = build(namespace);
    namespace.onOpen = () => {
      void backplane.close();
    };

    await backplane.connect();

    // Published to a closed backplane, nothing would hold a reference to shut
    // this socket down — so the attempt must close it itself.
    expect(namespace.sockets[0]?.closed).toBe(true);
  });
});

describe('DurableObjectBackplane.publish', () => {
  it('connects on demand and sends the serialized frame', async () => {
    const namespace = new ScriptedNamespace();
    const backplane = build(namespace);

    await backplane.publish(FRAME);

    expect(namespace.opens).toBe(1);
    expect(namespace.sockets[0]?.sent).toEqual([JSON.stringify(FRAME)]);
  });

  it('reports a send failure through the logger and reopens on the next publish', async () => {
    const namespace = new ScriptedNamespace();
    const logger = new RecordingLogger();
    const backplane = build(namespace, () => logger);

    await backplane.publish(FRAME);
    namespace.sockets[0]!.failSend = true;
    await backplane.publish(FRAME);

    expect(logger.records[0]?.message).toContain('backplane publish failed');
    // The dead socket was retired, so this publish opens a new one instead of
    // writing into a connection that will never deliver again.
    await backplane.publish(FRAME);
    expect(namespace.opens).toBe(2);
    expect(namespace.sockets[1]?.sent).toEqual([JSON.stringify(FRAME)]);
  });

  it('reopens after the socket reported itself closed', async () => {
    const namespace = new ScriptedNamespace();
    const backplane = build(namespace);
    await backplane.publish(FRAME);

    namespace.sockets[0]!.fire('close', { data: '' });
    await backplane.publish(FRAME);

    expect(namespace.opens).toBe(2);
  });

  it('reopens after the socket reported an error', async () => {
    const namespace = new ScriptedNamespace();
    const backplane = build(namespace);
    await backplane.publish(FRAME);

    namespace.sockets[0]!.fire('error', { data: '' });
    await backplane.publish(FRAME);

    expect(namespace.opens).toBe(2);
  });

  it('reports a non-Error thrown by send without losing the value', async () => {
    const namespace = new ScriptedNamespace();
    const logger = new RecordingLogger();
    const backplane = build(namespace, () => logger);
    await backplane.publish(FRAME);
    namespace.sockets[0]!.send = () => {
      // A DOMException-style string throw, which `error.message` would drop.
      throw 'socket gone';
    };

    await backplane.publish(FRAME);

    expect(logger.records[0]?.meta).toMatchObject({ error: 'socket gone' });
  });

  it('a late close from a replaced socket does not retire the live one', async () => {
    const namespace = new ScriptedNamespace();
    const backplane = build(namespace);
    await backplane.publish(FRAME);
    const stale = namespace.sockets[0]!;
    stale.fire('close', { data: '' });
    await backplane.publish(FRAME); // opens a second socket

    // The stale socket's listener fires again — without the identity guard this
    // would retire the LIVE socket and force a needless third open.
    stale.fire('close', { data: '' });
    await backplane.publish(FRAME);

    expect(namespace.opens).toBe(2);
  });

  it('propagates a connect failure, since a caller cannot otherwise learn of it', async () => {
    const namespace = new ScriptedNamespace();
    namespace.failNext = true;

    await expect(build(namespace).publish(FRAME)).rejects.toThrow('durable object unreachable');
  });

  it('sends nothing when a close raced the publish', async () => {
    const namespace = new ScriptedNamespace();
    const backplane = build(namespace);
    namespace.onOpen = () => {
      void backplane.close();
    };

    await backplane.publish(FRAME);

    expect(namespace.sockets[0]?.sent).toEqual([]);
  });
});

describe('DurableObjectBackplane.subscribe', () => {
  it('delivers an arriving frame to every subscriber', async () => {
    const namespace = new ScriptedNamespace();
    const backplane = build(namespace);
    await backplane.connect();
    const seen: RealtimeFrame[] = [];
    await backplane.subscribe((frame) => seen.push(frame));

    namespace.sockets[0]!.receive(JSON.stringify({ ...FRAME, origin: 'replica-b' }));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.origin).toBe('replica-b');
  });

  it('drops a frame stamped with our own origin', async () => {
    const namespace = new ScriptedNamespace();
    const backplane = build(namespace);
    await backplane.connect();
    const seen: RealtimeFrame[] = [];
    await backplane.subscribe((frame) => seen.push(frame));

    // Reachable during a reconnect, when one replica briefly holds two sockets.
    namespace.sockets[0]!.receive(JSON.stringify(FRAME));

    expect(seen).toEqual([]);
  });

  it('drops unparseable and foreign traffic without throwing', async () => {
    const namespace = new ScriptedNamespace();
    const backplane = build(namespace);
    await backplane.connect();
    const seen: RealtimeFrame[] = [];
    await backplane.subscribe((frame) => seen.push(frame));
    const socket = namespace.sockets[0]!;

    socket.receive('{not json');
    socket.receive(JSON.stringify({ hello: 'world' }));
    socket.receive(new ArrayBuffer(4));

    expect(seen).toEqual([]);
  });

  it('reports a throwing subscriber and keeps delivering to the next', async () => {
    const namespace = new ScriptedNamespace();
    const logger = new RecordingLogger();
    const backplane = build(namespace, () => logger);
    await backplane.connect();
    const seen: string[] = [];
    await backplane.subscribe(() => {
      throw new Error('subscriber exploded');
    });
    await backplane.subscribe((frame) => seen.push(frame.name));

    namespace.sockets[0]!.receive(JSON.stringify({ ...FRAME, origin: 'replica-b' }));

    expect(seen).toEqual(['lobby']);
    expect(logger.records[0]?.message).toContain('subscriber threw');
  });

  it('reports a non-Error thrown by a subscriber without losing the value', async () => {
    const namespace = new ScriptedNamespace();
    const logger = new RecordingLogger();
    const backplane = build(namespace, () => logger);
    await backplane.connect();
    await backplane.subscribe(() => {
      throw 'handler blew up';
    });

    namespace.sockets[0]!.receive(JSON.stringify({ ...FRAME, origin: 'replica-b' }));

    expect(logger.records[0]?.meta).toMatchObject({ error: 'handler blew up' });
  });

  it('stops delivering after unsubscribe', async () => {
    const namespace = new ScriptedNamespace();
    const backplane = build(namespace);
    await backplane.connect();
    const seen: RealtimeFrame[] = [];
    const unsubscribe = await backplane.subscribe((frame) => seen.push(frame));

    unsubscribe();
    namespace.sockets[0]!.receive(JSON.stringify({ ...FRAME, origin: 'replica-b' }));

    expect(seen).toEqual([]);
  });
});

describe('DurableObjectBackplane.close', () => {
  it('closes the socket and drops every handler', async () => {
    const namespace = new ScriptedNamespace();
    const backplane = build(namespace);
    await backplane.connect();
    const seen: RealtimeFrame[] = [];
    await backplane.subscribe((frame) => seen.push(frame));
    const socket = namespace.sockets[0]!;

    await backplane.close();

    expect(socket.closed).toBe(true);
    socket.receive(JSON.stringify({ ...FRAME, origin: 'replica-b' }));
    expect(seen).toEqual([]);
  });

  it('is safe to call when nothing was ever opened', async () => {
    await build(new ScriptedNamespace()).close();
  });

  it('lets a later connect reopen rather than resolving the old attempt', async () => {
    const namespace = new ScriptedNamespace();
    const backplane = build(namespace);
    await backplane.connect();

    await backplane.close();
    await backplane.connect();

    expect(namespace.opens).toBe(2);
  });

  it('tolerates a socket that throws on close', async () => {
    const namespace = new ScriptedNamespace();
    const backplane = build(namespace);
    await backplane.connect();
    namespace.sockets[0]!.close = () => {
      throw new Error('already closed');
    };

    await backplane.close();
  });

  it('exposes the configured origin', () => {
    expect(build(new ScriptedNamespace()).origin).toBe('replica-a');
  });
});
