/**
 * Unit tests for the Connect router builder: which services get registered for
 * each `reflection`/`health` combination, dispatch-map keying, duplicate
 * detection, and the wiring that lets health and reflection see the full
 * service-name list.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { buildConnectRouter } from '../../src/transports/connect-router-builder.ts';
import { GrpcDescriptorError } from '../../src/errors/grpc-errors.ts';
import {
  createFakeConnectRuntime,
  type FakeConnectRuntime,
  fakeFile,
  fakeService,
} from '../fixtures/fake-connect-runtime.ts';
import type { EmbeddedDescriptors as EmbeddedDescriptorsType } from '../../src/descriptors/embedded-descriptors.ts';

const HEALTH = 'grpc.health.v1.Health';
const REFLECTION = 'grpc.reflection.v1.ServerReflection';

const embeddedDescriptors: EmbeddedDescriptorsType = {
  healthBase64: btoa('health-bytes'),
  reflectionBase64: btoa('reflection-bytes'),
};

/** A runtime that can resolve the two built-in services plus any app services. */
function runtimeWith(appServices: ReturnType<typeof fakeService>[] = []): FakeConnectRuntime {
  return createFakeConnectRuntime({
    services: [
      fakeService(HEALTH, ['Check'], fakeFile('grpc/health/v1/health.proto')),
      fakeService(
        REFLECTION,
        ['ServerReflectionInfo'],
        fakeFile(
          'grpc/reflection/v1/reflection.proto',
        ),
      ),
      ...appServices,
    ],
  });
}

function build(
  runtime: FakeConnectRuntime,
  overrides: Partial<Parameters<typeof buildConnectRouter>[0]> = {},
) {
  return buildConnectRouter({
    connectRuntime: runtime,
    basePath: '/grpc',
    reflection: true,
    health: true,
    services: [],
    embeddedDescriptors,
    healthService: undefined,
    ...overrides,
  });
}

const registeredNames = (runtime: FakeConnectRuntime) =>
  runtime.registered.map((r) => r.definition.typeName);

describe('buildConnectRouter — service registration', () => {
  it('registers health and reflection by default', () => {
    const runtime = runtimeWith();
    build(runtime);
    expect(registeredNames(runtime)).toEqual([HEALTH, REFLECTION]);
  });

  it('registers only health when reflection is disabled', () => {
    const runtime = runtimeWith();
    build(runtime, { reflection: false });
    expect(registeredNames(runtime)).toEqual([HEALTH]);
  });

  it('registers only reflection when health is disabled', () => {
    const runtime = runtimeWith();
    build(runtime, { health: false });
    expect(registeredNames(runtime)).toEqual([REFLECTION]);
  });

  it('registers neither when both are disabled', () => {
    const runtime = runtimeWith();
    build(runtime, { health: false, reflection: false });
    expect(registeredNames(runtime)).toEqual([]);
  });

  it('does not revive an embedded descriptor set for a disabled service', () => {
    const runtime = runtimeWith();
    build(runtime, { health: false, reflection: false });
    expect(runtime.revived).toEqual([]);
  });

  it('registers application services ahead of the built-ins', () => {
    const echo = fakeService('example.Echo', ['Echo'], fakeFile('example/echo.proto'));
    const runtime = runtimeWith([echo]);
    build(runtime, { services: [{ definition: echo, implementation: { echo: () => ({}) } }] });

    expect(registeredNames(runtime)).toEqual(['example.Echo', HEALTH, REFLECTION]);
  });

  it('passes the application implementation through to the router', () => {
    const echo = fakeService('example.Echo', ['Echo'], fakeFile('example/echo.proto'));
    const implementation = { echo: () => ({ response: 'hi' }) };
    const runtime = runtimeWith([echo]);
    build(runtime, { services: [{ definition: echo, implementation }] });

    expect(runtime.registered[0].implementation).toBe(implementation);
  });

  it('substitutes an empty implementation when none is supplied', () => {
    const echo = fakeService('example.Echo', ['Echo'], fakeFile('example/echo.proto'));
    const runtime = runtimeWith([echo]);
    build(runtime, { services: [{ definition: echo }] });

    expect(runtime.registered[0].implementation).toEqual({});
  });

  it('throws rather than silently overwriting a duplicate typeName', () => {
    const echo = fakeService('example.Echo', ['Echo'], fakeFile('example/echo.proto'));
    const runtime = runtimeWith([echo]);
    expect(() => build(runtime, { services: [{ definition: echo }, { definition: echo }] }))
      .toThrow(/already been registered/);
  });

  it('throws GrpcDescriptorError when an embedded set lacks its service', () => {
    const runtime = createFakeConnectRuntime({ services: [] });
    expect(() => build(runtime)).toThrow(GrpcDescriptorError);
  });
});

