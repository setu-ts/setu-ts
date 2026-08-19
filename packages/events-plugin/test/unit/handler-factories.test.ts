/**
 * EventsPlugin factory-arm tests: instance and factory entries both subscribe
 * through `subscribeHandler`, a factory is called at `onInit`, and the health
 * payload's `subscriptionCount` counts both.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { EventsPlugin } from '../../src/plugin/events-plugin.ts';
import type { IEventHandler } from '../../src/handlers/event-handler.ts';
import { CAPABILITIES, type IEventBus, type IPluginContext } from '@setu-ts/common';

function makeContext(): {
  ctx: IPluginContext;
  services: Map<string, unknown>;
  onInit: (() => void)[];
  health: Array<{ name: string; fn: () => Promise<{ status: string; data?: unknown }> }>;
} {
  const services = new Map<string, unknown>();
  const onInit: (() => void)[] = [];
  const health: Array<{ name: string; fn: () => Promise<{ status: string; data?: unknown }> }> = [];
  const ctx: IPluginContext = {
    services: {
      register: (token, service) => {
        services.set(token, service);
      },
      registerFactory: () => {},
      get: () => {
        throw new Error('no capability is resolved in these unit tests');
      },
      getAll: () => [],
      has: (token) => services.has(token),
      unregister: () => false,
    },
    runtime: {} as IPluginContext['runtime'],
    middleware: { add: () => {} },
    router: {
      get: () => {},
      post: () => {},
      put: () => {},
      patch: () => {},
      delete: () => {},
      head: () => {},
      options: () => {},
      group: () => {},
      listRoutes: () => [],
    },
    lifecycle: {
      onRegister: () => {},
      onInit: (handler: () => void) => {
        onInit.push(handler);
      },
      onBootstrap: () => {},
      onRequest: () => {},
      onResponse: () => {},
      onError: () => {},
      onStopping: () => {},
      onShutdown: () => {},
      onClose: () => {},
    },
    health: {
      register: (name, fn) => {
        health.push({ name, fn });
      },
    },
    metrics: { register: () => {} },
    openapi: { addSchema: () => {} },
    decorators: { register: () => {} },
    cli: { register: () => {} },
    environment: { validate: () => {} },
    options: {},
    app: {} as IPluginContext['app'],
  };
  return { ctx, services, onInit, health };
}

const EVENT = { type: 'OrderPlaced', id: 'evt-1', occurredOn: new Date(0), data: { id: 'x' } };

describe('EventsPlugin handler factories', () => {
  it('subscribes an instance handler during register()', async () => {
    const { ctx, services } = makeContext();
    const seen: string[] = [];
    const instance: IEventHandler<{ id: string }> = {
      handle: (event) => {
        seen.push(event.data.id);
      },
    };
    await EventsPlugin({ handlers: [{ type: 'OrderPlaced', handler: instance }] }).register!(ctx);
    const bus = services.get(CAPABILITIES.EVENTS) as IEventBus;
    await bus.publish(EVENT);
    expect(seen).toEqual(['x']);
  });

  it('calls a factory handler at onInit and subscribes its result', async () => {
    const { ctx, services, onInit } = makeContext();
    let calls = 0;
    const seen: string[] = [];
    const factory = (): IEventHandler<{ id: string }> => {
      calls += 1;
      return {
        handle: (event) => {
          seen.push(event.data.id);
        },
      };
    };
    await EventsPlugin({ handlers: [{ type: 'OrderPlaced', handler: factory }] }).register!(ctx);
    expect(calls).toBe(0);

    for (const hook of onInit) hook();
    expect(calls).toBe(1);

    const bus = services.get(CAPABILITIES.EVENTS) as IEventBus;
    await bus.publish(EVENT);
    expect(seen).toEqual(['x']);
  });

  it('the health payload counts both instance and factory handlers', async () => {
    const { ctx, onInit, health } = makeContext();
    const instance: IEventHandler = { handle: () => {} };
    await EventsPlugin({
      handlers: [
        { type: 'A', handler: instance },
        { type: 'B', handler: () => ({ handle: () => {} }) },
      ],
    }).register!(ctx);
    for (const hook of onInit) hook();

    const report = await health.find((h) => h.name === 'events')!.fn();
    expect(report.data).toEqual({ handlers: 2 });
  });

  it("a throwing factory names its DECLARED index and the entry's type", async () => {
    // The attribution the CHANGELOG and PUBLIC_API both promise had no test in
    // this package. Driven with the arms MIXED, because a filtered index and a
    // declared index are both 0 for a single-factory list — only a mix can tell
    // them apart, and reporting `[0]` here names a working instance entry.
    const { ctx, onInit } = makeContext();
    const instance: IEventHandler = { handle: () => {} };
    const boom = new Error('capability missing');
    await EventsPlugin({
      handlers: [
        { type: 'A', handler: instance },
        { type: 'B', handler: instance },
        {
          type: 'C-factory',
          handler: (): IEventHandler => {
            throw boom;
          },
        },
      ],
    }).register!(ctx);

    let thrown: Error | undefined;
    try {
      for (const hook of onInit) hook();
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toContain('EventsPlugin({ handlers })[2]');
    expect(thrown?.message).toContain('type "C-factory"');
    expect(thrown?.cause).toBe(boom);
  });
});
