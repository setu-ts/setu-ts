/**
 * Unit test: GrpcPlugin does NOT call adapter.setRpcHandler after M70a.
 * gRPC dispatch is handled by the kernel terminal handler after the middleware
 * pipeline, so the adapter seam is no longer used.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { GrpcPlugin } from '../../src/plugin/grpc-plugin.ts';
import { CAPABILITIES } from '@setu-ts/common';
import type {
  HealthIndicatorFn,
  IGrpcService,
  IPluginContext,
  RpcFetchHandler,
} from '@setu-ts/common';
import {
  createFakeConnectRuntime,
  fakeFile,
  fakeService,
} from '../fixtures/fake-connect-runtime.ts';

const HEALTH = 'grpc.health.v1.Health';
const REFLECTION = 'grpc.reflection.v1.ServerReflection';

function createHarness() {
  const registered = new Map<string, unknown>();
  const indicators = new Map<string, HealthIndicatorFn>();
  const closeHooks: Array<() => void | Promise<void>> = [];
  const setRpcHandlerCalls: RpcFetchHandler[] = [];

  // Adapter that tracks setRpcHandler calls
  const adapter = {
    setRpcHandler: (handler: RpcFetchHandler) => {
      setRpcHandlerCalls.push(handler);
    },
  };

  const ctx = {
    services: {
      get(token: string) {
        if (token === CAPABILITIES.HTTP_ADAPTER) return adapter;
        throw new Error(`Service not registered: ${token}`);
      },
      register(token: string, service: unknown) {
        registered.set(token, service);
      },
    },
    health: {
      register(name: string, indicator: HealthIndicatorFn) {
        indicators.set(name, indicator);
      },
    },
    lifecycle: {
      onClose(hook: () => void | Promise<void>) {
        closeHooks.push(hook);
      },
    },
    logger: {
      warn: () => {},
      info: () => {},
      error: () => {},
      debug: () => {},
    },
  } as unknown as IPluginContext;

  return { ctx, registered, indicators, closeHooks, setRpcHandlerCalls };
}

describe('GrpcPlugin — does NOT call setRpcHandler (M70a)', () => {
  it('register() does not call adapter.setRpcHandler', async () => {
    const harness = createHarness();
    const runtime = createFakeConnectRuntime({
      services: [
        fakeService(HEALTH, ['Check'], fakeFile('grpc/health/v1/health.proto')),
        fakeService(REFLECTION, ['ServerReflectionInfo'], fakeFile('grpc/reflection/v1/r.proto')),
      ],
    });

    await GrpcPlugin({ connectModule: runtime }).register?.(harness.ctx);

    // After M70a, the plugin no longer calls setRpcHandler
    expect(harness.setRpcHandlerCalls).toHaveLength(0);
  });

  it('still registers IGrpcService under CAPABILITIES.GRPC', async () => {
    const harness = createHarness();
    const runtime = createFakeConnectRuntime({
      services: [
        fakeService(HEALTH, ['Check'], fakeFile('grpc/health/v1/health.proto')),
        fakeService(REFLECTION, ['ServerReflectionInfo'], fakeFile('grpc/reflection/v1/r.proto')),
      ],
    });

    await GrpcPlugin({ connectModule: runtime }).register?.(harness.ctx);

    const service = harness.registered.get(CAPABILITIES.GRPC) as IGrpcService;
    expect(service).toBeDefined();
    expect(service.available).toBe(true);
  });

  it('gRPC is available without setRpcHandler', async () => {
    const harness = createHarness();
    const runtime = createFakeConnectRuntime({
      services: [
        fakeService(HEALTH, ['Check'], fakeFile('grpc/health/v1/health.proto')),
        fakeService(REFLECTION, ['ServerReflectionInfo'], fakeFile('grpc/reflection/v1/r.proto')),
      ],
    });

    await GrpcPlugin({ connectModule: runtime }).register?.(harness.ctx);

    const service = harness.registered.get(CAPABILITIES.GRPC) as IGrpcService;
    // available is true because the kernel dispatches gRPC (not the adapter)
    expect(service.available).toBe(true);
    expect(typeof service.handleRequest).toBe('function');
  });
});
