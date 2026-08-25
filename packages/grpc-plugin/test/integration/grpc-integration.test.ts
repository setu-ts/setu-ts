/**
 * Plugin ↔ kernel integration: capability resolution, duplicate-registration
 * refusal, co-existence with ordinary Hono routes, and the documented
 * `inject()` limitation.
 *
 * Every application started here is stopped again — `stop()` exists on the
 * kernel application and leaving listeners bound leaks a socket per test.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { GrpcPlugin } from '../../src/plugin/grpc-plugin.ts';
import { CAPABILITIES, type IGrpcService } from '@setu-ts/common';

/** Runs `body` against a started application and always stops it. */
async function withApp(
  app: ReturnType<typeof createApplication>,
  body: (app: ReturnType<typeof createApplication>) => Promise<void>,
): Promise<void> {
  await app.start({ port: 0 });
  try {
    await body(app);
  } finally {
    await app.stop();
  }
}

describe('GrpcPlugin integration', () => {
  it('registers the service under CAPABILITIES.GRPC with a real adapter', async () => {
    await withApp(
      createApplication({ plugins: [RuntimePlugin(), GrpcPlugin()] }),
      (app) => {
        const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
        expect(grpc).toBeDefined();
        expect(typeof grpc.addService).toBe('function');
        // The real runtime adapters implement setRpcHandler.
        expect(grpc.available).toBe(true);
        return Promise.resolve();
      },
    );
  });

  it('refuses duplicate registration at startup', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), GrpcPlugin(), GrpcPlugin()],
    });
    await expect(app.start({ port: 0 })).rejects.toThrow('Duplicate plugin name');
  });

  it('leaves ordinary Hono routes working', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), GrpcPlugin()] });
    app.router.get('/users', (ctx) => ctx.response.json({ users: [] }));

    await withApp(app, async () => {
      const response = await app.fetch(new Request('http://localhost/users'));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ users: [] });
    });
  });

  it('serves an RPC at the bare method path with a stock plugin (root default, M70i)', async () => {
    // The root default is the whole point of the M70i repair: a stock
    // GrpcPlugin() answers a Health Check at /grpc.health.v1.Health/Check —
    // no prefix — while an ordinary route at /products is untouched.
    const app = createApplication({ plugins: [RuntimePlugin(), GrpcPlugin()] });
    app.router.get('/products', (ctx) => ctx.response.json({ products: [] }));

    await withApp(app, async () => {
      const rpc = await app.fetch(
        new Request('http://localhost/grpc.health.v1.Health/Check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ service: '' }),
        }),
      );
      expect(rpc.status).toBe(200);
      expect(await rpc.json()).toEqual({ status: 'SERVING' });

      const ordinary = await app.fetch(new Request('http://localhost/products'));
      expect(ordinary.status).toBe(200);
      expect(await ordinary.json()).toEqual({ products: [] });
    });
  });

  it('refuses a native application/grpc request with a Trailers-Only UNIMPLEMENTED (M70i §3.3)', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), GrpcPlugin()] });

    await withApp(app, async () => {
      const refused = await app.fetch(
        new Request('http://localhost/grpc.health.v1.Health/Check', {
          method: 'POST',
          headers: { 'content-type': 'application/grpc' },
          body: new Uint8Array([0, 0, 0, 0, 0]),
        }),
      );
      expect(refused.status).toBe(200);
      expect(refused.headers.get('content-type')).toBe('application/grpc');
      expect(refused.headers.get('grpc-status')).toBe('12');
      expect(await refused.text()).toBe('');
    });
  });

  it('still answers the same procedure over Connect and gRPC-Web (M70i §3.3)', async () => {
    // Connect: application/json is one of its unary content types (the existing
    // integration tests already rely on this). gRPC-Web: application/grpc-web+json
    // with the protocol's 5-byte message envelope (flags=0, big-endian length).
    const app = createApplication({ plugins: [RuntimePlugin(), GrpcPlugin()] });

    await withApp(app, async () => {
      const connectResponse = await app.fetch(
        new Request('http://localhost/grpc.health.v1.Health/Check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ service: '' }),
        }),
      );
      expect(connectResponse.status).toBe(200);
      expect(connectResponse.headers.get('grpc-status')).toBeNull();
      expect(await connectResponse.json()).toEqual({ status: 'SERVING' });

      const payload = new TextEncoder().encode(JSON.stringify({ service: '' }));
      const envelope = new Uint8Array(5 + payload.length);
      envelope[0] = 0; // flags: no compression, not a trailer
      new DataView(envelope.buffer).setUint32(1, payload.length, false);
      envelope.set(payload, 5);

      const webResponse = await app.fetch(
        new Request('http://localhost/grpc.health.v1.Health/Check', {
          method: 'POST',
          headers: { 'content-type': 'application/grpc-web+json' },
          body: envelope,
        }),
      );
      expect(webResponse.status).toBe(200);
      expect(webResponse.headers.get('grpc-status')).toBeNull();
      expect(webResponse.headers.get('content-type')).toContain('application/grpc-web+json');
      // The body is a sequence of gRPC-Web envelopes (message + trailers);
      // read the first envelope's payload via its big-endian length field.
      const body = new Uint8Array(await webResponse.arrayBuffer());
      const firstLength = new DataView(body.buffer, body.byteOffset, 5).getUint32(1, false);
      const decoded = JSON.parse(new TextDecoder().decode(body.subarray(5, 5 + firstLength)));
      expect(decoded).toEqual({ status: 'SERVING' });
    });
  });

  it('does not hijack a JSON POST outside the base path', async () => {
    // Connect's unary content types include application/json, so an
    // interceptor matching on media type would swallow this route.
    const app = createApplication({ plugins: [RuntimePlugin(), GrpcPlugin()] });
    app.router.post('/api/echo', (ctx) => ctx.response.json({ ok: true }));

    await withApp(app, async () => {
      const response = await app.fetch(
        new Request('http://localhost/api/echo', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hello: 'world' }),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    });
  });

  it('answers 404 for an unknown procedure inside an explicit base path', async () => {
    // Pinning basePath: '/grpc' keeps the non-root 404 behaviour covered after
    // the default moved to the root (M70i risk note: prefix tests are updated,
    // not deleted).
    await withApp(
      createApplication({ plugins: [RuntimePlugin(), GrpcPlugin({ basePath: '/grpc' })] }),
      async (app) => {
        const response = await app.fetch(
          new Request('http://localhost/grpc/no.Such/Method', { method: 'POST' }),
        );
        expect(response.status).toBe(404);
      },
    );
  });

  it('inject() reaches gRPC dispatch after M70a (kernel owns dispatch)', async () => {
    // After M70a, gRPC dispatch moved from the adapter interceptor into the
    // kernel terminal handler. Since inject() calls #handleRequest directly,
    // it now reaches the gRPC dispatch — the adapter bypass no longer applies.
    // Both fetch() and inject() exercise the same kernel code path for gRPC.
    await withApp(
      createApplication({ plugins: [RuntimePlugin(), GrpcPlugin()] }),
      async (app) => {
        const viaFetch = await app.fetch(
          new Request('http://localhost/grpc.health.v1.Health/Check', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ service: '' }),
          }),
        );
        expect(viaFetch.status).toBe(200);
        expect(await viaFetch.json()).toEqual({ status: 'SERVING' });

        // After M70a: inject() reaches the kernel terminal handler, which
        // dispatches gRPC via #tryGrpc. Both paths return the same result.
        const viaInject = await app.inject({
          method: 'POST',
          url: '/grpc.health.v1.Health/Check',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ service: '' }),
        });
        expect(viaInject.statusCode).toBe(200);
        expect(viaInject.json()).toEqual({ status: 'SERVING' });
      },
    );
  });

  it('registers a grpc health indicator reporting availability', async () => {
    await withApp(
      createApplication({ plugins: [RuntimePlugin(), GrpcPlugin()] }),
      async (app) => {
        const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
        expect(grpc.available).toBe(true);
        // The service is usable through the capability, end to end.
        const response = await app.fetch(
          new Request('http://localhost/grpc.health.v1.Health/Check', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ service: 'grpc.health.v1.Health' }),
          }),
        );
        expect(await response.json()).toEqual({ status: 'SERVING' });
      },
    );
  });
});
