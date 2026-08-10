/**
 * The hibernation case is the one that would have shipped green. Sockets are
 * accepted with `state.acceptWebSocket`, so the runtime may evict the object
 * and re-run this constructor before the reply is posted — which is why the
 * delivery test below builds a FRESH core over the same state. A core keeping
 * membership in a field passes every other test in this file.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { ReplyInboxObjectCore } from '../../../src/durable-objects/reply-inbox-object.ts';
import { FakeDurableObjectState, FakeServerSocket, linkedPair } from '../../do-fakes.ts';

/**
 * A core whose pairs come from the linked fakes, so sends are observable.
 *
 * Assertions read `server.sent` — the object-to-caller direction. `client.sent`
 * is the opposite one (caller to object) and is empty here by construction, so
 * asserting on it would pass for a core that delivered nothing at all.
 */
function coreOver(state: FakeDurableObjectState): {
  core: ReplyInboxObjectCore;
  pairs: { client: ReturnType<typeof linkedPair>['client']; server: FakeServerSocket }[];
} {
  const pairs: { client: ReturnType<typeof linkedPair>['client']; server: FakeServerSocket }[] = [];
  const core = new ReplyInboxObjectCore(state, {
    createPair: {
      createPair: () => {
        const pair = linkedPair();
        pairs.push(pair);
        return pair;
      },
    },
  });
  return { core, pairs };
}

/** An upgrade request, as the replica's stub fetch sends one. */
function upgrade(): Request {
  return new Request('https://reply-inbox.internal/connect', {
    headers: { Upgrade: 'websocket' },
  });
}

/** A delivery request carrying a reply body. */
function deliver(body: string): Request {
  return new Request('https://reply-inbox.internal/deliver', { method: 'POST', body });
}

describe('ReplyInboxObjectCore', () => {
  it('accepts an upgrade hibernatably and answers 101 with the client half', async () => {
    const state = new FakeDurableObjectState();
    const { core, pairs } = coreOver(state);

    const response = await core.fetch(upgrade());

    expect(response.status).toBe(101);
    // `acceptWebSocket`, not `client.accept()`: the latter pins the object in
    // memory for the life of a connection that exists to receive one reply.
    expect(state.accepted).toHaveLength(1);
    expect(state.accepted[0]).toBe(pairs[0]?.server);
  });

  it('accepts an upgrade whose header is capitalized differently', async () => {
    const state = new FakeDurableObjectState();
    const { core } = coreOver(state);
    const response = await core.fetch(
      new Request('https://reply-inbox.internal/connect', { headers: { upgrade: 'WebSocket' } }),
    );
    expect(response.status).toBe(101);
  });

  it('delivers a posted reply to a caller that connected earlier', async () => {
    const state = new FakeDurableObjectState();
    const first = coreOver(state);
    await first.core.fetch(upgrade());

    // A FRESH core over the SAME state — what the platform does when a
    // hibernated object wakes. Membership held in a field would be gone here.
    const second = coreOver(state);
    const response = await second.core.fetch(deliver('{"kind":"rpc-reply"}'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ delivered: 1 });
    expect(first.pairs[0]?.server.sent).toEqual(['{"kind":"rpc-reply"}']);
  });

  it('forwards the body verbatim, so the object cannot corrupt an envelope', async () => {
    const state = new FakeDurableObjectState();
    const { core, pairs } = coreOver(state);
    await core.fetch(upgrade());

    const body = '{"v":1,"kind":"rpc-reply","correlationId":"c","ok":true,"payload":{"a":[1,2]}}';
    await core.fetch(deliver(body));

    expect(pairs[0]?.server.sent).toEqual([body]);
  });

  it('fans one reply out to every connected socket', async () => {
    const state = new FakeDurableObjectState();
    const { core, pairs } = coreOver(state);
    await core.fetch(upgrade());
    await core.fetch(upgrade());

    const response = await core.fetch(deliver('reply'));

    expect(await response.json()).toEqual({ delivered: 2 });
    expect(pairs[0]?.server.sent).toEqual(['reply']);
    expect(pairs[1]?.server.sent).toEqual(['reply']);
  });

  it('reports zero delivered when the caller has already gone', async () => {
    const state = new FakeDurableObjectState();
    const { core } = coreOver(state);

    const response = await core.fetch(deliver('reply'));

    // Not an error: a caller that timed out has closed its socket, and
    // at-least-once delivery makes a duplicate reply ordinary.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ delivered: 0 });
  });

  it('does not let one unwritable socket cost the others their reply', async () => {
    const state = new FakeDurableObjectState();
    const { core, pairs } = coreOver(state);
    await core.fetch(upgrade());
    await core.fetch(upgrade());

    const broken = pairs[0]?.server as FakeServerSocket;
    broken.failSend = true;

    const response = await core.fetch(deliver('reply'));

    expect(await response.json()).toEqual({ delivered: 1 });
    expect(pairs[1]?.server.sent).toEqual(['reply']);
  });

  it('refuses a plain GET with 426, naming both ways in', async () => {
    const state = new FakeDurableObjectState();
    const { core } = coreOver(state);

    const response = await core.fetch(new Request('https://reply-inbox.internal/connect'));

    expect(response.status).toBe(426);
    expect(await response.text()).toContain('WebSocket upgrade');
  });

  it('refuses any other method with 405', async () => {
    const state = new FakeDurableObjectState();
    const { core } = coreOver(state);

    const response = await core.fetch(
      new Request('https://reply-inbox.internal/deliver', { method: 'PUT', body: 'x' }),
    );

    expect(response.status).toBe(405);
  });

  it('acknowledges a close without echoing an unsendable code', () => {
    const state = new FakeDurableObjectState();
    const { core } = coreOver(state);
    const socket = new FakeServerSocket();

    // 1006 is never sendable; echoing it would throw inside the application's
    // own Durable Object class.
    core.webSocketClose(socket, 1006, 'gone');

    expect(socket.closed).toBe(true);
    expect(socket.closeCode).toBe(1000);
  });

  it('echoes an ordinary close code', () => {
    const state = new FakeDurableObjectState();
    const { core } = coreOver(state);
    const socket = new FakeServerSocket();

    core.webSocketClose(socket, 1001, 'going away');

    expect(socket.closeCode).toBe(1001);
  });

  it('swallows a close on a socket the runtime already closed', () => {
    const state = new FakeDurableObjectState();
    const { core } = coreOver(state);
    const socket = new FakeServerSocket();
    socket.close = (): void => {
      throw new Error('already closed');
    };

    expect(() => core.webSocketClose(socket, 1000, '')).not.toThrow();
  });

  it('closes an errored socket with 1011', () => {
    const state = new FakeDurableObjectState();
    const { core } = coreOver(state);
    const socket = new FakeServerSocket();

    core.webSocketError(socket);

    expect(socket.closeCode).toBe(1011);
  });

  it('swallows a failure while closing an errored socket', () => {
    const state = new FakeDurableObjectState();
    const { core } = coreOver(state);
    const socket = new FakeServerSocket();
    socket.close = (): void => {
      throw new Error('already closed');
    };

    expect(() => core.webSocketError(socket)).not.toThrow();
  });

  it('defaults its pair source to the platform host', () => {
    // Constructing with no options must not throw off Workers: the default is
    // the deployment path, and it is only read when an upgrade arrives.
    expect(() => new ReplyInboxObjectCore(new FakeDurableObjectState())).not.toThrow();
  });
});
