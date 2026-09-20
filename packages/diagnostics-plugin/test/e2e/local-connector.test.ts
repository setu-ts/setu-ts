/**
 * End-to-end: a REAL Deno socket, the REAL kernel application, the REAL
 * runtime-owned listener, the connector, and the signed native client.
 * Covers the full pair/read/reject/revoke cycle, the two-listener
 * composition (the application's own handler stays intact), port-conflict
 * fail-closed behavior, and socket cleanup.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createApplication } from '../../../kernel/src/index.ts';
import { RuntimePlugin } from '../../../runtime/src/index.ts';
import { createDiagnosticsClient, DiagnosticsPlugin } from '../../src/index.ts';
import type { IDiagnosticsPlugin } from '../../src/interfaces/index.ts';
import { TEST_KEY_BYTES, TEST_SESSION_ID } from '../fixtures/helpers.ts';

/**
 * Starts a REAL two-listener application: the kernel's HTTP adapter on one
 * port AND the runtime-owned diagnostics listener on another.
 *
 * @returns The running app, its HTTP port, the connector port, the plugin
 */
async function startRealApplication(): Promise<{
  app: ReturnType<typeof createApplication>;
  httpPort: number;
  connectorPort: number;
  plugin: IDiagnosticsPlugin;
}> {
  const probe = Deno.listen({ port: 0, hostname: '127.0.0.1' });
  const httpPort = (probe.addr as Deno.NetAddr).port;
  probe.close();
  const connectorProbe = Deno.listen({ port: 0, hostname: '127.0.0.1' });
  const connectorPort = (connectorProbe.addr as Deno.NetAddr).port;
  connectorProbe.close();

  const plugin = DiagnosticsPlugin({
    enabled: true,
    port: connectorPort,
    sessionId: TEST_SESSION_ID,
    sessionKey: TEST_KEY_BYTES,
  });
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      plugin,
      {
        name: 'catalog',
        version: '1.0.0',
        register(ctx) {
          ctx.router.get('/items', (c) => c.response.json({ items: [{ id: 1 }] }));
        },
      },
    ],
    diagnostics: {},
  });
  await app.start({ port: httpPort, hostname: '127.0.0.1' });
  return { app, httpPort, connectorPort, plugin };
}

describe('Local connector e2e', () => {
  it('pairs, reads, observes a request, revokes, refuses reuse, and the parent keeps serving', async () => {
    const { app, httpPort, connectorPort, plugin } = await startRealApplication();
    const client = createDiagnosticsClient({
      endpoint: `http://127.0.0.1:${connectorPort}`,
      sessionId: TEST_SESSION_ID,
      sessionKey: TEST_KEY_BYTES,
      subtle: crypto.subtle,
      fetch,
      timing: { setTimeout, clearTimeout },
    });

    // 1. Pair and read the snapshot.
    const snapshot = await client.snapshot();
    expect(snapshot.state).toEqual('running');
    expect(snapshot.instanceId).not.toBe(null);

    // 2. Observe a real request through the event stream.
    const served = await fetch(`http://127.0.0.1:${httpPort}/items`);
    expect(served.status).toEqual(200);
    const batch = await client.read(0, 128);
    const requestEvent = batch.events.find((event) => event.stage === 'request');
    expect(requestEvent).toBeDefined();

    // 3. Revoke, prove reuse is refused.
    await plugin.revoke();
    await expect(client.snapshot()).rejects.toThrow();

    // 4. The application's OWN listener is untouched and still serving.
    const after = await fetch(`http://127.0.0.1:${httpPort}/items`);
    expect(after.status).toEqual(200);
    const body = (await after.json()) as { items: unknown[] };
    expect(body.items.length).toEqual(1);

    client.close();
    await app.stop();
  });

  it('a port conflict on the connector port fails startup closed', async () => {
    // Occupy a port first.
    const occupant = Deno.listen({ port: 0, hostname: '127.0.0.1' });
    const occupiedPort = (occupant.addr as Deno.NetAddr).port;
    const plugin = DiagnosticsPlugin({
      enabled: true,
      port: occupiedPort,
      sessionId: TEST_SESSION_ID,
      sessionKey: TEST_KEY_BYTES,
    });
    const app = createApplication({
      plugins: [RuntimePlugin(), plugin],
      diagnostics: {},
    });
    // No scan, no fallback: the bind conflict refuses startup.
    await expect(app.start()).rejects.toThrow();
    // The occupant is untouched.
    expect((occupant.addr as Deno.NetAddr).port).toEqual(occupiedPort);
    occupant.close();
  });

  it('cleanup after shutdown releases the connector port', async () => {
    const { app, connectorPort, plugin } = await startRealApplication();
    const client = createDiagnosticsClient({
      endpoint: `http://127.0.0.1:${connectorPort}`,
      sessionId: TEST_SESSION_ID,
      sessionKey: TEST_KEY_BYTES,
      subtle: crypto.subtle,
      fetch,
      timing: { setTimeout, clearTimeout },
    });
    await client.snapshot();
    await app.stop();
    let refused = false;
    try {
      const connection = await Deno.connect({
        port: connectorPort,
        hostname: '127.0.0.1',
      });
      await connection.close();
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    client.close();
    await plugin.revoke();
  });
});
