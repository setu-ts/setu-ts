/**
 * Unit tests for {@linkcode GrpcService}: availability detection, deferred
 * service registration, dispatch, and shutdown.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { GrpcService } from '../../src/services/grpc-service.ts';
import { GrpcUnavailableError } from '../../src/errors/grpc-errors.ts';
import {
  createFakeConnectRuntime,
  type FakeConnectRuntime,
  fakeFile,
  fakeService,
} from '../fixtures/fake-connect-runtime.ts';
import type { GrpcServiceDefinition, IHttpAdapter } from '@setu-ts/common';
import type { EmbeddedDescriptors as EmbeddedDescriptorsType } from '../../src/descriptors/embedded-descriptors.ts';
import type { GrpcPluginOptions } from '../../src/interfaces/index.ts';

const HEALTH = 'grpc.health.v1.Health';
const REFLECTION = 'grpc.reflection.v1.ServerReflection';

const embeddedDescriptors: EmbeddedDescriptorsType = {
  healthBase64: btoa('health-bytes'),
  reflectionBase64: btoa('reflection-bytes'),
};

const echoDefinition = fakeService(
  'example.Echo',
  ['Echo'],
  fakeFile('example/echo.proto'),
) as unknown as GrpcServiceDefinition;

/** An adapter that implements the RPC seam. */
function capableAdapter(): IHttpAdapter {
  return { setRpcHandler: () => {} } as unknown as IHttpAdapter;
}

/** An adapter predating the M49 widening. */
function legacyAdapter(): IHttpAdapter {
  return {} as unknown as IHttpAdapter;
}

function runtimeWith(extra: ReturnType<typeof fakeService>[] = []): FakeConnectRuntime {
  return createFakeConnectRuntime({
    services: [
      fakeService(HEALTH, ['Check'], fakeFile('grpc/health/v1/health.proto')),
      fakeService(REFLECTION, ['ServerReflectionInfo'], fakeFile('grpc/reflection/v1/r.proto')),
      ...extra,
    ],
    requestPaths: ['/example.Echo/Echo'],
  });
}

function createService(
  overrides: {
    runtime?: FakeConnectRuntime;
    options?: GrpcPluginOptions;
    adapter?: IHttpAdapter | undefined;
  } = {},
): GrpcService {
  return new GrpcService({
    connectRuntime: overrides.runtime ?? runtimeWith(),
    embeddedDescriptors,
    options: overrides.options ?? {},
    adapter: 'adapter' in overrides ? overrides.adapter : capableAdapter(),
    healthService: undefined,
  });
}

describe('GrpcService — availability', () => {
  it('is available when the adapter implements setRpcHandler', () => {
    expect(createService().available).toBe(true);
  });

  it('is unavailable when the adapter predates the widening', () => {
    expect(createService({ adapter: legacyAdapter() }).available).toBe(false);
  });

  it('is unavailable when no adapter was resolved', () => {
    expect(createService({ adapter: undefined }).available).toBe(false);
  });

  it('rejects handleRequest with GrpcUnavailableError when unavailable', async () => {
    const service = createService({ adapter: legacyAdapter() });
    await expect(service.handleRequest(new Request('http://x/grpc/example.Echo/Echo')))
      .rejects.toBeInstanceOf(GrpcUnavailableError);
  });

  it('still accepts addService when unavailable, so wiring is not lost', () => {
    const service = createService({ adapter: legacyAdapter() });
    service.addService(echoDefinition);
    expect(service.serviceCount).toBe(1);
  });
});

describe('GrpcService — service registration', () => {
  it('registers services supplied through options', () => {
    const service = createService({
      options: { services: [{ definition: echoDefinition, implementation: { echo: () => ({}) } }] },
    });
    expect(service.serviceCount).toBe(1);
  });

  it('throws on a duplicate typeName', () => {
    const service = createService();
    service.addService(echoDefinition);
    expect(() => service.addService(echoDefinition)).toThrow(/already been registered/);
  });

  it('picks up a service added after the router was already built', async () => {
    const runtime = runtimeWith([fakeService('example.Echo', ['Echo'], fakeFile('e.proto'))]);
    const service = createService({ runtime });

    // Build the router once by dispatching.
    await service.handleRequest(new Request('http://x/grpc/unknown'));
    const before = runtime.registered.length;

    service.addService(echoDefinition);
    await service.handleRequest(new Request('http://x/grpc/unknown'));

    // The router was rebuilt and now carries the app service too.
    expect(runtime.registered.length).toBeGreaterThan(before);
    expect(runtime.registered.map((r) => r.definition.typeName)).toContain('example.Echo');
  });

  it('builds the router once and reuses it across requests', async () => {
    const runtime = runtimeWith();
    const service = createService({ runtime });

    await service.handleRequest(new Request('http://x/grpc/unknown'));
    const afterFirst = runtime.registered.length;
    await service.handleRequest(new Request('http://x/grpc/unknown'));

    expect(runtime.registered.length).toBe(afterFirst);
  });
});

