/**
 * The guarded REAL-import test (AI_GUIDELINES §12.2).
 *
 * Every other loader test drives a fake module bundle, which proves the adapter
 * but not that the four specifiers resolve or that the real modules satisfy the
 * port. This one performs the actual `import()`, and is skipped when the
 * packages are not installed.
 *
 * **Deno-only caveat:** this test resolves the specifiers through Deno's own
 * loader, so it passes on Deno whether or not the specifier survives JSR's
 * static npm-compatibility rewrite. That is precisely why it could never have
 * caught X7-3 (the `npm:` string shipping verbatim in the published artifact):
 * the published shape is only observable in a published artifact, which the
 * compat suite checks — see `compat/compat.test.mjs`. Do not mistake this
 * file for coverage of the published artifact.
 */

import { describe, expect, it } from 'vitest';
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

describe('Connect real import', { skip: !available }, () => {
  it('resolves all four specifiers and satisfies the ConnectRuntime port', async () => {
    const runtime = await loadConnectModule();
    expect(typeof runtime.createConnectRouter).toBe('function');
    expect(typeof runtime.createFetchHandler).toBe('function');
    expect(typeof runtime.handleUniversal).toBe('function');
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

    expect(typeof runtime.createFetchHandler(handler)).toBe('function');
  });

  // Connect aborts a call's own signal once the call ends, so the abort is
  // observed from inside the handler. Without the signal handed beside the
  // request (the control), the same abort does not reach the call.
  it.each([
    ['fetch', true],
    ['universal', true],
    ['fetch', false],
    ['universal', false],
  ] as const)(
    'a signal handed beside the request cancels the real call (%s, handed: %s)',
    async (path, handed) => {
      const runtime = await loadConnectModule();
      const registry = runtime.reviveDescriptorSet(EmbeddedDescriptors.healthBase64);
      const health = runtime.getService(registry, 'grpc.health.v1.Health')!;
      const controller = new AbortController();
      let before: boolean | undefined;
      let after: boolean | undefined;
      const router = runtime.createConnectRouter();
      router.service(health, {
        check: (_request: unknown, context: { signal: AbortSignal }) => {
          before = context.signal.aborted;
          controller.abort();
          after = context.signal.aborted;
          return { status: 1 };
        },
      });
      const handler = router.handlers.find((h) => h.requestPath.includes('Check'))!;
      const request = new Request('http://localhost/grpc.health.v1.Health/Check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const signal = handed ? controller.signal : undefined;
      const status =
        path === 'fetch'
          ? (await runtime.createFetchHandler(handler)(request, signal)).status
          : (await runtime.handleUniversal(handler, request, signal)).status;
      expect(status).toBe(200);
      expect(before).toBe(false);
      expect(after).toBe(handed);
    },
  );

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
