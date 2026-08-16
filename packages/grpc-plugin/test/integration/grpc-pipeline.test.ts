/**
 * Integration test: gRPC dispatch through the kernel pipeline (M70a).
 * Middleware applies to gRPC requests, auth middleware rejects unauthenticated
 * gRPC, and 503 is returned during drain.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { MiddlewareFunction } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { GrpcPlugin } from '../../src/plugin/grpc-plugin.ts';
import type { IGrpcService } from '@setu-ts/common';

describe('gRPC through kernel pipeline (M70a)', () => {
  it('middleware applies to gRPC requests', async () => {
    let middlewareRan = false;
    const trackingMiddleware: MiddlewareFunction = async (_ctx, next) => {
      middlewareRan = true;
      await next();
    };

    const app = createApplication({ plugins: [RuntimePlugin(), GrpcPlugin()] });
    app.middleware.add(trackingMiddleware);

    await app.start({ port: 0 });

    const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
    expect(grpc.available).toBe(true);

    // gRPC Health Check through fetch
    const response = await app.fetch(
      new Request('http://localhost/grpc/grpc.health.v1.Health/Check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ service: '' }),
      }),
    );

    expect(response.status).toBe(200);
    expect(middlewareRan).toBe(true);

    await app.stop();
  });

  it('auth middleware can reject unauthenticated gRPC', async () => {
    const authMiddleware: MiddlewareFunction = async (ctx, next) => {
      const auth = ctx.request.headers.get('authorization');
      if (auth === null || auth === '') {
        ctx.response.status(401).json({ error: 'Unauthorized' });
        return; // Short-circuit
      }
      await next();
    };

    const app = createApplication({ plugins: [RuntimePlugin(), GrpcPlugin()] });
    app.middleware.add(authMiddleware);

    await app.start({ port: 0 });

    // Unauthenticated gRPC request → 401
    const unauthResponse = await app.fetch(
      new Request('http://localhost/grpc/grpc.health.v1.Health/Check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ service: '' }),
      }),
    );
    expect(unauthResponse.status).toBe(401);

    // Authenticated gRPC request → 200
    const authResponse = await app.fetch(
      new Request('http://localhost/grpc/grpc.health.v1.Health/Check', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
        body: JSON.stringify({ service: '' }),
      }),
    );
    expect(authResponse.status).toBe(200);

    await app.stop();
  });

  it('leaves an ordinary 404 untouched outside basePath', async () => {
    // The plan's own negative control. `IGrpcService.handleRequest` returns
    // `Promise<Response>` and never `null`, so without the `claims()` prefix
    // guard the kernel hands EVERY unmatched route to gRPC and the whole
    // application's 404 changes from the kernel's JSON body to gRPC's
    // plain-text one. Measured before the guard existed:
    //   without grpc: {"error":"Not Found"}  application/json
    //   with grpc:    Not Found              text/plain
    const bare = createApplication({ plugins: [RuntimePlugin()] });
    await bare.start({ port: 0 });
    const control = await bare.fetch(new Request('http://localhost/nope'));
    const controlBody = await control.text();
    const controlType = control.headers.get('content-type');
    await bare.stop();

    const app = createApplication({ plugins: [RuntimePlugin(), GrpcPlugin()] });
    await app.start({ port: 0 });
    const withGrpc = await app.fetch(new Request('http://localhost/nope'));

    expect(withGrpc.status).toBe(404);
    expect(await withGrpc.text()).toBe(controlBody);
    expect(withGrpc.headers.get('content-type')).toBe(controlType);
    // Pinned literally too, so the test still discriminates if the kernel's own
    // 404 ever changes shape and the control moves with it.
    expect(controlBody).toBe('{"error":"Not Found"}');

    await app.stop();
  });

  it('does not claim a path merely prefixed by basePath', async () => {
    // `/grpcfoo` starts with `/grpc` but is not inside it. A bare `startsWith`
    // would shadow an ordinary application route.
    const app = createApplication({ plugins: [RuntimePlugin(), GrpcPlugin()] });
    await app.start({ port: 0 });

    const response = await app.fetch(new Request('http://localhost/grpcfoo'));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('{"error":"Not Found"}');

    await app.stop();
  });

  it('claims an unknown procedure inside basePath', async () => {
    // The other side of the guard: inside the base path, gRPC answers — which
    // is what makes the two tests above a real distinction rather than a
    // service that never claims anything.
    const app = createApplication({ plugins: [RuntimePlugin(), GrpcPlugin()] });
    await app.start({ port: 0 });

    const response = await app.fetch(
      new Request('http://localhost/grpc/pkg.Unknown/Method', { method: 'POST' }),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not Found');

    await app.stop();
  });

  it('dispatches under a catch-all route rather than letting SSR shadow it', async () => {
    // `react-router-plugin` mounts a catch-all on all seven verbs for SSR.
    // While gRPC was dispatched only when NOTHING matched, a full-stack
    // application answered every gRPC client with an HTML page. Protocol
    // dispatch runs before route matching.
    const app = createApplication({ plugins: [RuntimePlugin(), GrpcPlugin()] });
    app.router.get('/*', (ctx) => ctx.response.json({ ssr: true }));
    app.router.post('/*', (ctx) => ctx.response.json({ ssr: true }));
    await app.start({ port: 0 });

    const rpc = await app.fetch(
      new Request('http://localhost/grpc/grpc.health.v1.Health/Check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ service: '' }),
      }),
    );
    expect(rpc.status).toBe(200);
    expect(await rpc.text()).not.toContain('ssr');

    // The control: the catch-all still serves everything outside `basePath`.
    const page = await app.fetch(new Request('http://localhost/page'));
    expect(await page.text()).toBe('{"ssr":true}');

    await app.stop();
  });

  it('a root basePath claims only paths it can actually serve', async () => {
    // `basePath: '/'` normalizes to `''`, which CONTAINS every path. Since the
    // kernel consults `claims()` before route matching, a prefix test would
    // hand gRPC the whole application and 404 every ordinary route. At the root
    // the service claims only registered procedures — mirroring the asymmetry
    // `dispatchRequest` already documents.
    const app = createApplication({
      plugins: [RuntimePlugin(), GrpcPlugin({ basePath: '/' })],
    });
    app.router.get('/orders', (ctx) => ctx.response.json({ orders: [] }));
    await app.start({ port: 0 });

    const ordinary = await app.fetch(new Request('http://localhost/orders'));
    expect(ordinary.status).toBe(200);
    expect(await ordinary.text()).toBe('{"orders":[]}');

    const unmatched = await app.fetch(new Request('http://localhost/nope'));
    expect(unmatched.status).toBe(404);
    expect(await unmatched.text()).toBe('{"error":"Not Found"}');

    // The control: a real procedure at the root IS still served.
    const rpc = await app.fetch(
      new Request('http://localhost/grpc.health.v1.Health/Check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ service: '' }),
      }),
    );
    expect(rpc.status).toBe(200);

    await app.stop();
  });

  it('returns 503 during drain (X7-7)', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), GrpcPlugin()] });

    await app.start({ port: 0 });

    // Start shutdown (triggers drain)
    app.stop();

    // gRPC request during drain → 503
    const drainResponse = await app.fetch(
      new Request('http://localhost/grpc/grpc.health.v1.Health/Check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ service: '' }),
      }),
    );
    expect(drainResponse.status).toBe(503);
  });
});
