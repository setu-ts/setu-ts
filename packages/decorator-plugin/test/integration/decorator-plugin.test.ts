import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@hono-enterprise/common';
import type {
  ClassProvider,
  Constructor,
  HandlerResult,
  IContainer,
  MiddlewareFunction,
  Provider,
  ProviderOptions,
  RouteDefinition,
  RouteHandler,
} from '@hono-enterprise/common';

import {
  ApiOperation,
  ApiResponse,
  ApiTags,
  Body,
  Controller,
  createDecorator,
  Get,
  Inject,
  Injectable,
  Post,
  UseGuards,
  ValidateBody,
  Version,
} from '../../src/index.ts';
import { DecoratorPlugin } from '../../src/plugin/decorator-plugin.ts';
import { metadataStore } from '../../src/metadata/metadata-store.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';
import { createFakeFileSystem, createFakeRuntime } from '../fixtures/fake-runtime.ts';

// Whether the runner can perform a real `import()` of a `file://` URL. The
// real-`import()` discovery path is an external I/O line; under
// non-interactive `deno test -P` (no read/import grant) it is skipped
// (CLAUDE.md: an external I/O line may stay behind a guarded test, but the
// branching logic around it is still exercised by the injectable-importer
// unit tests). Probed synchronously via the permission API to avoid a
// circular top-level `await import(import.meta.url)`.
function probeImportPermission(): boolean {
  const g = globalThis as {
    Deno?: { permissions?: { querySync?: (p: unknown) => { state: string } } };
  };
  const deno = g.Deno;
  if (deno?.permissions?.querySync === undefined) {
    return false;
  }
  try {
    return deno.permissions.querySync({ name: 'import' }).state === 'granted';
  } catch {
    return false;
  }
}
const realImportAvailable = probeImportPermission();

const guardFn: MiddlewareFunction = () => {};
const otherGuardFn: MiddlewareFunction = () => {};

/** Extracts the RouteDefinition a plugin registered (always a RouteDefinition). */
function asRouteDef(route: unknown): RouteDefinition {
  return route as RouteDefinition;
}

/** A recording DI container for service-registration tests. */
function recordingContainer(): {
  container: IContainer;
  registered: { token: string; provider: Provider<unknown>; options?: ProviderOptions }[];
} {
  const registered: { token: string; provider: Provider<unknown>; options?: ProviderOptions }[] =
    [];
  const instances = new Map<string, unknown>();
  const container: IContainer = {
    register<T>(token: string, provider: Provider<T>, options?: ProviderOptions): void {
      const entry: { token: string; provider: Provider<unknown>; options?: ProviderOptions } = {
        token,
        provider: provider as Provider<unknown>,
      };
      if (options !== undefined) {
        entry.options = options;
      }
      registered.push(entry);
    },
    has(token: string): boolean {
      return registered.some((r) => r.token === token);
    },
    resolve<T>(token: string): T {
      const entry = registered.find((r) => r.token === token);
      if (entry === undefined) {
        throw new Error(`not registered: ${token}`);
      }
      if (!instances.has(token)) {
        const cp = entry.provider as ClassProvider<unknown>;
        instances.set(token, new cp.useClass());
      }
      return instances.get(token) as T;
    },
    createScope(): IContainer {
      return container;
    },
  };
  return { container, registered };
}

