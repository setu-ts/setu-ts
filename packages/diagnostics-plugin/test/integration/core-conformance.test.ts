/**
 * Producer conformance for the strict core validators (F02): the REAL kernel's
 * honest output must never be refused. A validator that is stricter than the
 * producer turns every diagnostics read into a connection failure, which no
 * hostile-input test can see — so these drive a composition that exercises
 * every node kind with its labels, both middleware scopes, error and
 * short-circuit outcomes, the topology cap, and ring eviction, then run the
 * kernel's own reader output through the validators, in-process and through
 * the real connector and signed client.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IPlugin } from '@setu-ts/common';

import { createApplication } from '../../../kernel/src/index.ts';
import { RuntimePlugin } from '../../../runtime/src/index.ts';
import { createDiagnosticsClient, DiagnosticsPlugin } from '../../src/index.ts';
import { isBatchProjection, isSnapshotProjection } from '../../src/protocol/protocol.ts';
import { TEST_KEY_BYTES, TEST_SESSION_ID } from '../fixtures/helpers.ts';

/** The labelled composition every node family is drawn from. */
const LABELS = {
  plugins: ['catalog'],
  capabilities: ['catalog-items'],
  routes: ['/items', '/items/:id', '/boom', '/short'],
  middleware: ['audit'],
};

/**
 * A plugin exercising every node kind: a labelled capability, labelled and
 * unlabelled routes across methods, route middleware (one short-circuiting),
 * a labelled global middleware with a fractional negative priority, and a
 * throwing handler.
 *
 * @returns The plugin
 */
function catalogPlugin(): IPlugin {
  return {
    name: 'catalog',
    version: '1.2.3-rc.1',
    provides: ['catalog-items'],
    register(ctx) {
      ctx.services.register('catalog-items', { items: [] });
      ctx.middleware.add(async (_ctx, next) => {
        await next();
      }, { name: 'audit', priority: -2.5 });
      ctx.router.get('/items', (c) => c.response.json({ items: [] }));
      ctx.router.post('/items/:id', {
        handler: (c) => c.response.status(201).json({ ok: true }),
        middleware: [async (_c, next) => {
          await next();
        }],
      });
      ctx.router.get('/boom', () => {
        throw new Error('boom');
      });
      ctx.router.get('/short', {
        handler: (c) => c.response.json({ never: true }),
        middleware: [(c) => {
          c.response.status(403).json({ refused: true });
        }],
      });
      ctx.router.delete('/unlabelled', (c) => c.response.status(204).text(''));
    },
  };
}

/**
 * Many small plugins, each declaring a capability, to push the topology past
 * the fixed 1,024-node cap.
 *
 * @param count - How many plugins
 * @returns The plugins
 */
function fillerPlugins(count: number): IPlugin[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `filler-${i}`,
    version: 'not-a-semver',
    provides: [`filler-cap-${i}`],
    register(ctx) {
      ctx.services.register(`filler-cap-${i}`, {});
    },
  }));
}

