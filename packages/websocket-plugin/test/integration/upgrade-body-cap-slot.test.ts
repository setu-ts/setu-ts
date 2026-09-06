/**
 * A body-carrying upgrade REFUSED BY THE BODY CAP must release the connection
 * slot the router reserved at accept time (M90a review finding).
 *
 * `websocket-service.ts` states that "a refused or malformed upgrade can never
 * leak a slot and starve `maxConnections`", because the pending slot claimed at
 * accept time is settled by whichever of `onOpen`/`onClose` arrives first. That
 * held while the kernel's RFC 6455 body guard could only RETURN — it reads
 * `ctx.request.bytes()` after the router has accepted, and then calls
 * `sink.onClose({ code: 1006 })` before answering `400`.
 *
 * `RuntimePlugin({ maxBodyBytes })` (M90a) makes that read able to REJECT.
 * Without a `catch` that settles the slot first, the rejection escapes with
 * `onClose` never called, and since detection is header-only — a POST carrying
 * `Upgrade: websocket` is an upgrade — an unauthenticated client can exhaust
 * `maxConnections` with that many malformed requests and every later conformant
 * upgrade is answered `503` for the life of the process.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES, type IPlugin, type IPluginContext } from '@setu-ts/common';
import type { IWebSocketService } from '@setu-ts/common';
import { WebSocketPlugin } from '../../src/index.ts';

const MAX_CONNECTIONS = 2;

/** Registers one WebSocket route. */
function RoutePlugin(): IPlugin {
  return {
    name: 'ws-route',
    version: '0.0.0',
    dependencies: ['websocket'],
    register(ctx: IPluginContext): void {
      ctx.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET)
        .route('/ws', { onMessage: () => {} });
    },
  };
}

/**
 * A POST carrying upgrade headers and a body. `isWebSocketUpgradeRequest`
 * inspects headers only — there is no method check — so this IS detected as an
 * upgrade, which is how the kernel's body guard becomes reachable at all. A GET
 * cannot be used: `new Request` forbids a body on one.
 */
function upgradeWithBody(bytes: number): Request {
  return new Request('http://localhost/ws', {
    method: 'POST',
    headers: { upgrade: 'websocket', connection: 'Upgrade' },
    body: 'X'.repeat(bytes),
  });
}

/** A conformant, bodyless upgrade. */
function conformantUpgrade(): Request {
  return new Request('http://localhost/ws', {
    headers: { upgrade: 'websocket', connection: 'Upgrade' },
  });
}

function boot(maxBodyBytes?: number) {
  return createApplication({
    plugins: [
      RuntimePlugin(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
      WebSocketPlugin({ maxConnections: MAX_CONNECTIONS }),
      RoutePlugin(),
    ],
  });
}

/** Drains a response body so no test leaves a stream open. */
async function drain(response: Response): Promise<number> {
  await response.body?.cancel();
  return response.status;
}

describe('upgrade refused by the body cap releases its connection slot', () => {
  it('does not exhaust maxConnections after that many capped refusals', async () => {
    const app = boot(8);
    await app.start();
    try {
      for (let i = 0; i < MAX_CONNECTIONS; i++) {
        // Refused because the body (64 bytes) exceeds the cap (8). Without the
        // fix each of these leaks a pending slot.
        await drain(await app.fetch(upgradeWithBody(64)));
      }

      // The observable: 503 is `maxConnections` exhaustion, and it is what this
      // assertion exists to catch. 400 is the ordinary body refusal, i.e. the
      // slots were released and the router still had capacity to accept.
      const after = await drain(await app.fetch(conformantUpgrade()));
      expect(after).not.toBe(503);
      expect(after).toBe(400);
    } finally {
      await app.stop();
    }
  });

  it('answers the capped refusal 413 through the configured error format', async () => {
    // The slot release must not swallow the refusal: the rejection is rethrown
    // so its `413` status hint still reaches `errorHandler`. Asserted without
    // one here — the kernel's opaque 500 — and with one in
    // `packages/runtime/test/integration/max-body-bytes.test.ts`.
    const app = boot(8);
    await app.start();
    try {
      const response = await app.fetch(upgradeWithBody(64));
      expect(response.status).toBe(500);
      await response.body?.cancel();
    } finally {
      await app.stop();
    }
  });

  it('CONTROL: with no cap the same requests are refused 400 and release slots', async () => {
    // Proves the assertion above discriminates rather than passing for an
    // unrelated reason: the pre-M90a path, where the guard can only return.
    const app = boot();
    await app.start();
    try {
      for (let i = 0; i < MAX_CONNECTIONS; i++) {
        expect(await drain(await app.fetch(upgradeWithBody(64)))).toBe(400);
      }
      expect(await drain(await app.fetch(conformantUpgrade()))).toBe(400);
    } finally {
      await app.stop();
    }
  });
});