describe('DecoratorPlugin registration (integration)', () => {
  beforeEach(() => {
    metadataStore.clear();
  });

  it('registers the metadata store under CAPABILITIES.METADATA_STORE', async () => {
    @Controller('/x')
    class C {
      @Get('/')
      list() {
        return [];
      }
    }
    const { ctx, services } = createFakeContext();
    await DecoratorPlugin({ controllers: [C] }).register(ctx);
    expect(services.has(CAPABILITIES.METADATA_STORE)).toBe(true);
    expect(services.get(CAPABILITIES.METADATA_STORE)?.[0]).toBe(metadataStore);
  });

  it('registers routes from explicit controllers with joined paths', async () => {
    @Controller('/users')
    @Version('v1')
    class C {
      @Get('/')
      list() {
        return [];
      }
      @Post('/:id')
      create() {
        return null;
      }
    }
    const { ctx, routes } = createFakeContext();
    await DecoratorPlugin({ controllers: [C] }).register(ctx);
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /v1/users',
      'POST /v1/users/:id',
    ]);
  });

  it('composes class- and method-level middleware in order', async () => {
    @Controller('/x')
    @UseGuards(guardFn)
    class C {
      @Get('/')
      @UseGuards(otherGuardFn)
      list() {
        return [];
      }
    }
    const { ctx, routes } = createFakeContext();
    await DecoratorPlugin({ controllers: [C] }).register(ctx);
    const def = asRouteDef(routes[0].route);
    expect(def.middleware).toEqual([guardFn, otherGuardFn]);
  });

  it('builds a RouteSchema from validation and OpenAPI metadata', async () => {
    const bodySchema = { type: 'object' };
    @Controller('/x')
    @ApiTags('users')
    class C {
      @Post('/')
      @ValidateBody(bodySchema)
      @ApiOperation({ summary: 'Create' })
      @ApiResponse({ status: 201, description: 'Created' })
      create(@Body() body: unknown) {
        return body;
      }
    }
    const { ctx, routes } = createFakeContext();
    await DecoratorPlugin({ controllers: [C] }).register(ctx);
    const schema = asRouteDef(routes[0].route).schema;
    expect(schema?.body).toBe(bodySchema);
    expect(schema?.tags).toEqual(['users']);
    expect(schema?.summary).toBe('Create');
    expect(schema?.response?.[201]).toMatchObject({ description: 'Created' });
  });

  it('registers services without a container by instantiation', async () => {
    @Injectable({ token: 'user-service' })
    class UserService {
      greet() {
        return 'hi';
      }
    }
    const { ctx, services } = createFakeContext();
    await DecoratorPlugin({ services: [UserService] }).register(ctx);
    expect(services.has('user-service')).toBe(true);
    const svc = services.get('user-service')?.[0] as { greet(): string } | undefined;
    expect(svc?.greet()).toBe('hi');
  });

  it('registers services with a DI container', async () => {
    @Injectable({ scope: 'singleton', token: 'repo' })
    @Inject('database')
    class Repository {
      constructor(_db: unknown = null) {}
    }
    const { container, registered } = recordingContainer();
    const { ctx } = createFakeContext({ container });
    await DecoratorPlugin({ services: [Repository] }).register(ctx);
    const repoEntry = registered.find((r) => r.token === 'repo');
    expect(repoEntry).toBeDefined();
    expect((repoEntry?.provider as ClassProvider<unknown>).inject).toEqual(['database']);
    expect(repoEntry?.options?.scope).toBe('singleton');
  });

  it('replays custom decorators against registered DecoratorHandlers', async () => {
    const seen: { target: object; propertyKey?: string; ttl: unknown }[] = [];
    @Controller('/x')
    class C {
      @Get('/')
      @createDecorator('cache:cacheable', { ttl: 60 })
      list() {
        return [];
      }
    }
    const { ctx } = createFakeContext();
    ctx.decorators.register('cache:cacheable', (metadata, target, propertyKey) => {
      const entry: { target: object; propertyKey?: string; ttl: unknown } = {
        target,
        ttl: metadata['ttl'],
      };
      if (propertyKey !== undefined) {
        entry.propertyKey = propertyKey;
      }
      seen.push(entry);
    });
    await DecoratorPlugin({ controllers: [C] }).register(ctx);
    expect(seen).toHaveLength(1);
    expect(seen[0].ttl).toBe(60);
    expect(seen[0].propertyKey).toBe('list');
  });

  it('decorators are inert without the plugin (no routes registered)', () => {
    @Controller('/inert')
    class C {
      @Get('/')
      list() {
        return [];
      }
    }
    // The decorator wrote to the store, but no plugin reads it.
    expect(metadataStore.hasController(C)).toBe(true);
    const { routes } = createFakeContext();
    // No DecoratorPlugin().register(ctx) call.
    expect(routes).toEqual([]);
  });

  it('decorator route matches the equivalent programmatic route (one impl)', async () => {
    const bodySchema = { type: 'object' };
    @Controller('/x')
    class C {
      @Post('/')
      @ValidateBody(bodySchema)
      @UseGuards(guardFn)
      create(@Body() body: unknown) {
        return body;
      }
    }
    const { ctx, routes } = createFakeContext();
    await DecoratorPlugin({ controllers: [C] }).register(ctx);
    const decoratorDef = asRouteDef(routes[0].route);

    const programmaticHandler: RouteHandler = () =>
      ({ __handlerResult: true }) as unknown as HandlerResult;
    const programmaticDef: RouteDefinition = {
      handler: programmaticHandler,
      middleware: [guardFn],
      schema: { body: bodySchema },
    };
    expect(decoratorDef.middleware).toEqual(programmaticDef.middleware);
    expect(decoratorDef.schema?.body).toBe(programmaticDef.schema?.body);
  });

  it({
    name: 'consumes autoDiscover + controllersPath (real import path)',
    ignore: !realImportAvailable,
  }, async () => {
    const sampleDir = new URL('../fixtures/discovery-sample/', import.meta.url).pathname.replace(
      /\/$/,
      '',
    );
    const fs = createFakeFileSystem({ [`${sampleDir}/user-controller.ts`]: '' });
    const runtime = createFakeRuntime({ fs });
    const { ctx, routes } = createFakeContext({ runtime });
    await DecoratorPlugin({ autoDiscover: true, controllersPath: sampleDir }).register(ctx);
    expect(routes.some((r) => r.method === 'GET' && r.path === '/discovered')).toBe(true);
  });

  it('skips a non-controller class passed in the controllers list', async () => {
    class NotAController {
      hello() {
        return 'hi';
      }
    }
    const { ctx, routes } = createFakeContext();
    await DecoratorPlugin({ controllers: [NotAController as unknown as Constructor] }).register(
      ctx,
    );
    expect(routes).toEqual([]);
  });
});