describe('buildConnectRouter — dispatch map', () => {
  it('keys handlers by basePath + requestPath', () => {
    const runtime = createFakeConnectRuntime({
      services: [
        fakeService(HEALTH, ['Check'], fakeFile('grpc/health/v1/health.proto')),
        fakeService(REFLECTION, ['ServerReflectionInfo'], fakeFile('grpc/reflection/v1/r.proto')),
      ],
      requestPaths: ['/grpc.health.v1.Health/Check'],
    });
    const { dispatchMap } = build(runtime);

    expect([...dispatchMap.keys()]).toEqual(['/grpc/grpc.health.v1.Health/Check']);
  });

  it('normalizes a trailing-slash basePath to the same keys', () => {
    const paths = ['/pkg.Svc/Method'];
    const withSlash = createFakeConnectRuntime({
      services: [
        fakeService(HEALTH, ['Check'], fakeFile('h.proto')),
        fakeService(REFLECTION, ['Info'], fakeFile('r.proto')),
      ],
      requestPaths: paths,
    });
    const { dispatchMap } = build(withSlash, { basePath: '/grpc/' });
    expect([...dispatchMap.keys()]).toEqual(['/grpc/pkg.Svc/Method']);
  });

  it('keys against the root when basePath is /', () => {
    const runtime = createFakeConnectRuntime({
      services: [
        fakeService(HEALTH, ['Check'], fakeFile('h.proto')),
        fakeService(REFLECTION, ['Info'], fakeFile('r.proto')),
      ],
      requestPaths: ['/pkg.Svc/Method'],
    });
    const { dispatchMap } = build(runtime, { basePath: '/' });
    // Not '//pkg.Svc/Method'.
    expect([...dispatchMap.keys()]).toEqual(['/pkg.Svc/Method']);
  });

  it('produces a working fetch handler per entry', async () => {
    const runtime = createFakeConnectRuntime({
      services: [
        fakeService(HEALTH, ['Check'], fakeFile('h.proto')),
        fakeService(REFLECTION, ['Info'], fakeFile('r.proto')),
      ],
      requestPaths: ['/pkg.Svc/Method'],
    });
    const { dispatchMap } = build(runtime);
    const handler = dispatchMap.get('/grpc/pkg.Svc/Method')!;
    const response = await handler(new Request('http://x/grpc/pkg.Svc/Method'));

    expect(await response.text()).toBe('handled:/pkg.Svc/Method');
  });
});

describe('buildConnectRouter — health and reflection wiring', () => {
  /** Pulls a registered implementation by service name. */
  function implOf(runtime: FakeConnectRuntime, typeName: string): Record<string, unknown> {
    return runtime.registered.find((r) => r.definition.typeName === typeName)!.implementation;
  }

  it('gives the health bridge every service name, so Check knows what it serves', async () => {
    const echo = fakeService('example.Echo', ['Echo'], fakeFile('example/echo.proto'));
    const runtime = runtimeWith([echo]);
    build(runtime, { services: [{ definition: echo }] });

    const check = implOf(runtime, HEALTH).check as (
      r: { service: string },
    ) => Promise<{ status: number }>;

    // A registered app service is known...
    expect((await check({ service: 'example.Echo' })).status).toBe(1);
    // ...the built-ins are known...
    expect((await check({ service: REFLECTION })).status).toBe(1);
    // ...and anything else is SERVICE_UNKNOWN.
    expect((await check({ service: 'no.Such' })).status).toBe(3);
  });

  it('gives reflection the full service list, app services first', async () => {
    const echo = fakeService('example.Echo', ['Echo'], fakeFile('example/echo.proto'));
    const runtime = runtimeWith([echo]);
    build(runtime, { services: [{ definition: echo }] });

    const info = implOf(runtime, REFLECTION).serverReflectionInfo as (
      requests: AsyncIterable<unknown>,
    ) => AsyncGenerator<{ messageResponse: { case: string; value: unknown } }>;

    async function* requests() {
      yield { messageRequest: { case: 'listServices', value: '' } };
    }

    const [response] = await Array.fromAsync(info(requests()));
    expect(response.messageResponse.case).toBe('listServicesResponse');
    expect(response.messageResponse.value).toEqual({
      service: [{ name: 'example.Echo' }, { name: HEALTH }, { name: REFLECTION }],
    });
  });

  it('reflects an application service file and its transitive dependencies', async () => {
    const shared = fakeFile('example/shared.proto', {
      messages: [{
        typeName: 'example.Shared',
        nestedMessages: [],
        nestedEnums: [],
        nestedExtensions: [],
      }],
    });
    const echoFile = fakeFile('example/echo.proto', { dependencies: [shared] });
    const echo = fakeService('example.Echo', ['Echo'], echoFile);
    const runtime = runtimeWith([echo]);
    build(runtime, { services: [{ definition: echo }] });

    const info = implOf(runtime, REFLECTION).serverReflectionInfo as (
      requests: AsyncIterable<unknown>,
    ) => AsyncGenerator<{ messageResponse: { case: string; value: unknown } }>;

    async function* requests() {
      yield { messageRequest: { case: 'fileContainingSymbol', value: 'example.Shared' } };
    }

    const [response] = await Array.fromAsync(info(requests()));
    expect(response.messageResponse.case).toBe('fileDescriptorResponse');
    expect(runtime.serializedFiles).toContain('example/shared.proto');
  });

  it('does not build a reflection registry when reflection is disabled', () => {
    const echo = fakeService('example.Echo', ['Echo'], fakeFile('example/echo.proto'));
    const runtime = runtimeWith([echo]);
    build(runtime, { reflection: false, services: [{ definition: echo }] });

    expect(runtime.serializedFiles).toEqual([]);
  });
});
