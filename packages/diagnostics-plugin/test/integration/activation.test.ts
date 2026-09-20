/**
 * Integration tests for activation over a REAL kernel application: no
 * plugin means no socket, missing diagnostics refuses startup, a non-Deno
 * runtime refuses before any bind, and an honest composition opens a
 * working signed endpoint.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { ILocalDiagnosticsListenerFactory } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '../../../kernel/src/index.ts';
import { RuntimePlugin } from '../../../runtime/src/index.ts';
import { DiagnosticsPlugin } from '../../src/index.ts';
import { createDiagnosticsClient } from '../../src/index.ts';
import { minimalSnapshot, TEST_KEY_BYTES, TEST_SESSION_ID } from '../fixtures/helpers.ts';

/**
 * Discovers a free loopback port.
 *
 * @returns A free port
 */
function freePort(): number {
  const listener = Deno.listen({ port: 0, hostname: '127.0.0.1' });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

describe('Activation', () => {
  it('opens no listener when the plugin is absent', async () => {
    const port = freePort();
    const app = createApplication({ plugins: [RuntimePlugin()] });
    await app.start();
    const registry = app.services;
    expect(registry.has(CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER)).toBe(true);
    // The factory exists but nothing ever listened on the port.
    let connectFailed = false;
    try {
      await Deno.connect({ port, hostname: '127.0.0.1' });
    } catch {
      connectFailed = true;
    }
    expect(connectFailed).toBe(true);
    await app.stop();
  });

  it('refuses startup when kernel diagnostics were not enabled', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DiagnosticsPlugin({
          enabled: true,
          port: freePort(),
          sessionId: TEST_SESSION_ID,
          sessionKey: TEST_KEY_BYTES,
        }),
      ],
      // NO diagnostics option: M98a was not enabled.
    });
    await expect(app.start()).rejects.toThrow(
      /not created with kernel diagnostics enabled/,
    );
  });

  it('refuses listen before any bind on a non-Deno runtime', async () => {
    const factory = await (async () => {
      const app = createApplication({
        plugins: [
          RuntimePlugin({ platform: 'node' }),
        ],
      });
      await app.start();
      const factory = app.services.get<ILocalDiagnosticsListenerFactory>(
        CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER,
      );
      await app.stop();
      return factory;
    })();
    await expect(factory.listen({ port: 4919, handler: () => undefined as never }))
      .rejects.toThrow(/no supported local transport/);
  });

  it('activates on an honest composition and answers a real signed read', async () => {
    const port = freePort();
    const diagnostics = DiagnosticsPlugin({
      enabled: true,
      port,
      sessionId: TEST_SESSION_ID,
      sessionKey: TEST_KEY_BYTES,
    });
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        diagnostics,
        {
          name: 'catalog',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/items', (c) => c.response.json({ items: [] }));
          },
        },
      ],
      diagnostics: {},
    });
    await app.start();
    const client = createDiagnosticsClient({
      endpoint: `http://127.0.0.1:${port}`,
      sessionId: TEST_SESSION_ID,
      sessionKey: TEST_KEY_BYTES,
      subtle: crypto.subtle,
      fetch,
      timing: { setTimeout, clearTimeout },
    });
    const snapshot = await client.snapshot();
    expect(snapshot.state).toEqual('running');
    expect(snapshot.nodes.length).toBeGreaterThan(0);
    client.close();
    await app.stop();
  });

  it('a second listen on the same factory refuses while the first is active', async () => {
    const port = freePort();
    const diagnostics = DiagnosticsPlugin({
      enabled: true,
      port,
      sessionId: TEST_SESSION_ID,
      sessionKey: TEST_KEY_BYTES,
    });
    const app = createApplication({
      plugins: [RuntimePlugin(), diagnostics],
      diagnostics: {},
    });
    await app.start();
    const factory = app.services.get<ILocalDiagnosticsListenerFactory>(
      CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER,
    );
    await expect(
      factory.listen({ port: freePort(), handler: () => undefined as never }),
    ).rejects.toThrow(/already active/);
    await app.stop();
  });
});

// The snapshot import is used by the fake source in other suites; keep the
// reference honest here.
void minimalSnapshot;
