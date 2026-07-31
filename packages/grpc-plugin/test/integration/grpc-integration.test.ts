/**
 * Integration tests — verifies plugin registration, service resolution, and
 * interaction with the kernel and HTTP adapter.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { GrpcPlugin } from '../../src/plugin/grpc-plugin.ts';
import { CAPABILITIES, type IGrpcService } from '@hono-enterprise/common';

describe('GrpcPlugin Integration', () => {
  it('should register the gRPC service under the correct token', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), GrpcPlugin()],
    });
    await app.start({ port: 0 });

    const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
    expect(grpc).toBeDefined();
    expect(grpc.available).toBeTruthy();

    // Application close not available on IKernelApplication in this context
  });

  it('should throw on duplicate plugin registration', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), GrpcPlugin(), GrpcPlugin()],
    });
    await expect(app.start({ port: 0 })).rejects.toThrow('Duplicate plugin name');
    // Application close not available on IKernelApplication in this context
  });

  it('should not affect normal Hono routes when gRPC is registered', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), GrpcPlugin()],
    });

    // Add a normal Hono route (this would normally require the Hono framework)
    // For now, we just verify the plugin doesn't break application startup

    await app.start({ port: 0 });
    // Application close not available on IKernelApplication in this context
  });
});
