/**
 * The X3-8 regression guard, driven at the surface the register measured: a
 * real kernel application serving a presence endpoint whose room name comes
 * from the URL.
 *
 * The register's own numbers were `roomCount` 3 -> 53 across 50 read-only
 * presence requests, with nothing to reclaim them until an unrelated socket
 * disconnected. A unit test on the registry proves `peek` does not allocate;
 * this proves an application built the documented way does not either, through
 * `app.fetch` and the real HTTP path.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { IWebSocketConnection, IWebSocketService } from '@setu-ts/common';
import { WebSocketPlugin } from '../../src/index.ts';
import { WebSocketConnection } from '../../src/connection/websocket-connection.ts';
import { createFakeTransport } from '../fixtures/fake-runtime.ts';

/** A live connection over the package's own fake transport. */
function openConnection(id: string): IWebSocketConnection {
  return new WebSocketConnection(id, '/ws', createFakeTransport(), 0);
}

describe('presence over peek (M74 / X3-8)', () => {
  it('reports presence for caller-supplied names without growing the registry', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin()] });
    await app.start();
    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);

    // The endpoint the register's client polled, written the way the README
    // now documents it.
    app.router.get('/presence/:board', (ctx) => {
      const board = ctx.params.board ?? '';
      return ctx.response.json({ present: ws.peek(`board:${board}`)?.size ?? 0 });
    });

    const before = ws.roomCount;

    for (let i = 0; i < 50; i++) {
      const response = await app.fetch(new Request(`http://localhost/presence/acme-${i}`));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ present: 0 });
    }

    expect(ws.roomCount).toBe(before);
    await app.stop();
  });

  it('reports the real size for a room that exists', async () => {
    // Without this the test above would pass against a peek that always
    // returned undefined.
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin()] });
    await app.start();
    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);

    app.router.get('/presence/:board', (ctx) => {
      const board = ctx.params.board ?? '';
      return ctx.response.json({ present: ws.peek(`board:${board}`)?.size ?? 0 });
    });

    // A room with a real member, as an onOpen handler would leave it. Without
    // the member the endpoint answers 0 whether `peek` resolves the room or
    // returns `undefined`, so the route would never be shown reporting a live
    // count through the `?? 0` fallback.
    const conn = openConnection('member-1');
    ws.room('board:acme').add(conn);

    const response = await app.fetch(new Request('http://localhost/presence/acme'));

    expect(await response.json()).toEqual({ present: 1 });
    expect(ws.peek('board:acme')?.size).toBe(1);
    await app.stop();
  });

  it('the same endpoint written with room() DOES grow the registry', async () => {
    // The defect, reproduced through the same entry point — so the guard above
    // is known to discriminate rather than merely to pass.
    const app = createApplication({ plugins: [RuntimePlugin(), WebSocketPlugin()] });
    await app.start();
    const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);

    app.router.get('/leaky/:board', (ctx) => {
      const board = ctx.params.board ?? '';
      return ctx.response.json({ present: ws.room(`board:${board}`).size });
    });

    for (let i = 0; i < 50; i++) {
      await app.fetch(new Request(`http://localhost/leaky/acme-${i}`));
    }

    expect(ws.roomCount).toBe(50);
    await app.stop();
  });
});
