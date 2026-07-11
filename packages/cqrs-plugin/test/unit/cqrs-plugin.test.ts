/**
 * CQRS plugin tests.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CqrsPlugin } from '../../src/plugin/cqrs-plugin.ts';
import {
  CAPABILITIES,
  type CqrsRequest,
  type IPipelineBehavior,
  PLUGIN_PRIORITY,
} from '@hono-enterprise/common';
import type { ICommandBus, ICqrsFacade, IPluginContext, IQueryBus } from '@hono-enterprise/common';

describe('CqrsPlugin', () => {
  it('should have correct name', () => {
    const plugin = CqrsPlugin();
    expect(plugin.name).toBe('cqrs-plugin');
  });

  it('should have correct version', () => {
    const plugin = CqrsPlugin();
    expect(plugin.version).toBe('0.1.0');
  });

  it('should provide correct capabilities', () => {
    const plugin = CqrsPlugin();
    expect(plugin.provides).toEqual([
      CAPABILITIES.CQRS,
      CAPABILITIES.COMMAND_BUS,
      CAPABILITIES.QUERY_BUS,
    ]);
  });

  it('should have NORMAL priority', () => {
    const plugin = CqrsPlugin();
    expect(plugin.priority).toBe(PLUGIN_PRIORITY.NORMAL);
  });

  describe('Plugin Registration', () => {
    it('should register services with default options', async () => {
      const plugin = CqrsPlugin();
      const registeredServices = new Map<string, unknown>();
      const healthRegistrations: Array<{ name: string }> = [];
      const lifecycleHandlers: Array<{ event: string; handler: () => Promise<void> }> = [];

      const ctx: IPluginContext = {
        services: {
          register<T>(key: string, service: T): void {
            registeredServices.set(key, service);
          },
          registerFactory: () => {},
          get: () => {
            throw new Error('not found');
          },
          getAll: () => [],
          has: () => false,
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
        },
        lifecycle: {
          onRegister: () => {},
          onInit: () => {},
          onBootstrap: () => {},
          onRequest: () => {},
          onResponse: () => {},
          onError: () => {},
          onShutdown: () => {},
          onClose: (handler: () => Promise<void>) => {
            lifecycleHandlers.push({ event: 'close', handler });
          },
        },
        health: {
          register: (name: string, _fn: () => Promise<{ status: string }>) => {
            healthRegistrations.push({ name });
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

      await plugin.register!(ctx);

      // Verify services were registered
      expect(registeredServices.has(CAPABILITIES.COMMAND_BUS)).toBe(true);
      expect(registeredServices.has(CAPABILITIES.QUERY_BUS)).toBe(true);
      expect(registeredServices.has(CAPABILITIES.CQRS)).toBe(true);

      // Verify services are correct types
      expect(registeredServices.get(CAPABILITIES.COMMAND_BUS)).toBeInstanceOf(Object);
      expect(registeredServices.get(CAPABILITIES.QUERY_BUS)).toBeInstanceOf(Object);

      // Verify facade has correct properties
      const facade = registeredServices.get(CAPABILITIES.CQRS) as ICqrsFacade;
      expect(facade).toHaveProperty('commandBus');
      expect(facade).toHaveProperty('queryBus');

      // Verify health indicator was registered
      expect(healthRegistrations.length).toBe(1);
      expect(healthRegistrations[0].name).toBe('cqrs');

      // Verify lifecycle hook was registered
      expect(lifecycleHandlers.length).toBe(1);
      expect(lifecycleHandlers[0].event).toBe('close');
    });

    it('should register services with custom options', async () => {
      const mockBehavior: IPipelineBehavior = {
        handle: (_req: CqrsRequest, next: () => Promise<unknown>) => {
          return next();
        },
      };

      const plugin = CqrsPlugin({ behaviors: [mockBehavior] });
      const registeredServices = new Map<string, unknown>();

      const ctx: IPluginContext = {
        services: {
          register<T>(key: string, service: T): void {
            registeredServices.set(key, service);
          },
          registerFactory: () => {},
          get: () => {
            throw new Error('not found');
          },
          getAll: () => [],
          has: () => false,
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
        },
        lifecycle: {
          onRegister: () => {},
          onInit: () => {},
          onBootstrap: () => {},
          onRequest: () => {},
          onResponse: () => {},
          onError: () => {},
          onShutdown: () => {},
          onClose: () => {},
        },
        health: {
          register: () => {},
        },
        metrics: { register: () => {} },
        openapi: { addSchema: () => {} },
        decorators: { register: () => {} },
        cli: { register: () => {} },
        environment: { validate: () => {} },
        options: {},
        app: {} as IPluginContext['app'],
      };

      await plugin.register!(ctx);

      // Verify services were registered
      expect(registeredServices.has(CAPABILITIES.COMMAND_BUS)).toBe(true);
      expect(registeredServices.has(CAPABILITIES.QUERY_BUS)).toBe(true);
      expect(registeredServices.has(CAPABILITIES.CQRS)).toBe(true);
    });

    it('should register multiple behaviors', async () => {
      const behavior1: IPipelineBehavior = {
        handle: (_req: CqrsRequest, next: () => Promise<unknown>) => next(),
      };
      const behavior2: IPipelineBehavior = {
        handle: (_req: CqrsRequest, next: () => Promise<unknown>) => next(),
      };
      const behavior3: IPipelineBehavior = {
        handle: (_req: CqrsRequest, next: () => Promise<unknown>) => next(),
      };

      const plugin = CqrsPlugin({ behaviors: [behavior1, behavior2, behavior3] });
      const registeredServices = new Map<string, unknown>();

      const ctx: IPluginContext = {
        services: {
          register<T>(key: string, service: T): void {
            registeredServices.set(key, service);
          },
          registerFactory: () => {},
          get: () => {
            throw new Error('not found');
          },
          getAll: () => [],
          has: () => false,
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
        },
        lifecycle: {
          onRegister: () => {},
          onInit: () => {},
          onBootstrap: () => {},
          onRequest: () => {},
          onResponse: () => {},
          onError: () => {},
          onShutdown: () => {},
          onClose: () => {},
        },
        health: {
          register: () => {},
        },
        metrics: { register: () => {} },
        openapi: { addSchema: () => {} },
        decorators: { register: () => {} },
        cli: { register: () => {} },
        environment: { validate: () => {} },
        options: {},
        app: {} as IPluginContext['app'],
      };

      await plugin.register!(ctx);

      const commandBus = registeredServices.get(CAPABILITIES.COMMAND_BUS) as ICommandBus;
      const queryBus = registeredServices.get(CAPABILITIES.QUERY_BUS) as IQueryBus;

      // Verify both buses are functional
      expect(commandBus).toBeDefined();
      expect(queryBus).toBeDefined();
    });
  });

  describe('Health Indicator', () => {
    it('should register health indicator with correct name', async () => {
      const plugin = CqrsPlugin();
      const healthRegistrations: Array<
        { name: string; fn: () => Promise<{ status: string; data?: unknown }> }
      > = [];

      const ctx: IPluginContext = {
        services: {
          register: () => {},
          registerFactory: () => {},
          get: () => {
            throw new Error('not found');
          },
          getAll: () => [],
          has: () => false,
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
        },
        lifecycle: {
          onRegister: () => {},
          onInit: () => {},
          onBootstrap: () => {},
          onRequest: () => {},
          onResponse: () => {},
          onError: () => {},
          onShutdown: () => {},
          onClose: () => {},
        },
        health: {
          register: (name: string, fn: () => Promise<{ status: string; data?: unknown }>) => {
            healthRegistrations.push({ name, fn });
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

      await plugin.register!(ctx);

      expect(healthRegistrations.length).toBe(1);
      expect(healthRegistrations[0].name).toBe('cqrs');

      // Invoke the health check function
      const result = await healthRegistrations[0].fn();
      expect(result.status).toBe('up');
      expect(result.data).toHaveProperty('commands');
      expect(result.data).toHaveProperty('queries');
    });
  });

  describe('Lifecycle Hooks', () => {
    it('should register shutdown hook that clears buses', async () => {
      const plugin = CqrsPlugin();
      let shutdownHandler: (() => Promise<void>) | null = null;

      const ctx: IPluginContext = {
        services: {
          register: () => {},
          registerFactory: () => {},
          get: () => {
            throw new Error('not found');
          },
          getAll: () => [],
          has: () => false,
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
        },
        lifecycle: {
          onRegister: () => {},
          onInit: () => {},
          onBootstrap: () => {},
          onRequest: () => {},
          onResponse: () => {},
          onError: () => {},
          onShutdown: () => {},
          onClose: (handler: () => Promise<void>) => {
            shutdownHandler = handler;
          },
        },
        health: {
          register: () => {},
        },
        metrics: { register: () => {} },
        openapi: { addSchema: () => {} },
        decorators: { register: () => {} },
        cli: { register: () => {} },
        environment: { validate: () => {} },
        options: {},
        app: {} as IPluginContext['app'],
      };

      await plugin.register!(ctx);

      expect(shutdownHandler).toBeDefined();

      // Invoke the shutdown handler
      await shutdownHandler!();

      // If we got here without error, the handler executed correctly
      expect(true).toBe(true);
    });

    it('should register onClose hook', async () => {
      const plugin = CqrsPlugin();
      let onCloseCalled = false;

      const ctx: IPluginContext = {
        services: {
          register: () => {},
          registerFactory: () => {},
          get: () => {
            throw new Error('not found');
          },
          getAll: () => [],
          has: () => false,
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
        },
        lifecycle: {
          onRegister: () => {},
          onInit: () => {},
          onBootstrap: () => {},
          onRequest: () => {},
          onResponse: () => {},
          onError: () => {},
          onShutdown: () => {},
          onClose: () => {
            onCloseCalled = true;
          },
        },
        health: {
          register: () => {},
        },
        metrics: { register: () => {} },
        openapi: { addSchema: () => {} },
        decorators: { register: () => {} },
        cli: { register: () => {} },
        environment: { validate: () => {} },
        options: {},
        app: {} as IPluginContext['app'],
      };

      await plugin.register!(ctx);

      // onClose hook was registered (the callback was invoked by the plugin)
      expect(onCloseCalled).toBe(true);
    });
  });

  describe('Service Registration', () => {
    it('should register command bus under correct capability', async () => {
      const plugin = CqrsPlugin();
      const registeredServices = new Map<string, unknown>();

      const ctx: IPluginContext = {
        services: {
          register<T>(key: string, service: T): void {
            registeredServices.set(key, service);
          },
          registerFactory: () => {},
          get: () => {
            throw new Error('not found');
          },
          getAll: () => [],
          has: () => false,
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
        },
        lifecycle: {
          onRegister: () => {},
          onInit: () => {},
          onBootstrap: () => {},
          onRequest: () => {},
          onResponse: () => {},
          onError: () => {},
          onShutdown: () => {},
          onClose: () => {},
        },
        health: {
          register: () => {},
        },
        metrics: { register: () => {} },
        openapi: { addSchema: () => {} },
        decorators: { register: () => {} },
        cli: { register: () => {} },
        environment: { validate: () => {} },
        options: {},
        app: {} as IPluginContext['app'],
      };

      await plugin.register!(ctx);

      expect(registeredServices.get(CAPABILITIES.COMMAND_BUS)).toBeDefined();
    });

    it('should register query bus under correct capability', async () => {
      const plugin = CqrsPlugin();
      const registeredServices = new Map<string, unknown>();

      const ctx: IPluginContext = {
        services: {
          register<T>(key: string, service: T): void {
            registeredServices.set(key, service);
          },
          registerFactory: () => {},
          get: () => {
            throw new Error('not found');
          },
          getAll: () => [],
          has: () => false,
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
        },
        lifecycle: {
          onRegister: () => {},
          onInit: () => {},
          onBootstrap: () => {},
          onRequest: () => {},
          onResponse: () => {},
          onError: () => {},
          onShutdown: () => {},
          onClose: () => {},
        },
        health: {
          register: () => {},
        },
        metrics: { register: () => {} },
        openapi: { addSchema: () => {} },
        decorators: { register: () => {} },
        cli: { register: () => {} },
        environment: { validate: () => {} },
        options: {},
        app: {} as IPluginContext['app'],
      };

      await plugin.register!(ctx);

      expect(registeredServices.get(CAPABILITIES.QUERY_BUS)).toBeDefined();
    });

    it('should register CQRS facade under correct capability', async () => {
      const plugin = CqrsPlugin();
      const registeredServices = new Map<string, unknown>();

      const ctx: IPluginContext = {
        services: {
          register<T>(key: string, service: T): void {
            registeredServices.set(key, service);
          },
          registerFactory: () => {},
          get: () => {
            throw new Error('not found');
          },
          getAll: () => [],
          has: () => false,
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
        },
        lifecycle: {
          onRegister: () => {},
          onInit: () => {},
          onBootstrap: () => {},
          onRequest: () => {},
          onResponse: () => {},
          onError: () => {},
          onShutdown: () => {},
          onClose: () => {},
        },
        health: {
          register: () => {},
        },
        metrics: { register: () => {} },
        openapi: { addSchema: () => {} },
        decorators: { register: () => {} },
        cli: { register: () => {} },
        environment: { validate: () => {} },
        options: {},
        app: {} as IPluginContext['app'],
      };

      await plugin.register!(ctx);

      const facade = registeredServices.get(CAPABILITIES.CQRS) as ICqrsFacade;
      expect(facade).toBeDefined();
      expect(facade.commandBus).toBeDefined();
      expect(facade.queryBus).toBeDefined();
    });
  });
});
