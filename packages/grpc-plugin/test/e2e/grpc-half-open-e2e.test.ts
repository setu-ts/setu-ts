/**
 * V5-5 — a native gRPC client must reach the refusal, not hang.
 *
 * The Trailers-Only `UNIMPLEMENTED` refusal (M70i) and the root base path
 * (M70i) were both correct and neither helped, because the refusal was
 * UNREACHABLE for the shape that needs it. The kernel buffered the whole
 * request body before dispatching, and a client-streaming or bidirectional
 * call holds its request stream OPEN — so that read never resolved and the
 * caller received no frames at all. `grpcurl` opens a bidirectional
 * reflection stream before anything else, so it hung on every request, while
 * a unary probe with the stream closed received the refusal correctly.
 *
 * Probed at the HTTP/2 frame level during the v0.5.0 regression run: a
 * dispatch-map path with the stream OPEN produced no frames; the same path
 * with `END_STREAM` produced a correct `HEADERS END_STREAM` Trailers-Only
 * response; a non-map path answered immediately either way. The last of those
 * is the tell — a non-map path is rejected by `claims()` BEFORE the body read.
 *
 * Every case here is bounded by a deadline. A hang is the defect, so a test
 * that could hang would report it as a stuck suite rather than a failure.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { GrpcPlugin } from '../../src/plugin/grpc-plugin.ts';
import { loadConnectModule } from '../../src/transports/connect-loader.ts';
import { CAPABILITIES, type GrpcServiceDefinition, type IGrpcService } from '@setu-ts/common';
import { ECHO_DESCRIPTOR_BASE64 } from '../fixtures/echo-descriptors.ts';

/** How long a header-only answer may take before the test calls it a hang. */
const DEADLINE_MS = 3_000;

/** Revives the `example.EchoService` descriptor through the real Connect runtime. */
async function reviveEchoService(): Promise<GrpcServiceDefinition> {
  const runtime = await loadConnectModule();
  const registry = runtime.reviveDescriptorSet(ECHO_DESCRIPTOR_BASE64);
  return runtime.getService(registry, 'example.EchoService') as GrpcServiceDefinition;
}

/**
 * A request body that never ends — the wire shape of a client-streaming or
 * bidirectional call that has not finished sending.
 */
function openStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // One frame arrives, then nothing: the client is still sending.
      controller.enqueue(new Uint8Array([0, 0, 0, 0, 0]));
    },
  });
}

/** Rejects rather than hanging, so the defect reports as a failure. */
function withDeadline<T>(work: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${what} did not answer within ${DEADLINE_MS}ms`)),
        DEADLINE_MS,
      );
      void work.finally(() => clearTimeout(timer));
    }),
  ]);
}

async function withApp(
  run: (app: ReturnType<typeof createApplication>) => Promise<void>,
): Promise<void> {
  const app = createApplication({ plugins: [RuntimePlugin(), GrpcPlugin()] });
  await app.start({ port: 0 });
  const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
  grpc.addService(await reviveEchoService(), {
    echo: (req: { message: string }) => ({ response: `echo: ${req.message}` }),
    ping: () => ({ pong: true }),
  });
  try {
    await run(app);
  } finally {
    await app.stop();
  }
}

describe('native gRPC over a half-open request stream (V5-5)', () => {
  it('answers the Trailers-Only refusal without waiting for the body to end', async () => {
    await withApp(async (app) => {
      const body = openStream();
      const request = new Request('http://localhost/example.EchoService/Echo', {
        method: 'POST',
        headers: { 'content-type': 'application/grpc+proto' },
        body,
        // Required by the fetch spec for a stream body.
        duplex: 'half',
      } as RequestInit);

      const response = await withDeadline(app.fetch(request), 'a half-open native gRPC call');

      // The protocol's own way to report a status without trailers: a 200
      // whose HEADER block carries the status.
      expect(response.status).toBe(200);
      expect(response.headers.get('grpc-status')).toBe('12');
      expect(response.headers.get('content-type')).toContain('application/grpc');
      await response.body?.cancel();
    });
  });

  it('answers the same refusal when the stream IS closed', async () => {
    // The case that already worked. Asserted so the fix is known to have
    // changed reachability only, not the answer.
    await withApp(async (app) => {
      const request = new Request('http://localhost/example.EchoService/Echo', {
        method: 'POST',
        headers: { 'content-type': 'application/grpc+proto' },
        body: new Uint8Array([0, 0, 0, 0, 0]) as unknown as BodyInit,
      });

      const response = await withDeadline(app.fetch(request), 'a closed native gRPC call');

      expect(response.status).toBe(200);
      expect(response.headers.get('grpc-status')).toBe('12');
      await response.body?.cancel();
    });
  });

  it('still serves a Connect call, whose content type is not refused', async () => {
    // Vacuity guard, and the M70i trap: `startsWith('application/grpc')` also
    // matches `application/grpc-web+proto`, so a refusal written that way
    // would break the formats that DO work. This fails if the header-only
    // refusal ever widens.
    await withApp(async (app) => {
      const request = new Request('http://localhost/example.EchoService/Echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      });

      const response = await withDeadline(app.fetch(request), 'a Connect unary call');

      expect(response.status).toBe(200);
      expect(response.headers.get('grpc-status')).toBeNull();
      expect(await response.json()).toEqual({ response: 'echo: hi' });
    });
  });

  it('leaves an ordinary route alone, even under a native content type', async () => {
    // A path outside the dispatch map is not this service's to refuse.
    await withApp(async (app) => {
      const request = new Request('http://localhost/not-a-procedure', {
        method: 'POST',
        headers: { 'content-type': 'application/grpc+proto' },
        body: new Uint8Array([0]) as unknown as BodyInit,
      });

      const response = await withDeadline(app.fetch(request), 'an ordinary route');

      expect(response.status).toBe(404);
      expect(response.headers.get('grpc-status')).toBeNull();
      await response.body?.cancel();
    });
  });
});