describe('GrpcService — dispatch', () => {
  it('serves a registered procedure through handleRequest', async () => {
    const runtime = runtimeWith([fakeService('example.Echo', ['Echo'], fakeFile('e.proto'))]);
    const service = createService({ runtime });
    service.addService(echoDefinition);

    const response = await service.handleRequest(
      new Request('http://x/grpc/example.Echo/Echo', { method: 'POST' }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('handled:/example.Echo/Echo');
  });

  it('answers 404 from handleRequest for a non-RPC path', async () => {
    // handleRequest must return a Response, never null.
    const response = await createService().handleRequest(new Request('http://x/users'));
    expect(response.status).toBe(404);
  });

  it('honors a custom basePath', async () => {
    const runtime = runtimeWith([fakeService('example.Echo', ['Echo'], fakeFile('e.proto'))]);
    const service = createService({ runtime, options: { basePath: '/rpc/' } });
    service.addService(echoDefinition);

    const handler = service.createFetchHandler();
    expect(await handler(new Request('http://x/grpc/example.Echo/Echo'))).toBeNull();
    const hit = await handler(new Request('http://x/rpc/example.Echo/Echo', { method: 'POST' }));
    expect(hit?.status).toBe(200);
  });
});

describe('GrpcService — fetch handler', () => {
  it('returns null for traffic outside the base path so Hono handles it', async () => {
    const handler = createService().createFetchHandler();
    expect(await handler(new Request('http://x/users'))).toBeNull();
  });

  it('serves a registered procedure', async () => {
    const runtime = runtimeWith([fakeService('example.Echo', ['Echo'], fakeFile('e.proto'))]);
    const service = createService({ runtime });
    service.addService(echoDefinition);

    const response = await service.createFetchHandler()(
      new Request('http://x/grpc/example.Echo/Echo', { method: 'POST' }),
    );
    expect(response?.status).toBe(200);
  });

  it('returns null for traffic outside the base path even when unavailable', async () => {
    const service = createService({ adapter: legacyAdapter() });
    expect(await service.createFetchHandler()(new Request('http://x/users'))).toBeNull();
  });
});

describe('GrpcService — shutdown', () => {
  /** A service whose router has been built and then closed. */
  async function closedService(): Promise<{ service: GrpcService; runtime: FakeConnectRuntime }> {
    const runtime = runtimeWith([fakeService('example.Echo', ['Echo'], fakeFile('e.proto'))]);
    const service = createService({ runtime });
    service.addService(echoDefinition);
    // Build the router so the served-path set is populated.
    await service.handleRequest(new Request('http://x/grpc/example.Echo/Echo', { method: 'POST' }));
    service.close();
    return { service, runtime };
  }

  it('answers 503 for its own procedures after close()', async () => {
    const { service } = await closedService();
    const response = await service.handleRequest(
      new Request('http://x/grpc/example.Echo/Echo', { method: 'POST' }),
    );
    expect(response.status).toBe(503);
  });

  it('leaves ordinary application routes alone while draining', async () => {
    // Returning 503 for every path would take the whole app down on shutdown.
    const { service } = await closedService();
    const handler = service.createFetchHandler();
    expect(await handler(new Request('http://x/users'))).toBeNull();
    expect(await handler(new Request('http://x/grpc/example.Echo/Unknown'))).toBeNull();
  });

  it('does not rebuild the router after close()', async () => {
    const { service, runtime } = await closedService();
    const registeredAtClose = runtime.registered.length;
    await service.handleRequest(new Request('http://x/grpc/example.Echo/Echo'));

    expect(runtime.registered.length).toBe(registeredAtClose);
  });

  it('is idempotent', async () => {
    const { service } = await closedService();
    expect(() => service.close()).not.toThrow();
    const response = await service.handleRequest(
      new Request('http://x/grpc/example.Echo/Echo', { method: 'POST' }),
    );
    expect(response.status).toBe(503);
  });
});
