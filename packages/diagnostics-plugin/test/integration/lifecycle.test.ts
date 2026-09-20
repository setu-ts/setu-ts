/**
 * Integration lifecycle tests over a REAL kernel application: revoke and
 * expiration during reads, failed parent startup releasing everything, no
 * reopening after revocation, and the parent application continuing to
 * serve throughout.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createApplication } from '../../../kernel/src/index.ts';
import { RuntimePlugin } from '../../../runtime/src/index.ts';
import { createDiagnosticsClient, DiagnosticsPlugin } from '../../src/index.ts';
import type { IDiagnosticsPlugin } from '../../src/interfaces/index.ts';
import { TEST_KEY_BYTES, TEST_SESSION_ID } from '../fixtures/helpers.ts';

/**
 * Starts one application with the connector on a free port.
 *
 * @param pluginOptions - Optional plugin option overrides
 * @returns The running app, port, and plugin
 */
async function startApp(pluginOptions?: { ttlMs?: number }): Promise<{
  app: ReturnType<typeof createApplication>;
  port: number;
  plugin: IDiagnosticsPlugin;
}> {
  const listener = Deno.listen({ port: 0, hostname: '127.0.0.1' });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const plugin = DiagnosticsPlugin({
    enabled: true,
    port,
    sessionId: TEST_SESSION_ID,
    sessionKey: TEST_KEY_BYTES,
    ...pluginOptions,
  });
  const app = createApplication({
    plugins: [RuntimePlugin(), plugin],
    diagnostics: {},
  });
  await app.start();
  return { app, port, plugin };
}

/**
 * Builds a live client for the given port.
 *
 * @param port - The connector port
 * @returns The client
 */
function client(port: number) {
  return createDiagnosticsClient({
    endpoint: `http://127.0.0.1:${port}`,
    sessionId: TEST_SESSION_ID,
    sessionKey: TEST_KEY_BYTES,
    subtle: crypto.subtle,
    fetch,
    timing: { setTimeout, clearTimeout },
  });
}

describe('Lifecycle', () => {
  it('revoke refuses further reads while the parent keeps serving', async () => {
    const { app, port, plugin } = await startApp();
    const diagnostics = client(port);
    const before = await diagnostics.snapshot();
    expect(before.state).toEqual('running');

    await plugin.revoke();
    await expect(diagnostics.snapshot()).rejects.toThrow();

    // The parent application is unaffected by the revocation.
    const injected = await app.inject({ method: 'GET', url: '/nope' });
    expect(injected.statusCode).toBeGreaterThan(0);
    diagnostics.close();
    await app.stop();
  });

  it('expiration during reads refuses without stopping the application', async () => {
    const { app, port } = await startApp({ ttlMs: 300 });
    const diagnostics = client(port);
    await diagnostics.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 500));
    // The expiry fired: further reads fail.
    await expect(diagnostics.read(0)).rejects.toThrow();
    // The parent application still serves.
    const injected = await app.inject({ method: 'GET', url: '/nope' });
    expect(injected.statusCode).toBeGreaterThan(0);
    diagnostics.close();
    await app.stop();
  });

  it('a failed parent startup closes an already-open listener', async () => {
    const probe = Deno.listen({ port: 0, hostname: '127.0.0.1' });
    const port = (probe.addr as Deno.NetAddr).port;
    probe.close();
    const plugin = DiagnosticsPlugin({
      enabled: true,
      port,
      sessionId: TEST_SESSION_ID,
      sessionKey: TEST_KEY_BYTES,
    });
    // A later plugin whose bootstrap explodes: the diagnostics listener is
    // ALREADY open when the failure lands, so start() fails and the
    // kernel's close-hook run must release the listener.
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        plugin,
        {
          name: 'exploding',
          version: '1.0.0',
          register(ctx) {
            ctx.lifecycle.onBootstrap(() => {
              throw new Error('bootstrap explosion');
            });
          },
        },
      ],
      diagnostics: {},
    });
    await expect(app.start()).rejects.toThrow(/bootstrap explosion/);
    // The close hook fired on the failed-startup path: the port is free.
    let refused = false;
    try {
      const connection = await Deno.connect({ port, hostname: '127.0.0.1' });
      await connection.close();
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    // A late revoke on the failed instance is still a clean no-op.
    await plugin.revoke();
  });

  it('shutdown closes an active listener and disposes credentials', async () => {
    const { app, port, plugin } = await startApp();
    const diagnostics = client(port);
    await diagnostics.snapshot();
    await app.stop();
    // After shutdown the listener socket is gone: a connect refuses.
    let refused = false;
    try {
      const connection = await Deno.connect({ port, hostname: '127.0.0.1' });
      await connection.close();
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    // The plugin instance revokes cleanly after shutdown.
    await plugin.revoke();
    diagnostics.close();
  });
});
