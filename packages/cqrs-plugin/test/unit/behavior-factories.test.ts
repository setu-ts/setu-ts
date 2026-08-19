/**
 * CqrsPlugin behavior factory tests: a mixed `behaviors` list runs in DECLARED
 * order (not instances-then-factories), and `setBehaviors` replaces rather than
 * accumulates.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CqrsPlugin } from '../../src/plugin/cqrs-plugin.ts';
import { CAPABILITIES, type ICommandBus, type IPluginContext } from '@setu-ts/common';
import type { IPipelineBehavior } from '@setu-ts/common';

function makeContext(): {
  ctx: IPluginContext;
  services: Map<string, unknown>;
  onInit: (() => void)[];
} {
  const services = new Map<string, unknown>();
  const onInit: (() => void)[] = [];
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
    health: { register: () => {} },
    metrics: { register: () => {} },
    openapi: { addSchema: () => {} },
    decorators: { register: () => {} },
    cli: { register: () => {} },
    environment: { validate: () => {} },
    options: {},
    app: {} as IPluginContext['app'],
  };
  return { ctx, services, onInit };
}

/** A behavior that records its own name, then continues the pipeline. */
function recording(name: string, order: string[]): IPipelineBehavior {
  return {
    handle: (_req, next) => {
      order.push(name);
      return next();
    },
  };
}

describe('CqrsPlugin behavior factories', () => {
  it('a mixed list of instances and factories runs in declared order', async () => {
    const { ctx, services, onInit } = makeContext();
    const order: string[] = [];
    const a = recording('A', order);
    const bFactory = () => recording('B', order);
    const c = recording('C', order);

    await CqrsPlugin({
      commandHandlers: [{ type: 'x', handler: { handle: () => 'done' } }],
      behaviors: [a, bFactory, c],
    }).register!(ctx);
    for (const hook of onInit) hook();

    const bus = services.get(CAPABILITIES.COMMAND_BUS) as ICommandBus;
    await bus.execute<unknown>({ type: 'x', data: {} });

    // Declared order is A, B, C — NOT instances-then-factories (A, C, B).
    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('setBehaviors replaces rather than accumulates on a second onInit', async () => {
    const { ctx, services, onInit } = makeContext();
    const order: string[] = [];
    const a = recording('A', order);
    const bFactory = () => recording('B', order);
    const c = recording('C', order);

    await CqrsPlugin({
      commandHandlers: [{ type: 'x', handler: { handle: () => 'done' } }],
      behaviors: [a, bFactory, c],
    }).register!(ctx);

    // First onInit + execute: A, B, C.
    for (const hook of onInit) hook();
    const bus = services.get(CAPABILITIES.COMMAND_BUS) as ICommandBus;
    await bus.execute<unknown>({ type: 'x', data: {} });
    expect(order).toEqual(['A', 'B', 'C']);

    // Second onInit + execute: the list is REPLACED, so the second execute
    // again records exactly A, B, C — not A, B, C, A, B, C.
    for (const hook of onInit) hook();
    await bus.execute<unknown>({ type: 'x', data: {} });
    expect(order).toEqual(['A', 'B', 'C', 'A', 'B', 'C']);
  });
});
