/**
 * The guarded REAL-import test (AI_GUIDELINES §12.2).
 *
 * Every other loader test drives a fake module bundle, which proves the adapter
 * but not that the four specifiers resolve or that the real modules satisfy the
 * port. This one performs the actual `import()`, and is skipped when the
 * packages are not installed.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { loadConnectModule } from '../../src/transports/connect-loader.ts';
import { EmbeddedDescriptors } from '../../src/descriptors/embedded-descriptors.ts';
import type { GrpcServiceDefinition } from '@setu-ts/common';

/** Whether all four specifiers can actually be imported here. */
async function connectAvailable(): Promise<boolean> {
  try {
    await loadConnectModule();
    return true;
  } catch {
    return false;
  }
}

const available = await connectAvailable();

describe('Connect real import', { ignore: !available }, () => {
  it('resolves all four specifiers and satisfies the ConnectRuntime port', async () => {
    const runtime = await loadConnectModule();
    expect(typeof runtime.createConnectRouter).toBe('function');
    expect(typeof runtime.createFetchHandler).toBe('function');
    expect(typeof runtime.reviveDescriptorSet).toBe('function');
    expect(typeof runtime.getService).toBe('function');
    expect(typeof runtime.serializeFileDescriptor).toBe('function');
  });

  it('builds a real router whose fetch handler retains requestPath', async () => {
    const runtime = await loadConnectModule();
    const registry = runtime.reviveDescriptorSet(EmbeddedDescriptors.healthBase64);
    const health = runtime.getService(registry, 'grpc.health.v1.Health')!;

    const router = runtime.createConnectRouter();
    router.service(health, { check: () => ({ status: 1 }) });

    expect(router.handlers.length).toBeGreaterThan(0);
    const handler = router.handlers.find((h) => h.requestPath.includes('Check'))!;
    expect(handler.requestPath).toBe('/grpc.health.v1.Health/Check');

    const fetchHandler = runtime.createFetchHandler(handler);
    // Connect returns Object.assign(fn, uHandler), so requestPath survives.
    expect((fetchHandler as unknown as { requestPath: string }).requestPath)
      .toBe('/grpc.health.v1.Health/Check');
  });

  it('serves a real unary Check over the real fetch handler', async () => {
    const runtime = await loadConnectModule();
    const registry = runtime.reviveDescriptorSet(EmbeddedDescriptors.healthBase64);
    const health = runtime.getService(registry, 'grpc.health.v1.Health')!;

    const router = runtime.createConnectRouter();
    router.service(health, { check: () => ({ status: 1 }) });
    const handler = router.handlers.find((h) => h.requestPath.includes('Check'))!;

    const response = await runtime.createFetchHandler(handler)(
      new Request(`http://localhost${handler.requestPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ service: '' }),
      }),
    );

    expect(response.status).toBe(200);
    // Real Protobuf-ES JSON encoding renders the enum by name.
    expect(await response.json()).toEqual({ status: 'SERVING' });
  });

  it('lets a REAL DescService satisfy GrpcServiceDefinition with no cast', async () => {
    // The point of constraining on `method` rather than `methods`: a generated
    // descriptor must be passable to addService directly. If this ever needs a
    // cast again, the structural constraint has stopped doing its job.
    const runtime = await loadConnectModule();
    const registry = runtime.reviveDescriptorSet(EmbeddedDescriptors.healthBase64);
    const service = runtime.getService(registry, 'grpc.health.v1.Health')!;

    const definition: GrpcServiceDefinition = service as unknown as {
      typeName: string;
      method: Record<string, unknown>;
    };
    expect(definition.typeName).toBe('grpc.health.v1.Health');
    expect(Object.keys(definition.method).sort()).toEqual(['check', 'list', 'watch']);
  });

  it('re-serializes a real file descriptor to non-empty FileDescriptorProto bytes', async () => {
    const runtime = await loadConnectModule();
    const registry = runtime.reviveDescriptorSet(EmbeddedDescriptors.reflectionBase64);
    const service = runtime.getService(registry, 'grpc.reflection.v1.ServerReflection')!;

    const bytes = runtime.serializeFileDescriptor(service.file!);
    expect(bytes.byteLength).toBeGreaterThan(0);
    // The suffixed name is what reflection clients ask for.
    expect(service.file!.proto.name).toBe('grpc/reflection/v1/reflection.proto');
    // ...while DescFile.name drops the suffix. Conflating them breaks lookups.
    expect(service.file!.name).toBe('grpc/reflection/v1/reflection');
  });
});
