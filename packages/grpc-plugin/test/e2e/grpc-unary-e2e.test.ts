/**
 * gRPC unary e2e test — serves a real gRPC/Connect RPC through the setRpcHandler?
 * seam end-to-end using the real Connect runtime and a REAL Protobuf-ES
 * DescService, asserting the decoded response BODY (not just status 200).
 *
 * Exercises the full path: plugin registration → Connect loading → service
 * registration → request handling → correct body serialization.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { GrpcPlugin } from '../../src/plugin/grpc-plugin.ts';
import { loadConnectModule } from '../../src/transports/connect-loader.ts';
import {
  CAPABILITIES,
  type GrpcServiceDefinition,
  type IGrpcService,
} from '@hono-enterprise/common';
import { ECHO_DESCRIPTOR_BASE64 } from '../fixtures/echo-descriptors.ts';

/**
 * Revives the example.EchoService DescService via the real Connect runtime.
 * A Protobuf-ES DescService is structurally a GrpcServiceDefinition
 * (`{ typeName, methods }`), so the cast is sound, not an escape hatch.
 */
async function reviveEchoService(): Promise<GrpcServiceDefinition> {
  const runtime = await loadConnectModule();
  const registry = runtime.reviveDescriptorSet(ECHO_DESCRIPTOR_BASE64);
  return runtime.getService(registry, 'example.EchoService') as GrpcServiceDefinition;
}

/** A unary impl that echoes the request message, matching EchoResponse{response}. */
const echoImpl = {
  echo: (req: { message: string }) => ({ response: `echo: ${req.message}` }),
  ping: () => ({ pong: true }),
};

describe('gRPC Unary E2E', () => {
  it('serves a real Connect unary RPC with the correct decoded body', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), GrpcPlugin()] });
    await app.start({ port: 0 });

    const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
    expect(grpc).toBeDefined();
    expect(grpc.available).toBeTruthy();

    const echoService = await reviveEchoService();
    grpc.addService(echoService, echoImpl);
    expect((grpc as unknown as { servicesCount: number }).servicesCount).toBe(1);

    const rpcRequest = new Request('http://localhost:0/grpc/example.EchoService/Echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello grpc' }),
    });
    const rpcResponse = await app.fetch(rpcRequest);
    expect(rpcResponse.status).toBe(200);
    // EXACT decoded body — the impl return value must appear verbatim.
    const body = await rpcResponse.json() as { response: string };
    expect(body).toEqual({ response: 'echo: hello grpc' });

    // Non-RPC request falls through to Hono (no route) → 404.
    const normalResponse = await app.fetch(
      new Request('http://localhost:0/health', { method: 'GET' }),
    );
    expect(normalResponse.status).toBe(404);

    await app.stop();
  });

  it('honors a custom basePath and returns the correct body', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), GrpcPlugin({ basePath: '/api/grpc' })],
    });
    await app.start({ port: 0 });

    const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
    grpc.addService(await reviveEchoService(), echoImpl);

    const rpcResponse = await app.fetch(
      new Request('http://localhost:0/api/grpc/example.EchoService/Echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'custom' }),
      }),
    );
    expect(rpcResponse.status).toBe(200);
    expect(await rpcResponse.json() as { response: string }).toEqual({ response: 'echo: custom' });

    // Outside the custom basePath → falls through → 404.
    const outside = await app.fetch(
      new Request('http://localhost:0/grpc/example.EchoService/Echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(outside.status).toBe(404);

    await app.stop();
  });

  it('does not register reflection or health when both are disabled', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), GrpcPlugin({ reflection: false, health: false })],
    });
    await app.start({ port: 0 });

    const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
    grpc.addService(await reviveEchoService(), echoImpl);

    // Health endpoint is NOT registered → unknown RPC path → 404.
    const healthResponse = await app.fetch(
      new Request('http://localhost:0/grpc/grpc.health.v1.Health/Check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(healthResponse.status).toBe(404);

    await app.stop();
  });
});