describe('Strict core validators — the real kernel output conforms (F02)', () => {
  it('accepts every in-process snapshot and batch of a rich composition, including paging', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), catalogPlugin()],
      diagnostics: { labels: LABELS },
    });
    await app.start();
    for (
      const [method, url] of [
        ['GET', '/items'],
        ['POST', '/items/7'],
        ['GET', '/boom'],
        ['GET', '/short'],
        ['DELETE', '/unlabelled'],
        ['GET', '/missing'],
      ] as const
    ) {
      await app.inject({ method, url });
    }
    const snapshot = app.diagnostics!.snapshot();
    expect(isSnapshotProjection(snapshot)).toBe(true);
    // The composition really did populate what the validator constrains.
    const kinds = new Set(snapshot.nodes.map((node) => node.kind));
    expect([...kinds].sort()).toEqual(['capability', 'middleware', 'plugin', 'route']);
    expect(snapshot.nodes.some((node) => node.label === 'audit' && node.priority === -2.5))
      .toBe(true);
    expect(snapshot.nodes.some((node) => node.version === '1.2.3-rc.1')).toBe(true);

    // Page through the whole ring in small windows: every window conforms,
    // and the windows are contiguous.
    let after = 0;
    const statuses: number[] = [];
    for (;;) {
      const batch = app.diagnostics!.read(after, 5);
      expect(isBatchProjection(batch)).toBe(true);
      if (batch.events.length === 0) {
        expect(batch.next).toBe(after);
        break;
      }
      expect(batch.events[0].sequence).toBe(after + 1);
      for (const event of batch.events) {
        if (event.stage === 'request' && event.statusCode !== undefined) {
          statuses.push(event.statusCode);
        }
      }
      after = batch.next;
    }
    expect(statuses).toEqual([200, 201, 500, 403, 204, 404]);
    await app.stop();
  });

  it('accepts a topology-capped snapshot and an evicted ring window', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), ...fillerPlugins(600)],
      diagnostics: {},
    });
    await app.start();
    const snapshot = app.diagnostics!.snapshot();
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.nodes.length).toBe(1024);
    expect(isSnapshotProjection(snapshot)).toBe(true);

    // Enough requests to evict: a reader parked at 0 now receives the oldest
    // RETAINED window with the skipped sequences reported as `lost`.
    for (let i = 0; i < 1_100; i++) {
      await app.inject({ method: 'GET', url: '/missing' });
    }
    const window = app.diagnostics!.read(0, 128);
    expect(window.lost).toBeGreaterThan(0);
    expect(window.events[0].sequence).toBe(window.lost + 1);
    expect(isBatchProjection(window)).toBe(true);
    await app.stop();
  });

  it('serves the rich composition through the real connector and signed client, frozen', async () => {
    const probe = Deno.listen({ port: 0, hostname: '127.0.0.1' });
    const port = (probe.addr as Deno.NetAddr).port;
    probe.close();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DiagnosticsPlugin({
          enabled: true,
          port,
          sessionId: TEST_SESSION_ID,
          sessionKey: TEST_KEY_BYTES,
        }),
        catalogPlugin(),
      ],
      diagnostics: { labels: LABELS },
    });
    await app.start();
    await app.inject({ method: 'GET', url: '/boom' });
    const client = createDiagnosticsClient({
      endpoint: `http://127.0.0.1:${port}`,
      sessionId: TEST_SESSION_ID,
      sessionKey: TEST_KEY_BYTES,
      subtle: crypto.subtle,
      fetch,
      timing: { setTimeout, clearTimeout },
    });
    try {
      const snapshot = await client.snapshot();
      expect(snapshot.nodes.some((node) => node.label === '/items/:id')).toBe(true);
      expect(Object.isFrozen(snapshot.nodes[0])).toBe(true);

      const first = await client.read(0, 4);
      expect(first.events.length).toBe(4);
      expect(Object.isFrozen(first.events[0])).toBe(true);
      const second = await client.read(first.next, 128);
      expect(second.events[0].sequence).toBe(first.next + 1);
      expect(second.events.some((event) => event.outcome === 'error')).toBe(true);
    } finally {
      client.close();
      await app.stop();
    }
  });

  it('accepts non-finite priorities and out-of-range statuses the kernel records verbatim (audit F-A)', async () => {
    const probe = Deno.listen({ port: 0, hostname: '127.0.0.1' });
    const port = (probe.addr as Deno.NetAddr).port;
    probe.close();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DiagnosticsPlugin({
          enabled: true,
          port,
          sessionId: TEST_SESSION_ID,
          sessionKey: TEST_KEY_BYTES,
        }),
        {
          name: 'odd',
          version: '1.0.0',
          register(ctx) {
            // `Number(env.X)` for an unset variable yields exactly this.
            ctx.middleware.add(async (_c, next) => {
              await next();
            }, { name: 'nan', priority: Number.NaN });
            ctx.middleware.add(async (_c, next) => {
              await next();
            }, { name: 'inf', priority: Number.POSITIVE_INFINITY });
            ctx.router.get(
              '/odd/:code',
              (c) => c.response.status(Number(c.params.code)).json({ odd: true }),
            );
          },
        },
      ],
      diagnostics: {},
    });
    await app.start();
    for (const code of ['1000', '99', '200.5']) {
      await app.inject({ method: 'GET', url: `/odd/${code}` });
    }
    const client = createDiagnosticsClient({
      endpoint: `http://127.0.0.1:${port}`,
      sessionId: TEST_SESSION_ID,
      sessionKey: TEST_KEY_BYTES,
      subtle: crypto.subtle,
      fetch,
      timing: { setTimeout, clearTimeout },
    });
    try {
      const snapshot = await client.snapshot();
      expect(
        snapshot.nodes.filter((node) => node.kind === 'middleware' && node.priority === null)
          .length,
      ).toBe(2);
      const batch = await client.read(0, 128);
      const statuses = batch.events.filter((event) => event.stage === 'request')
        .map((event) => event.statusCode);
      expect(statuses).toEqual([1000, 99, 200.5]);
    } finally {
      client.close();
      await app.stop();
    }
  });
});
