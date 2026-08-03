/**
 * The Durable Object fan-out hub.
 *
 * The load-bearing test here is the hibernation one. `acceptWebSocket` lets the
 * runtime evict the object and RE-RUN its constructor while sockets stay open,
 * so any membership held in a field would silently empty itself in production
 * while every ordinary test kept passing. The test therefore builds a FRESH
 * core over the same state — the only shape that fails if a field creeps back.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  RealtimeBackplaneObjectCore,
} from '../../../src/durable-objects/realtime-backplane-object.ts';
import { FakeDurableObjectState, linkedPair } from '../../do-fakes.ts';

/** Builds a core whose pairs the test can reach. */
function build(): {
  state: FakeDurableObjectState;
  core: RealtimeBackplaneObjectCore;
  pairs: ReturnType<typeof linkedPair>[];
} {
  const state = new FakeDurableObjectState();
  const pairs: ReturnType<typeof linkedPair>[] = [];
  const core = new RealtimeBackplaneObjectCore(state, {
    createPair: {
      createPair: () => {
        const pair = linkedPair();
        pairs.push(pair);
        return pair;
      },
    },
  });
  return { state, core, pairs };
}

const UPGRADE = { headers: { Upgrade: 'websocket' } };

describe('RealtimeBackplaneObjectCore.fetch', () => {
  it('answers a 101 and accepts the server half for hibernation', async () => {
    const { state, core, pairs } = build();

    const response = await core.fetch(new Request('https://do/connect', UPGRADE));

    expect(response.status).toBe(101);
    expect(state.accepted).toEqual([pairs[0]?.server]);
    // `acceptWebSocket`, NOT `ws.accept()` — the latter pins the object in
    // memory for the life of every connection.
    expect(pairs[0]?.client.accepted).toBe(false);
  });

  it('refuses a non-upgrade request with 426 rather than creating a pair', async () => {
    const { state, core, pairs } = build();

    const response = await core.fetch(new Request('https://do/connect'));

    expect(response.status).toBe(426);
    expect(await response.text()).toContain('realtime backplane');
    expect(pairs).toHaveLength(0);
    expect(state.accepted).toHaveLength(0);
  });

  it('accepts a case-insensitive upgrade header, as the protocol allows', async () => {
    const { core } = build();
    const response = await core.fetch(
      new Request('https://do/connect', { headers: { Upgrade: 'WebSocket' } }),
    );
    expect(response.status).toBe(101);
  });
});

describe('RealtimeBackplaneObjectCore.webSocketMessage', () => {
  it('fans a message out to every replica except the sender', async () => {
    const { core, pairs } = build();
    for (let i = 0; i < 3; i++) {
      await core.fetch(new Request('https://do/connect', UPGRADE));
    }
    const [a, b, c] = pairs;

    core.webSocketMessage(a!.server, 'frame-1');

    expect(a?.server.sent).toEqual([]);
    expect(b?.server.sent).toEqual(['frame-1']);
    expect(c?.server.sent).toEqual(['frame-1']);
  });

  it('re-broadcasts the payload verbatim, never parsing it', async () => {
    const { core, pairs } = build();
    await core.fetch(new Request('https://do/connect', UPGRADE));
    await core.fetch(new Request('https://do/connect', UPGRADE));

    // Deliberately not a frame, and not even valid JSON. The object must not
    // care: it is a pipe, and staying schema-ignorant is what lets `common`
    // widen `RealtimeFrame` without redeploying the application's DO class.
    core.webSocketMessage(pairs[0]!.server, '{not json at all');

    expect(pairs[1]?.server.sent).toEqual(['{not json at all']);
  });

  it('survives hibernation: a fresh core over the same state still fans out', async () => {
    const { state, core, pairs } = build();
    await core.fetch(new Request('https://do/connect', UPGRADE));
    await core.fetch(new Request('https://do/connect', UPGRADE));

    // Exactly what the platform does when a hibernated object wakes: the
    // constructor re-runs, and only `state` survives.
    const woken = new RealtimeBackplaneObjectCore(state);

    woken.webSocketMessage(pairs[0]!.server, 'after-hibernation');

    expect(pairs[1]?.server.sent).toEqual(['after-hibernation']);
  });

  it('one unwritable peer does not cost the others their message', async () => {
    const { core, pairs } = build();
    for (let i = 0; i < 3; i++) {
      await core.fetch(new Request('https://do/connect', UPGRADE));
    }
    pairs[1]!.server.failSend = true;

    core.webSocketMessage(pairs[0]!.server, 'frame-1');

    expect(pairs[2]?.server.sent).toEqual(['frame-1']);
  });

  it('delivers nothing when the sender is the only connected replica', async () => {
    const { core, pairs } = build();
    await core.fetch(new Request('https://do/connect', UPGRADE));

    core.webSocketMessage(pairs[0]!.server, 'lonely');

    expect(pairs[0]?.server.sent).toEqual([]);
  });
});

describe('RealtimeBackplaneObjectCore close and error handlers', () => {
  it('acknowledges a close with the peer code', async () => {
    const { core, pairs } = build();
    await core.fetch(new Request('https://do/connect', UPGRADE));

    core.webSocketClose(pairs[0]!.server, 1001, 'going away');

    expect(pairs[0]?.server.closed).toBe(true);
    expect(pairs[0]?.server.closeCode).toBe(1001);
  });

  it('substitutes 1000 for the never-sendable 1006, which would throw', async () => {
    const { core, pairs } = build();
    await core.fetch(new Request('https://do/connect', UPGRADE));

    core.webSocketClose(pairs[0]!.server, 1006, 'abnormal');

    expect(pairs[0]?.server.closeCode).toBe(1000);
  });

  it('tolerates a socket the runtime already closed', () => {
    const { core } = build();
    const throwing = {
      send: () => {},
      close: () => {
        throw new Error('already closed');
      },
    };

    expect(() => core.webSocketClose(throwing, 1000, '')).not.toThrow();
    expect(() => core.webSocketError(throwing)).not.toThrow();
  });

  it('closes an errored socket with 1011', async () => {
    const { core, pairs } = build();
    await core.fetch(new Request('https://do/connect', UPGRADE));

    core.webSocketError(pairs[0]!.server);

    expect(pairs[0]?.server.closeCode).toBe(1011);
  });
});
