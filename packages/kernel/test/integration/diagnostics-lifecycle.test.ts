import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createApplication } from '../../src/application/application.ts';
import { runtimePlugin } from '../fixtures/runtime-plugin.ts';

describe('diagnostics lifecycle integration', () => {
  it('a startup failure before the runtime reports null timings and the failure code', async () => {
    const app = createApplication({
      plugins: [
        { name: 'lonely', version: '1.0.0', register() {} },
      ],
      diagnostics: {},
    });
    await expect(app.start()).rejects.toThrow(/mandatory 'runtime' capability/);
    const snapshot = app.diagnostics!.snapshot();
    expect(snapshot.state).toBe('failed');
    expect(snapshot.failureCode).toBe('startup-failed');
    expect(snapshot.instanceId).toBeNull();
    expect(snapshot.nodes).toEqual([]);
    // Terminal failure CLEARS the retained event buffer — the resolve-failure
    // record existed for exactly the duration of the startup attempt. A
    // reader sees the coarse state and counters, never the metadata.
    const batch = app.diagnostics!.read(0);
    expect(batch.events).toEqual([]);
    expect(batch.closed).toBe(false);
  });

  it('an environment-validation failure preserves the original error and marks failed', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin({}),
        {
          name: 'needs-env',
          version: '1.0.0',
          register(ctx) {
            ctx.environment.validate({ MISSING: { required: true } });
          },
        },
      ],
      diagnostics: {},
    });
    await expect(app.start()).rejects.toThrow(/Environment validation failed/);
    expect(app.diagnostics!.snapshot().state).toBe('failed');
  });

  it('the kernel-supported retry after a resolve-stage failed start reports running', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        // Resolve-stage failure: resolvePluginOrder throws BEFORE any plugin
        // registers, which is the correctable path unregister supports.
        {
          name: 'broken-dep',
          version: '1.0.0',
          dependencies: ['missing-capability'],
          register() {},
        },
        {
          name: 'server',
          version: '1.0.0',
          register(ctx) {
            ctx.router.get('/ok', (c) => c.response.json({ ok: true }));
          },
        },
      ],
      diagnostics: {},
    });
    await expect(app.start()).rejects.toThrow(/missing-capability/);
    expect(app.diagnostics!.snapshot().state).toBe('failed');

    // The kernel's own supported correction: unregister + start() again.
    expect(app.unregister('broken-dep')).toBe(true);
    await app.start();
    const res = await app.inject({ method: 'GET', url: '/ok' });
    expect(res.statusCode).toBe(200);
    // The reader must NOT keep reporting the failed attempt while the
    // retried application serves.
    const snapshot = app.diagnostics!.snapshot();
    expect(snapshot.state).toBe('running');
    expect(snapshot.failureCode).toBeNull();
    expect(snapshot.nodes.length).toBeGreaterThan(0);
    const batch = app.diagnostics!.read(0);
    expect(batch.events.some((event) => event.stage === 'request')).toBe(true);
    // The failed attempt's resolve record was discarded, but its sequence
    // number was NOT reused: the retry continues the numbering, and a reader
    // starting at 0 sees the discarded record as lost rather than getting a
    // renumbered sequence 1 it cannot tell apart from the old one.
    expect(batch.lost).toBeGreaterThan(0);
    expect(batch.events[0].sequence).toBe(batch.lost + 1);
    await app.stop();
  });

  it('observes the resolver, per-plugin registration, hooks, and the shutdown window', async () => {
    const order: string[] = [];
    // Captured from inside an onShutdown hook — the only reader position
    // that can see shutdown-phase records, because the terminal teardown
    // clears the ring.
    let midShutdown: readonly { stage: string; ordinal: unknown }[] | undefined;
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'hooked',
          version: '1.0.0',
          register(ctx) {
            ctx.lifecycle.onRegister(() => {
              order.push('register-hook');
            });
            ctx.lifecycle.onInit(() => {
              order.push('init-1');
            });
            ctx.lifecycle.onInit(() => {
              order.push('init-2');
            });
            ctx.lifecycle.onStopping(() => {
              order.push('stopping');
            });
            // LIFO: the FIRST-registered shutdown hook runs LAST, after the
            // other one has completed — its record is already in the ring.
            ctx.lifecycle.onShutdown(() => {
              midShutdown = app.diagnostics!.read(0, 128).events
                .filter((event) => event.kind === 'lifecycle')
                .map((event) => ({ stage: event.stage, ordinal: event.sequence }));
            });
            ctx.lifecycle.onShutdown(() => {
              order.push('shutdown');
            });
          },
        },
      ],
      diagnostics: { labels: { plugins: ['hooked'] } },
    });
    await app.start();
    // Captured BEFORE stop: startup-phase records only.
    const events = app.diagnostics!.read(0, 128).events.filter((event) =>
      event.kind === 'lifecycle'
    );
    await app.stop();
    expect(order).toEqual([
      'register-hook',
      'init-1',
      'init-2',
      'stopping',
      'shutdown',
    ]);
    const stages = events.map((event) => event.stage);
    expect(stages.indexOf('resolve')).toBeGreaterThanOrEqual(0);
    const registerIndex = stages.indexOf('register');
    expect(registerIndex).toBeGreaterThan(stages.indexOf('resolve'));
    expect(stages).toContain('register-hook');
    expect(stages).toContain('init');
    // Each hook invocation is its own record: two init hooks, two events.
    const initHooks = events.filter((event) => event.stage === 'init');
    expect(initHooks.length).toBe(2);
    expect(initHooks[0]!.operationId).not.toBe(initHooks[1]!.operationId);
    expect(initHooks.every((hook) => hook.outcome === 'ok')).toBe(true);
    // The resolve boundary AND the runtime plugin's own registration began
    // before the epoch existed — genuinely un-timed, never fabricated.
    // Everything whose boundary STARTED after the runtime registered is
    // timed with monotonic offsets.
    expect(events.find((event) => event.stage === 'resolve')?.atMs).toBeNull();
    const runtimeRegister = events.filter((event) => event.stage === 'register')[0]!;
    expect(runtimeRegister.atMs).toBeNull();
    expect(
      events
        .filter((event) => event !== events.find((e) => e.stage === 'resolve'))
        .filter((event) => event !== runtimeRegister)
        .every((event) => event.atMs !== null && event.durationMs !== null),
    ).toBe(true);
    // Mid-shutdown, the stopping and earlier shutdown records were visible
    // to a reader — and the state was already `stopping`.
    expect(midShutdown).toBeDefined();
    const midStages = midShutdown!.map((event) => event.stage);
    expect(midStages).toContain('stopping');
    expect(midStages).toContain('shutdown');
    // After the terminal teardown, nothing readable remains.
    expect(app.diagnostics!.read(0).events).toEqual([]);
    expect(app.diagnostics!.snapshot().state).toBe('closed');
  });

  it('a rejecting close hook marks the shutdown failed without changing the error', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'broken-close',
          version: '1.0.0',
          register(ctx) {
            ctx.lifecycle.onClose(() => Promise.reject(new Error('close blew up')));
          },
        },
      ],
      diagnostics: {},
    });
    await app.start();
    const beforeStop = app.diagnostics!.read(0, 128);
    expect(beforeStop.events.length).toBeGreaterThan(0);
    await expect(app.stop()).rejects.toThrow('close blew up');
    const snapshot = app.diagnostics!.snapshot();
    expect(snapshot.state).toBe('closed');
    expect(snapshot.failureCode).toBe('shutdown-failed');
    // Retained metadata was cleared unconditionally despite the failure.
    expect(snapshot.nodes).toEqual([]);
    expect(app.diagnostics!.read(0).closed).toBe(true);
  });

  it('a clean shutdown clears retained metadata and closes the ring', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        {
          name: 'plain',
          version: '1.0.0',
          provides: ['plain'],
          register(ctx) {
            ctx.services.register('plain', {});
          },
        },
      ],
      diagnostics: { labels: { plugins: ['plain'] } },
    });
    await app.start();
    expect(app.diagnostics!.snapshot().nodes.length).toBeGreaterThan(0);
    await app.stop();
    const snapshot = app.diagnostics!.snapshot();
    expect(snapshot.state).toBe('closed');
    expect(snapshot.failureCode).toBeNull();
    expect(snapshot.nodes).toEqual([]);
    expect(app.diagnostics!.read(0).closed).toBe(true);
  });

  it('state never moves backwards from a terminal failure', async () => {
    const app = createApplication({
      plugins: [{ name: 'x', version: '1.0.0', register() {} }],
      diagnostics: {},
    });
    await expect(app.start()).rejects.toThrow();
    // A second start attempt cannot resurrect the collector's terminal state.
    await expect(app.start()).rejects.toThrow();
    expect(app.diagnostics!.snapshot().state).toBe('failed');
  });
});
