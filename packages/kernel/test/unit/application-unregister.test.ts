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

  it('removes only the first plugin carrying the name, leaving the rest intact', async () => {
    const ran: string[] = [];
    const app = createApplication({
      plugins: [runtimePlugin(), eagerPlugin('a', ran), eagerPlugin('b', ran)],
    });

    app.unregister('a');
    await app.start();

    expect(ran).toEqual(['b']);
  });

  it('throws after the application has started', async () => {
    const ran: string[] = [];
    const app = createApplication({ plugins: [runtimePlugin(), eagerPlugin('database', ran)] });
    await app.start();

    // A silent `false` would report success for an operation that cannot have
    // had any effect: #runStartup has already read the plugin array.
    expect(() => app.unregister('database')).toThrow(
      'Cannot unregister plugins after the application has started.',
    );
    expect(app.services.has('database')).toBe(true);
  });

  it('leaves a dependent plugin to fail loudly at start(), naming both', async () => {
    const ran: string[] = [];
    const dependent: IPlugin = {
      name: 'orders',
      version: '1.0.0',
      dependencies: ['database'],
      register() {},
    };
    const app = createApplication({
      plugins: [runtimePlugin(), eagerPlugin('database', ran), dependent],
    });

    app.unregister('database');

    // Removing a plugin others depend on is not refused here — that is the
    // resolver's job, and its message names the dependency as well as the
    // dependent, which a refusal at `unregister()` could not.
    await expect(app.start()).rejects.toThrow(/orders.*database|database.*orders/s);
  });
});
