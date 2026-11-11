/**
 * M139b §3.13 end to end: a decorated caller with the DI container takes the
 * plugin's client by injection. `grpcClientProvider` in `@Module({ providers })`
 * registers it; a service `@Inject`s it; a controller route calls a real
 * gRPC server through it, resolved by real service discovery.
 *
 * @module
 */
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { DescService } from '@bufbuild/protobuf';
import { CAPABILITIES } from '@setu-ts/common';
import type { GrpcServiceDefinition, IContainer } from '@setu-ts/common';
import {
  Controller,
  DecoratorPlugin,
  Get,
  Inject,
  Injectable,
  Module,
  metadataStore,
} from '@setu-ts/decorator-plugin';
import { DiPlugin } from '@setu-ts/di-plugin';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ServiceDiscoveryPlugin } from '@setu-ts/service-discovery-plugin';

import { grpcClient, grpcClientProvider } from '../../src/client/grpc-client-helper.ts';
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

const apps: IKernelApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  metadataStore.clear();
});

async function echoService(): Promise<DescService> {
  const runtime = await loadConnectModule();
  return runtime.getService(
    runtime.reviveDescriptorSet(ECHO_DESCRIPTOR_BASE64),
    'example.EchoService',
  ) as unknown as DescService;
}

/** The serving member: echo under `/grpc`, on h2c. */
async function startServer(echo: DescService): Promise<number> {
  const app = createApplication({
    plugins: [
      RuntimePlugin({ http2: true }),
      GrpcPlugin({
        basePath: '/grpc',
        services: [
          {
            definition: echo as unknown as GrpcServiceDefinition,
            implementation: {
              echo: (request: { message: string }) => ({ response: `echo: ${request.message}` }),
              ping: () => ({}),
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

const ECHO_CLIENT = 'echo.client';

describeNode('grpcClientProvider — the client by injection', () => {
  it('a decorated service injects the client and a route calls a real server through it', async () => {
    const echo = await echoService();
    const port = await startServer(echo);

    // Revived at run time, so the injected client is driven through a narrow view.
    interface EchoClient {
      echo(request: { message: string }): Promise<{ response: string }>;
    }

    @Injectable({ token: 'quotes' })
    @Inject(ECHO_CLIENT)
    class QuoteService {
      constructor(readonly client: EchoClient) {}

      async quote(message: string): Promise<string> {
        return (await this.client.echo({ message })).response;
      }
    }

    @Controller('/quotes')
    @Inject('quotes')
    class QuoteController {
      constructor(readonly quotes: QuoteService) {}

      @Get('/')
      async index(): Promise<{ answer: string }> {
        return { answer: await this.quotes.quote('by injection') };
      }
    }

    @Module({
      controllers: [QuoteController],
      providers: [QuoteService, grpcClientProvider(ECHO_CLIENT, echo, 'echo')],
    })
    class QuoteModule {}

    const caller = createApplication({
      plugins: [
        RuntimePlugin(),
        DiPlugin(),
        ServiceDiscoveryPlugin({
          provider: 'static',
          services: { echo: [{ host: '127.0.0.1', port }] },
        }),
        GrpcPlugin({ serve: false, clients: { echo: { basePath: '/grpc' } } }),
        DecoratorPlugin({ modules: [QuoteModule] }),
      ],
    });
    await caller.start({ port: await freePort(), hostname: '127.0.0.1' });
    apps.push(caller);

    const response = await caller.inject({ method: 'GET', url: '/quotes' });
    expect([response.statusCode, response.json()]).toEqual([200, { answer: 'echo: by injection' }]);

    // One client, whichever way it is asked for: the container's singleton is
    // the plugin's cached client for the same (definition, target, options).
    const container = caller.services.get<IContainer>(CAPABILITIES.DI_CONTAINER);
    expect(container.resolve(ECHO_CLIENT)).toBe(grpcClient(caller.services, echo, 'echo'));
  });

  it('refuses a bad option where the module is declared, not on first injection', async () => {
    const echo = await echoService();
    expect(() => grpcClientProvider(ECHO_CLIENT, echo, 'echo', { timeoutMs: 0 })).toThrow(
      new TypeError(
        'grpcClientProvider: timeoutMs must be an integer from 1 to 2147483647, received 0',
      ),
    );
    expect(() => grpcClientProvider(ECHO_CLIENT, echo, 'ftp://echo')).toThrow(
      new TypeError('grpc client: target URL must be http or https, received ftp:'),
    );
  });
});
