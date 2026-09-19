import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin } from '@setu-ts/common';

import { createApplication } from '../../src/application/application.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { runtimePlugin } from '../fixtures/runtime-plugin.ts';
import type { DiagnosticsCollector } from '../../src/diagnostics/collector.ts';

function throwingClockRuntimePlugin(): IPlugin {
  const fake = createFakeRuntime();
  const runtime = fake.runtime;
  const broken = new Proxy(runtime, {
    get(target, prop, receiver) {
      if (prop === 'hrtime') {
        return () => {
          throw new Error('clock exploded');
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx) {
      ctx.services.register(CAPABILITIES.RUNTIME, broken);
    },
  };
}

describe('diagnostics fault isolation', () => {
  it('a throwing injected clock behaves identically to diagnostics-off and fabricates nothing', async () => {
    const composed = (diagnostics: Record<string, never> | undefined) => {
      const plugins: IPlugin[] = [
        throwingClockRuntimePlugin(),
        {
          name: 'api',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/ok', (ctx) => ctx.response.json({ fine: true }));
          },
        },
      ];
      const options = {
        plugins,
        ...(diagnostics !== undefined ? { diagnostics } : {}),
      };
      return createApplication(options);
    };
    // The kernel itself reads `hrtime()` per request, so a throwing clock is
    // an application fault on the un-instrumented path too. The diagnostics
    // property is that instrumentation makes it NO WORSE: identical answers,
    // and no fabricated timings anywhere in the recorded events.
    const disabled = composed(undefined);
    const enabled = composed({});
    await disabled.start();
    await enabled.start();
    const off = await disabled.inject({ method: 'GET', url: '/ok' });
    const on = await enabled.inject({ method: 'GET', url: '/ok' });
    expect(on.statusCode).toBe(off.statusCode);
    expect(on.body).toBe(off.body);
    const events = enabled.diagnostics!.read(0).events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.atMs === null && event.durationMs === null)).toBe(true);
    // The throwing clock is an application fault on the shutdown drain too:
    // both variants fail identically.
    await expect(disabled.stop()).rejects.toThrow('clock exploded');
    await expect(enabled.stop()).rejects.toThrow('clock exploded');
  });

  it('a direct event-capture failure disables capture without touching responses', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'api',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/sync', (ctx) => ctx.response.json({ n: 1 }));
            ctx.router.get('/async', (ctx) => Promise.resolve(ctx.response.json({ n: 2 })));
          },
        },
      ],
      diagnostics: {},
    });
    await app.start();
    const collector = app.diagnostics as DiagnosticsCollector;
    // Records already captured stay readable: disabling capture is not a
    // retroactive erasure.
    const before = app.diagnostics!.read(0);
    // Drive the collector's own boundary with a throwing callback.
    collector.safeObserve('event', () => {
      throw new Error('event capture exploded');
    });
    const syncResponse = await app.inject({ method: 'GET', url: '/sync' });
    const asyncResponse = await app.inject({ method: 'GET', url: '/async' });
    expect(syncResponse.statusCode).toBe(200);
    expect(asyncResponse.statusCode).toBe(200);
    // Capture is disabled: nothing was appended after the failure, and the
    // counter is a plain number carrying no value or message.
    const snapshot = app.diagnostics!.snapshot();
    expect(snapshot.droppedEvents).toBe(1);
    const after = app.diagnostics!.read(0);
    expect(after.events.length).toBe(before.events.length);
    expect(after.events.map((event) => event.sequence)).toEqual(
      before.events.map((event) => event.sequence),
    );
    await app.stop();
  });

  it('a direct topology-capture failure truncates topology without failing startup', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'api',
          version: '1.0.0',
          register(ctx) {
            ctx.services.register('thing', {});
          },
        },
      ],
      diagnostics: { labels: { capabilities: ['thing'] } },
    });
    // Drive the topology boundary BEFORE startup so the failure lands mid-capture.
    const collector = app.diagnostics as DiagnosticsCollector;
    collector.safeObserve('topology', () => {
      throw new Error('topology capture exploded');
    });
    await app.start();
    const snapshot = app.diagnostics!.snapshot();
    expect(snapshot.truncated).toBe(true);
    // The registry capture that follows still projected the capability.
    expect(snapshot.nodes.some((node) => node.label === 'thing')).toBe(true);
    await app.stop();
  });

  it('a throwing close hook still surfaces unchanged while diagnostics tear down', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'closer',
          version: '1.0.0',
          register(ctx) {
            ctx.lifecycle.onClose(() => {
              throw new Error('close hook failure');
            });
          },
        },
      ],
      diagnostics: {},
    });
    await app.start();
    await expect(app.stop()).rejects.toThrow('close hook failure');
    // The failure state is value-free: no error text in any readable surface.
    const everything = JSON.stringify(app.diagnostics!.snapshot()) +
      JSON.stringify(app.diagnostics!.read(0));
    expect(everything).not.toContain('close hook failure');
    expect(everything).toContain('"shutdown-failed"');
    // A second stop() returns the SAME cached rejection — idempotent, but
    // never silent.
    await expect(app.stop()).rejects.toThrow('close hook failure');
  });
});
