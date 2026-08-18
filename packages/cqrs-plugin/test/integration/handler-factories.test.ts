/**
 * CqrsPlugin factory-arm integration: a command handler's factory resolves
 * `CAPABILITIES.EVENTS` and the executed command publishes an event an
 * independent subscriber observes — the X2-2 scenario ("a command handler has
 * no route to the event bus"), driven through `commandBus.execute`.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createApplication } from '@setu-ts/kernel';
import { EventsPlugin } from '@setu-ts/events-plugin';
import { CqrsPlugin } from '../../src/plugin/cqrs-plugin.ts';
import { CAPABILITIES } from '@setu-ts/common';
import type {
  ICommandBus,
  ICommandHandler,
  IEventBus,
  IPlugin,
  TimerHandle,
} from '@setu-ts/common';

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

describe('CqrsPlugin handler factories (integration)', () => {
  it('a command handler factory resolves the event bus and publishes an observed event', async () => {
    const observed: string[] = [];
    const app = createApplication({
      plugins: [
        fakeRuntimePlugin(),
        EventsPlugin(),
        CqrsPlugin({
          commandHandlers: [
            {
              type: 'PlaceOrder',
              handler: (services): ICommandHandler => ({
                handle: (command) => {
                  const id = (command.data as { id: string }).id;
                  const events = services.get<IEventBus>(CAPABILITIES.EVENTS);
                  void events.publish({
                    type: 'OrderPlaced',
                    id: 'evt-1',
                    occurredOn: new Date(0),
                    data: { id },
                  });
                  return id;
                },
              }),
            },
          ],
        }),
      ],
    });

    // An independent subscriber, registered outside the plugin.
    app.register({
      name: 'order-listener',
      version: '1.0.0',
      register(ctx) {
        const events = ctx.services.get<IEventBus>(CAPABILITIES.EVENTS);
        events.subscribe<{ id: string }>('OrderPlaced', (event) => {
          observed.push(event.data.id);
        });
      },
    });

    await app.start();
    try {
      const commands = app.services.get<ICommandBus>(CAPABILITIES.COMMAND_BUS);
      await commands.execute<unknown>({ type: 'PlaceOrder', data: { id: 'order-42' } });
      expect(observed).toEqual(['order-42']);
    } finally {
      await app.stop();
    }
  });
});
