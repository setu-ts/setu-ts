/**
 * The error for a missing capability names the actual cause.
 *
 * "Register a plugin that provides it" was the only advice, and it is wrong in
 * the two commonest cases: a lookup before `start()` (the plugin IS listed, it
 * has just not run) and a `register()` that asks for a capability a LATER
 * plugin provides. Three guides once shipped the first mistake, which is why
 * the message has to say it.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import type { IPlugin, IPluginContext } from '@setu-ts/common';
import { createApplication } from '../../src/application/application.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

const GENERIC = 'Register a plugin that provides it, or check the token spelling';

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

/** Provides `greeter`, at the default priority. */
function greeterPlugin(): IPlugin {
  return {
    name: 'greeter-plugin',
    version: '1.0.0',
    provides: ['greeter'],
    register(ctx: IPluginContext) {
      ctx.services.register('greeter', { greet: () => 'hi' });
    },
  };
}

/** Reads `token` during its own register(), ordered ahead of everything else. */
function earlyConsumer(token: string): IPlugin {
  return {
    name: 'early-consumer',
    version: '1.0.0',
    priority: PLUGIN_PRIORITY.HIGH,
    register(ctx: IPluginContext) {
      ctx.services.get(token);
    },
  };
}

describe('the error for a missing capability', () => {
  it('says the application has not started, for a lookup before start()', () => {
    const app = createApplication({ plugins: [runtimePlugin(), greeterPlugin()] });
    let message = '';
    try {
      app.services.get('greeter');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("No service registered for capability 'greeter'.");
    expect(message).toContain('The application has not started');
    expect(message).toContain('during start()');
    expect(message).not.toContain(GENERIC);
  });

  it('names the later provider, for a lookup during an earlier register()', async () => {
    const app = createApplication({
      plugins: [runtimePlugin(), greeterPlugin(), earlyConsumer('greeter')],
    });
    await expect(app.start()).rejects.toThrow(
      "Plugin 'greeter-plugin' provides it, but registers after 'early-consumer'. Add " +
        "'greeter' to the dependencies (or optionalDependencies) of 'early-consumer'",
    );
  });

  it('keeps the generic advice during register() when nothing provides the token', async () => {
    // A later plugin that provides nothing, and one that provides something else.
    const quiet: IPlugin = { name: 'quiet', version: '1.0.0', register() {} };
    const app = createApplication({
      plugins: [runtimePlugin(), earlyConsumer('nobody'), quiet, greeterPlugin()],
    });
    await expect(app.start()).rejects.toThrow(GENERIC);
  });

  it('keeps the generic advice once the application has started', async () => {
    const app = createApplication({ plugins: [runtimePlugin(), greeterPlugin()] });
    await app.start();
    try {
      expect(() => app.services.get('missing')).toThrow(GENERIC);
      // The provided capability resolves, so the phase check is not in the way.
      expect(app.services.get<{ greet(): string }>('greeter').greet()).toBe('hi');
    } finally {
      await app.stop();
    }
  });
});
