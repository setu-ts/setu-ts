import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createApplication } from '../../src/application/application.ts';
import type { KernelDiagnosticsOptions } from '../../src/application/application.ts';
import { runtimePlugin } from '../fixtures/runtime-plugin.ts';
import { DiagnosticsCollector } from '../../src/diagnostics/collector.ts';
import { compileLabelAllowlists } from '../../src/diagnostics/projection.ts';

function composedApp(diagnostics: KernelDiagnosticsOptions | undefined) {
  return createApplication({
    plugins: [
      runtimePlugin(),
      {
        name: 'app',
        version: '1.0.0',
        register(ctx) {
          ctx.middleware.add(async (_ctx, next) => {
            await next();
          }, { name: 'pass', priority: 100 });
          ctx.router.get('/sync', (ctx) => ctx.response.json({ route: 'sync' }));
          ctx.router.get('/async', (ctx) => Promise.resolve(ctx.response.json({ route: 'async' })));
          ctx.router.get('/short', {
            handler: (ctx) => ctx.response.json({ route: 'never' }),
            middleware: [
              // Responds WITHOUT next(): the handler must never run.
              (ctx) => {
                ctx.response.json({ route: 'short' });
              },
            ],
          });
        },
      },
    ],
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  });
}

describe('diagnostics equivalence', () => {
  it('identical responses with capture absent versus enabled', async () => {
    const routes: { method: string; url: string }[] = [
      { method: 'GET', url: '/sync' },
      { method: 'GET', url: '/async' },
      { method: 'GET', url: '/short' },
      { method: 'GET', url: '/missing' },
    ];
    const disabled = composedApp(undefined);
    const enabled = composedApp({});
    await disabled.start();
    await enabled.start();
    for (const route of routes) {
      const off = await disabled.inject(route);
      const on = await enabled.inject(route);
      expect(on.statusCode).toBe(off.statusCode);
      expect(on.body).toBe(off.body);
    }
    // Captured BEFORE stop: shutdown clears the ring.
    const events = enabled.diagnostics!.read(0, 128).events;
    const requests = events.filter((event) => event.stage === 'request');
    expect(requests.map((request) => request.statusCode)).toEqual([200, 200, 200, 404]);
    await disabled.stop();
    await enabled.stop();
  });

  it('reads are pure: a consumer reading then discarding changes nothing', async () => {
    const app = composedApp({});
    await app.start();
    const first = app.diagnostics!.read(0, 128);
    await app.inject({ method: 'GET', url: '/sync' });
    // The earlier read did not consume anything: a re-read sees the new event.
    const second = app.diagnostics!.read(0, 128);
    // One request later: strictly more records, nothing consumed.
    expect(second.events.length).toBeGreaterThan(first.events.length);
    const response = await app.inject({ method: 'GET', url: '/sync' });
    expect(response.statusCode).toBe(200);
    await app.stop();
  });

  it('a slow, stopped reader cannot backpressure requests', async () => {
    const app = composedApp({});
    await app.start();
    // One reader stops at sequence 0 forever; requests keep flowing.
    const stalled = app.diagnostics!.read(0, 1);
    expect(stalled.events.length).toBe(1);
    for (let i = 0; i < 20; i++) {
      const response = await app.inject({ method: 'GET', url: '/sync' });
      expect(response.statusCode).toBe(200);
    }
    const caught = app.diagnostics!.read(0, 128);
    expect(caught.events.length).toBeGreaterThan(1);
    await app.stop();
  });

  it('100,000 synthetic operations stay bounded and the app still serves', async () => {
    const app = composedApp({});
    await app.start();
    // Drive the collector directly: 100k operations through one instance.
    const collector = new DiagnosticsCollector(compileLabelAllowlists({}));
    collector.initializeRuntime({ uuid: () => 'u', hrtime: () => 0 }, undefined);
    for (let i = 0; i < 100_000; i++) {
      collector.observeLifecycleEvent(collector.beginOperation(), 'init', null, 'ok');
    }
    const batch = collector.read(0, 128);
    expect(batch.events.length).toBe(128);
    expect(batch.lost).toBe(100_000 - 1_024);
    expect(batch.closed).toBe(false);
    expect(collector.snapshot().droppedEvents).toBe(0);
    // The real application was untouched by the synthetic overload.
    const response = await app.inject({ method: 'GET', url: '/sync' });
    expect(response.statusCode).toBe(200);
    await app.stop();
  });
});
