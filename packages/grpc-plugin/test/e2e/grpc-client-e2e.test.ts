/**
 * M139b §3.12 end to end: one kernel application serves gRPC under `/grpc` on
 * `RuntimePlugin({ http2: true })`; a second, registering
 * `GrpcPlugin({ serve: false })` and real static service discovery, calls it
 * through `grpcClient()` — unary and server streaming over Connect and native
 * gRPC, an unreachable instance ejected after one refused call, and calls after
 * the caller stops refused.
 *
 * @module
 */
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Code, ConnectError } from '@connectrpc/connect';
import { CAPABILITIES } from '@setu-ts/common';
import type { GrpcServiceDefinition, IServiceDiscovery } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ServiceDiscoveryPlugin } from '@setu-ts/service-discovery-plugin';

import { grpcClient } from '../../src/client/grpc-client-helper.ts';
import { GrpcPlugin } from '../../src/plugin/grpc-plugin.ts';
import { loadConnectModule } from '../../src/transports/connect-loader.ts';
import { ECHO_DESCRIPTOR_BASE64 } from '../fixtures/echo-descriptors.ts';

const describeNode = describe.skipIf(typeof Deno !== 'undefined');

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

// Revived at run time, so the clients are driven through a narrow view.
interface EchoClient {
  echo(request: { message: string }): Promise<{ response: string }>;
}
interface StreamClient {
  serverStream(request: { prefix: string }): AsyncIterable<{ message: string }>;
}

/** The error a call rejects with; a call that answers fails the test. */
function failure(call: Promise<unknown>): Promise<ConnectError> {
  return call.then(
    () => {
      throw new Error('the call answered');
    },
    (error: unknown) => ConnectError.from(error),
  );
}

const apps: IKernelApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function definitions(): Promise<{
  echo: GrpcServiceDefinition;
  stream: GrpcServiceDefinition;
}> {
  const runtime = await loadConnectModule();
  const registry = runtime.reviveDescriptorSet(ECHO_DESCRIPTOR_BASE64);
  return {
    echo: runtime.getService(registry, 'example.EchoService') as GrpcServiceDefinition,
    stream: runtime.getService(registry, 'example.StreamService') as GrpcServiceDefinition,
  };
}

/** The serving member: echo and a three-message stream, under `/grpc`, on h2c. */
async function startServer(): Promise<number> {
  const { echo, stream } = await definitions();
  const app = createApplication({
    plugins: [
      RuntimePlugin({ http2: true }),
      GrpcPlugin({
        basePath: '/grpc',
        services: [
          {
            definition: echo,
            implementation: {
              echo: (request: { message: string }, context: { requestHeader: Headers }) => ({
                response: `echo: ${request.message} via ${context.requestHeader.get('content-type')}`,
              }),
              ping: () => ({}),
            },
          },
          {
            definition: stream,
            implementation: {
              serverStream: async function* (request: { prefix: string }) {
                for (let i = 0; i < 3; i++) yield { message: `${request.prefix}-${i}` };
              },
            },
          },
        ],
      }),
    ],
  });
  const port = await freePort();
  await app.start({ port, hostname: '127.0.0.1' });
  apps.push(app);
  return port;
}

/** The calling member: no gRPC mount, static discovery for `echo`. */
async function startCaller(instances: { id: string; port: number }[]): Promise<IKernelApplication> {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      ServiceDiscoveryPlugin({
        provider: 'static',
        services: { echo: instances.map((i) => ({ ...i, host: '127.0.0.1' })) },
        ejection: {
          failureThreshold: 1,
          windowMs: 60_000,
          durationMs: 60_000,
          maxEjectionPercent: 100,
        },
      }),
      GrpcPlugin({ serve: false, clients: { echo: { basePath: '/grpc' } } }),
    ],
  });
  await app.start({ port: await freePort(), hostname: '127.0.0.1' });
  apps.push(app);
  return app;
}

describeNode('grpcClient — a member calling another through the plugin', () => {
  it('calls unary and streaming procedures over Connect and native gRPC', async () => {
    const port = await startServer();
    const caller = await startCaller([{ id: 'live', port }]);
    const { echo, stream } = await definitions();

    const connect = grpcClient(caller.services, echo as never, 'echo') as unknown as EchoClient;
    expect((await connect.echo({ message: 'hi' })).response).toBe('echo: hi via application/proto');

    const native = grpcClient(caller.services, echo as never, 'echo', {
      protocol: 'grpc',
    }) as unknown as EchoClient;
    expect((await native.echo({ message: 'hi' })).response).toBe(
      'echo: hi via application/grpc+proto',
    );

    const streaming = grpcClient(
      caller.services,
      stream as never,
      'echo',
    ) as unknown as StreamClient;
    const messages: string[] = [];
    for await (const m of streaming.serverStream({ prefix: 's' })) messages.push(m.message);
    expect(messages).toEqual(['s-0', 's-1', 's-2']);

    // The same arguments give the same client.
    expect(grpcClient(caller.services, echo as never, 'echo')).toBe(connect);
  });

  it('ejects an instance that refuses connections after one failed call', async () => {
    const port = await startServer();
    const dead = await freePort();
    const caller = await startCaller([
      { id: 'dead', port: dead },
      { id: 'live', port },
    ]);
    const { echo } = await definitions();
    const client = grpcClient(caller.services, echo as never, 'echo') as unknown as EchoClient;
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i++) {
      outcomes.push(
        await client.echo({ message: String(i) }).then(
          () => 'ok',
          (e: unknown) => Code[ConnectError.from(e).code]!,
        ),
      );
    }
    // At most the first call can reach the dead instance; it is ejected after it.
    expect(outcomes.slice(2)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(outcomes.filter((o) => o !== 'ok')).toEqual(
      outcomes.includes('Unavailable') ? ['Unavailable'] : [],
    );
    const discovery = caller.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);
    expect((await discovery.pick('echo'))?.id).toBe('live');
  });

  it('answers Unavailable when no instance is known, and after the caller stops', async () => {
    const caller = await startCaller([]);
    const { echo } = await definitions();
    const client = grpcClient(caller.services, echo as never, 'echo') as unknown as EchoClient;
    const none = await failure(client.echo({ message: 'x' }));
    expect([Code[none.code], none.rawMessage]).toEqual([
      'Unavailable',
      'no instance of "echo" is available',
    ]);

    const port = await startServer();
    const url = grpcClient(
      caller.services,
      echo as never,
      `http://127.0.0.1:${port}/grpc`,
    ) as unknown as EchoClient;
    expect((await url.echo({ message: 'direct' })).response).toBe(
      'echo: direct via application/proto',
    );
    await caller.stop();
    apps.splice(apps.indexOf(caller), 1);
    const closed = await failure(url.echo({ message: 'x' }));
    expect([Code[closed.code], closed.rawMessage]).toEqual([
      'Unavailable',
      'the gRPC client is closed',
    ]);
  });
});
