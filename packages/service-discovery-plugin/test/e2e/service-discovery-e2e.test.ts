/**
 * End-to-end tests over real loopback sockets and the real global `fetch`.
 *
 * This is where the DEFAULT `createDefaultDiscoveryHttp()` seam is exercised
 * for real — every other test drives an injected fake, so without this nothing
 * would ever prove the shipped transport works.
 *
 * Ports are bound with `0` and the assigned port read back, rather than
 * hard-coded, because CI runners occasionally refuse a chosen ephemeral port.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { IServiceDiscovery } from '@setu-ts/common';

import { ServiceDiscoveryPlugin } from '../../src/index.ts';

/** One Consul health entry, as the agent would return it. */
function consulEntry(host: string, port: number, id: string): unknown {
  return {
    Node: { Address: host },
    Service: { ID: id, Service: 'billing', Address: host, Port: port },
  };
}

/** Serves a Consul-shaped health endpoint on an ephemeral loopback port. */
function serveConsul(entries: unknown[]): { port: number; close: () => Promise<void> } {
  const server = Deno.serve(
    { port: 0, hostname: '127.0.0.1', onListen: () => {} },
    (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/health/service/billing') {
        // The client must always ask for passing instances only.
        if (url.searchParams.get('passing') !== 'true') {
          return new Response('missing passing=true', { status: 400 });
        }
        return new Response(JSON.stringify(entries), {
          headers: { 'Content-Type': 'application/json', 'X-Consul-Index': '7' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  );
  return { port: server.addr.port, close: () => server.shutdown() };
}

/** Serves a trivial backend that reports which instance answered. */
function serveBackend(name: string): { port: number; close: () => Promise<void> } {
  const server = Deno.serve(
    { port: 0, hostname: '127.0.0.1', onListen: () => {} },
    () => new Response(name),
  );
  return { port: server.addr.port, close: () => server.shutdown() };
}

describe('service discovery e2e — real fetch against a Consul-shaped agent', () => {
  it('resolves a real advertised address through the default HTTP seam', async () => {
    const backend = serveBackend('billing-1');
    const consul = serveConsul([consulEntry('127.0.0.1', backend.port, 'billing-1')]);

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        // No `http` option: this drives createDefaultDiscoveryHttp() over the
        // real global fetch.
        ServiceDiscoveryPlugin({
          provider: 'consul',
          address: `http://127.0.0.1:${consul.port}`,
        }),
      ],
    });
    await app.start();
    const discovery = app.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);

    const url = await discovery.resolveUrl('billing', '/invoices');
    expect(url).toBe(`http://127.0.0.1:${backend.port}/invoices`);

    // Read the advertised address back through a real request, so the URL is
    // proven reachable rather than merely well-formed.
    const response = await fetch(url!);
    expect(await response.text()).toBe('billing-1');

    await app.stop();
    await consul.close();
    await backend.close();
  });

  it('watches a real agent and receives the instance list', async () => {
    const backend = serveBackend('billing-1');
    const consul = serveConsul([consulEntry('127.0.0.1', backend.port, 'billing-1')]);

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        ServiceDiscoveryPlugin({
          provider: 'consul',
          address: `http://127.0.0.1:${consul.port}`,
        }),
      ],
    });
    await app.start();
    const discovery = app.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);

    const seen = await new Promise<readonly { id: string }[]>((resolve) => {
      void discovery.watch('billing', (instances) => resolve(instances));
    });
    expect(seen.map((i) => i.id)).toEqual(['billing-1']);

    await app.stop();
    await consul.close();
    await backend.close();
  });
});

describe('service discovery e2e — the ejection loop over real sockets', () => {
  it('pick, fail, report, pick again lands on a different instance', async () => {
    const good = serveBackend('good');
    const bad = serveBackend('bad');
    // `bad` is closed below, so calling it really fails rather than being
    // faked into failing.
    await bad.close();

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        ServiceDiscoveryPlugin({
          provider: 'static',
          services: {
            billing: [
              { id: 'bad', host: '127.0.0.1', port: bad.port },
              { id: 'good', host: '127.0.0.1', port: good.port },
            ],
          },
          strategy: 'round-robin',
          ejection: { failureThreshold: 1 },
        }),
      ],
    });
    await app.start();
    const discovery = app.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);

    const first = await discovery.pick('billing');
    expect(first?.id).toBe('bad');

    let failed = false;
    try {
      await fetch(`http://127.0.0.1:${first!.port}/`);
    } catch {
      failed = true;
      discovery.report(first!, 'failure');
    }
    expect(failed).toBe(true);

    // Every subsequent pick must avoid the ejected instance, not merely the
    // next one in the rotation.
    for (let i = 0; i < 5; i++) {
      const next = await discovery.pick('billing');
      expect(next?.id).toBe('good');
      const response = await fetch(`http://127.0.0.1:${next!.port}/`);
      expect(await response.text()).toBe('good');
      discovery.report(next!, 'success');
    }

    await app.stop();
    await good.close();
  });
});
