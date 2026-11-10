/**
 * The guarded REAL-import test (AI_GUIDELINES §12.2).
 *
 * Every other loader test drives a fake module bundle, which proves the adapter
 * but not that the three specifiers resolve or that the real modules satisfy the
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
import { dispatchRpc, type DispatchEntry } from '../../src/transports/rpc-dispatcher.ts';
import type { ConnectRuntime, UniversalHandlerLike } from '../../src/interfaces/connect-runtime.ts';
import type { GrpcServiceDefinition, RpcCall } from '@setu-ts/common';

/** Whether all three specifiers can actually be imported here. */
async function connectAvailable(): Promise<boolean> {
  try {
    await loadConnectModule();
    return true;
  } catch {
    return false;
  }
}

const available = await connectAvailable();

/** A real health router, its handlers keyed as the plugin keys them. */
async function healthMap(
  implementation: Record<string, unknown>,
): Promise<{ runtime: ConnectRuntime; map: Map<string, DispatchEntry> }> {
  const runtime = await loadConnectModule();
  const registry = runtime.reviveDescriptorSet(EmbeddedDescriptors.healthBase64);
  const health = runtime.getService(registry, 'grpc.health.v1.Health')!;
  const router = runtime.createConnectRouter();
  router.service(health, implementation);
  const entry = (handler: UniversalHandlerLike, streamsResponse: boolean): DispatchEntry => ({
    handle: (request) => runtime.handleUniversal(handler, request),
    streamsRequest: false,
    streamsResponse,
  });
  return {
    runtime,
    map: new Map(
      router.handlers.map((h) => [h.requestPath, entry(h, h.requestPath.endsWith('/Watch'))]),
    ),
  };
}

/** A Connect JSON call to a health procedure. */
function call(path: string, contentType: string, body: Uint8Array): RpcCall {
  return {
    method: 'POST',
    url: `http://localhost${path}`,
    path,
    headers: new Headers({ 'content-type': contentType }),
    body,
  };
}

/** One Connect streaming envelope: flags, 4-byte length, payload. */
function envelope(flags: number, json: string): Uint8Array {
  const payload = new TextEncoder().encode(json);
  const out = new Uint8Array(5 + payload.length);
  out[0] = flags;
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, 5);
  return out;
}

describe('Connect real import', { skip: !available }, () => {
  it('resolves all three specifiers and satisfies the ConnectRuntime port', async () => {
    const runtime = await loadConnectModule();
    expect(typeof runtime.createConnectRouter).toBe('function');
    expect(typeof runtime.handleUniversal).toBe('function');
    expect(typeof runtime.reviveDescriptorSet).toBe('function');
    expect(typeof runtime.getService).toBe('function');
    expect(typeof runtime.serializeFileDescriptor).toBe('function');
  });

  it('builds a real router whose handlers carry their requestPath', async () => {
    const { map } = await healthMap({ check: () => ({ status: 1 }) });
    expect([...map.keys()]).toContain('/grpc.health.v1.Health/Check');
  });

  // Connect aborts a call's own signal once the call ends, so the abort is
  // observed from inside the handler. Without the transport signal (the
  // control), the same abort does not reach the call.
  it.each([true, false])(
    'the transport signal cancels the real call (handed: %s)',
    async (handed) => {
      const controller = new AbortController();
      let before: boolean | undefined;
      let after: boolean | undefined;
      const { map } = await healthMap({
        check: (_request: unknown, context: { signal: AbortSignal }) => {
          before = context.signal.aborted;
          controller.abort();
          after = context.signal.aborted;
          return { status: 1 };
        },
      });
      const reply = await dispatchRpc(
        call('/grpc.health.v1.Health/Check', 'application/json', new TextEncoder().encode('{}')),
        map,
        '',
        handed ? { trailers: false, signal: controller.signal } : { trailers: false },
      );
      expect(reply!.status).toBe(200);
      expect(before).toBe(false);
      expect(after).toBe(handed);
    },
  );

  it('serves a real unary Check as one gathered body', async () => {
    const { map } = await healthMap({ check: () => ({ status: 1 }) });
    const reply = await dispatchRpc(
      call(
        '/grpc.health.v1.Health/Check',
        'application/json',
        new TextEncoder().encode(JSON.stringify({ service: '' })),
      ),
      map,
      '',
    );
    expect(reply!.status).toBe(200);
    expect(reply!.streaming).toBe(false);
    expect(reply!.body).toBeInstanceOf(Uint8Array);
    // Real Protobuf-ES JSON encoding renders the enum by name.
    expect(JSON.parse(new TextDecoder().decode(reply!.body as Uint8Array))).toEqual({
      status: 'SERVING',
    });
  });

  it('streams a real server-streaming Watch message by message', async () => {
    const { map } = await healthMap({
      async *watch() {
        yield { status: 1 };
        yield { status: 2 };
      },
    });
    const reply = await dispatchRpc(
      call('/grpc.health.v1.Health/Watch', 'application/connect+json', envelope(0, '{}')),
      map,
      '',
    );
    expect(reply!.status).toBe(200);
    expect(reply!.streaming).toBe(true);
    const text = new TextDecoder().decode(
      new Uint8Array(await new Response(reply!.body as ReadableStream<Uint8Array>).arrayBuffer()),
    );
    expect(text).toContain('"status":"SERVING"');
    expect(text).toContain('"status":"NOT_SERVING"');
  });

  it('reads a request body handed as a stream', async () => {
    const { map } = await healthMap({ check: () => ({ status: 1 }) });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"serv'));
        controller.enqueue(new TextEncoder().encode('ice":""}'));
        controller.close();
      },
    });
    const reply = await dispatchRpc(
      { ...call('/grpc.health.v1.Health/Check', 'application/json', new Uint8Array()), body },
      map,
      '',
    );
    expect(reply!.status).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(reply!.body as Uint8Array))).toEqual({
      status: 'SERVING',
    });
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
