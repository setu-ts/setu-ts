import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin, IPluginContext } from '@setu-ts/common';
import { createApplication } from '../../src/application/application.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

function runtimePlugin(): IPlugin {
  const fake = createFakeRuntime();
  return {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
    },
  };
}

/**
 * Stands in for a plugin whose `register()` carries an eager side effect —
 * `DatabasePlugin` calls `adapter.connect()` there. Overriding its capability
 * cannot stop that; only removing the plugin can.
 */
function eagerPlugin(name: string, ran: string[]): IPlugin {
  return {
    name,
    version: '1.0.0',
    provides: [name],
    register(ctx: IPluginContext) {
      ran.push(name);
      ctx.services.register(name, { who: name });
    },
  };
}

describe('Application.hasPlugin', () => {
  it('reports pending plugins without resolving anything', async () => {
    const ran: string[] = [];
    const app = createApplication({ plugins: [runtimePlugin(), eagerPlugin('database', ran)] });

    expect(app.hasPlugin('database')).toBe(true);
    expect(app.hasPlugin('databse')).toBe(false);
    // A pure read: nothing registered, nothing constructed.
    expect(ran).toEqual([]);

    await app.start();
    expect(ran).toEqual(['database']);
  });

  it('reflects a removal', () => {
    const ran: string[] = [];
    const app = createApplication({ plugins: [runtimePlugin(), eagerPlugin('database', ran)] });

    app.unregister('database');

    expect(app.hasPlugin('database')).toBe(false);
  });
});

describe('Application.unregister', () => {
  it('removes a pending plugin so its register() never runs', async () => {
    const ran: string[] = [];
    const app = createApplication({
      plugins: [runtimePlugin(), eagerPlugin('database', ran), eagerPlugin('cache', ran)],
    });

    expect(app.unregister('database')).toBe(true);
    await app.start();

    expect(ran).toEqual(['cache']);
    expect(app.services.has('database')).toBe(false);
    expect(app.services.has('cache')).toBe(true);
  });

  it('returns false for a name the application does not hold', () => {
    const ran: string[] = [];
    const app = createApplication({ plugins: [runtimePlugin(), eagerPlugin('database', ran)] });

    expect(app.unregister('databse')).toBe(false);
    expect(app.unregister('database')).toBe(true);
    // Removing the same name twice is a miss, not a second removal.
    expect(app.unregister('database')).toBe(false);
  });

  it('leaves plugins carrying other names untouched', async () => {
    const ran: string[] = [];
    const app = createApplication({
      plugins: [runtimePlugin(), eagerPlugin('a', ran), eagerPlugin('b', ran)],
    });

    app.unregister('a');
    await app.start();

    expect(ran).toEqual(['b']);
  });

  it('removes EVERY pending plugin carrying the name, not just the first', async () => {
    const ran: string[] = [];
    // Two pending plugins may share a name: the kernel refuses duplicates at
    // `start()`, not at `register()`. Removing only the first would leave one
    // running while the caller was told the name was dropped — and would turn a
    // loud startup failure into a silently-running plugin, because the
    // duplicate is gone by the time the resolver looks.
    const app = createApplication({
      plugins: [runtimePlugin(), eagerPlugin('database', ran), eagerPlugin('database', ran)],
    });

    expect(app.unregister('database')).toBe(true);
    await app.start();

    expect(ran).toEqual([]);
  });

  it('throws after a FAILED start, where plugins have already run', async () => {
    const ran: string[] = [];
    const exploder: IPlugin = {
      name: 'exploder',
      version: '1.0.0',
      priority: 900,
      register() {
        throw new Error('boom during startup');
      },
    };
    const app = createApplication({
      plugins: [runtimePlugin(), eagerPlugin('database', ran), exploder],
    });

    await expect(app.start()).rejects.toThrow('boom during startup');

    // `start()` rolls `#started` back so a failed start can be corrected and
    // retried — but `database` already ran and its service is in the registry,
    // so removing it from the pending list cannot deliver what `unregister`
    // promises, and `true` would report a removal that did not happen.
    expect(ran).toEqual(['database']);
    expect(app.services.has('database')).toBe(true);
    expect(() => app.unregister('database')).toThrow(
      'Cannot unregister plugins once startup has begun',
    );
  });

  it('throws after the application has started', async () => {
    const ran: string[] = [];
    const app = createApplication({ plugins: [runtimePlugin(), eagerPlugin('database', ran)] });
    await app.start();

    // A silent `false` would report success for an operation that cannot have
    // had any effect: #runStartup has already read the plugin array.
    expect(() => app.unregister('database')).toThrow(
      'Cannot unregister plugins once startup has begun',
    );
    expect(app.services.has('database')).toBe(true);
  });

  it('leaves a dependent plugin to fail loudly at start()', async () => {
    const ran: string[] = [];
    // The realistic shape, where a plugin's NAME differs from the TOKEN it
    // provides — as every first-party plugin does. A fixture whose name and
    // token coincide makes the assertion below pass on a coincidence.
    const provider: IPlugin = {
      name: 'database-plugin',
      version: '1.0.0',
      provides: ['database'],
      register() {
        ran.push('database-plugin');
      },
    };
    const dependent: IPlugin = {
      name: 'orders',
      version: '1.0.0',
      dependencies: ['database'],
      register() {},
    };
    const app = createApplication({ plugins: [runtimePlugin(), provider, dependent] });

    app.unregister('database-plugin');

    // Removing a plugin others depend on is not refused here — that is the
    // resolver's job. Its message names the DEPENDENT and the unsatisfied
    // CAPABILITY; it does NOT name the plugin that was removed, which is what
    // the docs now say rather than claiming it "names both plugins".
    const error = await app.start().then(() => null, (e: Error) => e);
    expect(error?.message).toBe(
      "Plugin 'orders' depends on capability 'database', but no registered plugin provides it.",
    );
    expect(error?.message).not.toContain('database-plugin');
    expect(ran).toEqual([]);
  });
});
