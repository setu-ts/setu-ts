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
