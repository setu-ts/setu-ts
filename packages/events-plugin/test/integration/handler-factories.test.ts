/**
 * EventsPlugin factory-arm integration: an event handler's factory resolves a
 * capability registered by a LATER plugin, and a published event reaches it
 * carrying that dependency's value.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createApplication } from '@setu-ts/kernel';
import { EventsPlugin } from '../../src/plugin/events-plugin.ts';
import { CAPABILITIES } from '@setu-ts/common';
import type { IEventBus, IPlugin, TimerHandle } from '@setu-ts/common';
import type { IEventHandler } from '../../src/handlers/event-handler.ts';

/** Fake runtime plugin so the kernel's mandatory `runtime` capability is present. */
function fakeRuntimePlugin(): IPlugin {
  return {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx) {
      const runtime = {
        platform: () => 'deno' as const,
        version: () => 'test',
        now: () => 0,
        hrtime: () => 0,
        setTimeout: (fn: () => void, ms: number) => {
          const id = globalThis.setTimeout(fn, ms);
          return { id } as TimerHandle;
        },
        clearTimeout: (handle: TimerHandle) =>
          globalThis.clearTimeout((handle as { id: number }).id),
        setInterval: (fn: () => void, ms: number) => {
          const id = globalThis.setInterval(fn, ms);
          return { id } as TimerHandle;
        },
        clearInterval: (handle: TimerHandle) =>
          globalThis.clearInterval((handle as { id: number }).id),
        uuid: () => 'fake-uuid',
        randomBytes: (length: number) => new Uint8Array(length),
        subtle: {} as SubtleCrypto,
        env: {},
        exit: () => {
          throw new Error('exit called');
        },
        hostname: () => 'localhost',
      };
      ctx.services.register(CAPABILITIES.RUNTIME, runtime);
    },
  };
}

/** A plugin that registers a capability the factory will resolve. */
function configProviderPlugin(): IPlugin {
  return {
    name: 'config-provider',
    version: '1.0.0',
    provides: [CAPABILITIES.CONFIG],
    register(ctx) {
      ctx.services.register(CAPABILITIES.CONFIG, { value: 'dep-42' });
    },
  };
}

describe('EventsPlugin handler factories (integration)', () => {
  it("a handler factory resolves a later plugin's capability and carries its value", async () => {
    const observed: string[] = [];
    const app = createApplication({
      plugins: [
        fakeRuntimePlugin(),
        EventsPlugin({
          handlers: [
            {
              type: 'OrderPlaced',
              // The factory runs at onInit, after config-provider has registered,
              // so it can resolve the capability and build a handler around it.
              handler: (services): IEventHandler => {
                const config = services.get<{ value: string }>(CAPABILITIES.CONFIG);
                return {
                  handle: (event) => {
                    const id = (event.data as { id: string }).id;
                    observed.push(`${id}:${config.value}`);
                  },
                };
              },
            },
          ],
        }),
        configProviderPlugin(),
      ],
    });

    await app.start();
    try {
      const events = app.services.get<IEventBus>(CAPABILITIES.EVENTS);
      await events.publish({
        type: 'OrderPlaced',
        id: 'evt-1',
        occurredOn: new Date(0),
        data: { id: 'order-1' },
      });
      expect(observed).toEqual(['order-1:dep-42']);
    } finally {
      await app.stop();
    }
  });
});
