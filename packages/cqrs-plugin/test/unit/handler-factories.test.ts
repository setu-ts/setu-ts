/**
 * CqrsPlugin factory-arm tests: instance and factory entries both reach the bus,
 * a factory is called once at `onInit`, and the health indicator counts both.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CqrsPlugin } from '../../src/plugin/cqrs-plugin.ts';
import { CAPABILITIES, type ICommandBus, type IPluginContext } from '@setu-ts/common';
import type { ICommandHandler, IQueryHandler, IServiceRegistry } from '@setu-ts/common';

/** A minimal plugin context that captures the onInit hook and the registry. */
function makeContext(): {
  ctx: IPluginContext;
  services: Map<string, unknown>;
  onInit: (() => void)[];
  health: string[];
  registry: IServiceRegistry;
} {
  const services = new Map<string, unknown>();
  const onInit: (() => void)[] = [];
  const health: string[] = [];
  // `get` always throws: the factory arms in these unit tests do not resolve a
  // capability (that is the integration suite's job), and a `never` return is the
  // only shape assignable to the generic `get<T extends object>(token): T`.
  const registry: IServiceRegistry = {
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
  };
  const ctx: IPluginContext = {
    services: registry,
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
    health: { register: (name: string) => health.push(name) },
    metrics: { register: () => {} },
    openapi: { addSchema: () => {} },
    decorators: { register: () => {} },
    cli: { register: () => {} },
    environment: { validate: () => {} },
    options: {},
    app: {} as IPluginContext['app'],
  };
  return { ctx, services, onInit, health, registry };
}

describe('CqrsPlugin handler factories', () => {
  it('registers an instance handler during register()', async () => {
    const { ctx, services } = makeContext();
    const instance: ICommandHandler = { handle: () => 'instance' };
    await CqrsPlugin({ commandHandlers: [{ type: 'add', handler: instance }] }).register!(ctx);
    const bus = services.get(CAPABILITIES.COMMAND_BUS) as ICommandBus;
    const result = await bus.execute<unknown>({ type: 'add', data: {} });
    expect(result).toBe('instance');
  });

  it('calls a factory handler once, at onInit, and registers its result', async () => {
    const { ctx, services, onInit } = makeContext();
    let calls = 0;
    const factory = (): ICommandHandler => {
      calls += 1;
      return { handle: () => 'from-factory' };
    };
    await CqrsPlugin({ commandHandlers: [{ type: 'add', handler: factory }] }).register!(ctx);

    // Not yet resolved during register().
    expect(calls).toBe(0);

    for (const hook of onInit) hook();
    expect(calls).toBe(1);

    const bus = services.get(CAPABILITIES.COMMAND_BUS) as ICommandBus;
    const result = await bus.execute<unknown>({ type: 'add', data: {} });
    expect(result).toBe('from-factory');
  });

  it('the health indicator counts both instance and factory handlers', async () => {
    const { ctx, services, onInit } = makeContext();
    const instance: IQueryHandler = { handle: () => 'q' };
    await CqrsPlugin({
      queryHandlers: [
        { type: 'read', handler: instance },
        { type: 'read2', handler: () => ({ handle: () => 'q2' }) },
      ],
    }).register!(ctx);
    for (const hook of onInit) hook();

    const bus = services.get(CAPABILITIES.QUERY_BUS) as ICommandBus;
    // Both handlers are reachable after onInit.
    expect(await bus.execute<unknown>({ type: 'read', data: {} })).toBe('q');
    expect(await bus.execute<unknown>({ type: 'read2', data: {} })).toBe('q2');
  });

  it("a throwing factory names its DECLARED index and the entry's type", async () => {
    // The attribution the CHANGELOG and PUBLIC_API both promise ("naming the
    // option and the entry") had no test in this package at all. It has to be
    // driven with the arms MIXED: a filtered index and a declared index are both
    // 0 for a single-factory list, so only a mix can tell them apart — and
    // reporting `[0]` here points the developer at the working instance entry.
    const { ctx, onInit } = makeContext();
    const instance: ICommandHandler = { handle: () => 'instance' };
    const boom = new Error('capability missing');
    await CqrsPlugin({
      commandHandlers: [
        { type: 'first-instance', handler: instance },
        {
          type: 'second-factory',
          handler: (): ICommandHandler => {
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
    expect(thrown?.message).toContain('CqrsPlugin({ commandHandlers })[1]');
    expect(thrown?.message).toContain('type "second-factory"');
    expect(thrown?.cause).toBe(boom);
  });

  it('a throwing query factory names its declared index too', async () => {
    const { ctx, onInit } = makeContext();
    const instance: IQueryHandler = { handle: () => 'q' };
    await CqrsPlugin({
      queryHandlers: [
        { type: 'read', handler: instance },
        { type: 'read2', handler: instance },
        {
          type: 'read3',
          handler: (): IQueryHandler => {
            throw new Error('capability missing');
          },
        },
      ],
    }).register!(ctx);
    expect(() => {
      for (const hook of onInit) hook();
    }).toThrow('CqrsPlugin({ queryHandlers })[2] (type "read3")');
  });

  it('a mixed list of two concretely-typed handlers plus a factory type-checks', () => {
    // Pins the method-syntax bivariance that keeps the list heterogeneous.
    const a: ICommandHandler<{ type: string; data: { id: string } }, string> = {
      handle: (c) => c.data.id,
    };
    const b: ICommandHandler<{ type: string; data: { id: string } }, number> = {
      handle: (c) => c.data.id.length,
    };
    const mixed = [
      { type: 'a', handler: a },
      { type: 'b', handler: b },
      { type: 'c', handler: (): ICommandHandler => ({ handle: () => 'c' }) },
    ];
    CqrsPlugin({ commandHandlers: mixed });
    expect(mixed).toHaveLength(3);
  });
});
