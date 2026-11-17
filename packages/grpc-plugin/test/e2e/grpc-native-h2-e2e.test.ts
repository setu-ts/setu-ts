/**
 * M139b §3.6 end to end: a real kernel application on `RuntimePlugin({ http2:
 * true })` serves native `application/grpc` to a real native client
 * (`@connectrpc/connect-node`'s gRPC transport) — unary, server streaming
 * delivered as sent, statuses in trailers, and the plugin's own bidirectional
 * reflection — while HTTP/1.1 Connect traffic on the same port keeps working
 * and native gRPC over HTTP/1.1 keeps its refusal.
 *
 * @module
 */
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import type { Client } from '@connectrpc/connect';
import { createConnectTransport, createGrpcTransport } from '@connectrpc/connect-node';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import type { GrpcServiceDefinition } from '@setu-ts/common';

import { GrpcPlugin } from '../../src/plugin/grpc-plugin.ts';
import { loadConnectModule } from '../../src/transports/connect-loader.ts';
import { EmbeddedDescriptors } from '../../src/descriptors/embedded-descriptors.ts';
import { ECHO_DESCRIPTOR_BASE64 } from '../fixtures/echo-descriptors.ts';

const describeNode = describe.skipIf(typeof Deno !== 'undefined');

/** A port nothing is bound to, found by binding 0 and releasing it. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Revives one service from an embedded descriptor set through the real runtime. */
async function revive(base64: string, name: string): Promise<GrpcServiceDefinition> {
  const runtime = await loadConnectModule();
  return runtime.getService(runtime.reviveDescriptorSet(base64), name) as GrpcServiceDefinition;
}

// Connect's generic client typing needs a generated descriptor; these are
// revived at run time, so the clients are driven through a narrow view.
interface EchoClient {
  echo(request: { message: string }): Promise<{ response: string }>;
}
interface StreamClient {
  serverStream(request: { prefix: string }): AsyncIterable<{ message: string }>;
}
interface ReflectionClient {
  serverReflectionInfo(
    requests: AsyncIterable<{ messageRequest: { case: 'listServices'; value: string } }>,
  ): AsyncIterable<{
    messageResponse: { case: string; value: { service?: { name: string }[] } };
  }>;
}

let app: IKernelApplication | undefined;
/** Resolved by the test to let the server stream yield its second message. */
let releaseSecond: (() => void) | undefined;

afterEach(async () => {
  await app?.stop();
  app = undefined;
});

async function start(): Promise<{ port: number; base: string }> {
  const echo = await revive(ECHO_DESCRIPTOR_BASE64, 'example.EchoService');
  const stream = await revive(ECHO_DESCRIPTOR_BASE64, 'example.StreamService');
  app = createApplication({
    plugins: [
      RuntimePlugin({ http2: true }),
      GrpcPlugin({
        services: [
          {
            definition: echo,
            implementation: {
              echo: (request: { message: string }) => {
                if (request.message === 'deny') {
                  throw new ConnectError('not you', Code.PermissionDenied);
                }
                return { response: `echo: ${request.message}` };
              },
              ping: () => ({ pong: true }),
            },
          },
          {
            definition: stream,
            implementation: {
              serverStream: async function* (request: { prefix: string }) {
                yield { message: `${request.prefix}-0` };
                if (request.prefix === 'fail') {
                  throw new ConnectError('stopped mid-stream', Code.Aborted);
                }
                // Holds until the client has READ the first message: a server
                // that buffered the stream would never deliver it.
                await new Promise<void>((resolve) => (releaseSecond = resolve));
                yield { message: `${request.prefix}-1` };
              },
            },
          },
        ],
      }),
    ],
  });
  const port = await freePort();
  await app.start({ port, hostname: '127.0.0.1' });
  return { port, base: `http://127.0.0.1:${port}` };
}

describeNode('native gRPC over HTTP/2 (M139b)', () => {
  it('answers a unary call, and a non-zero status, to a native client', async () => {
    const { base } = await start();
    const echo = await revive(ECHO_DESCRIPTOR_BASE64, 'example.EchoService');
    const client = createClient(
      echo as never,
      createGrpcTransport({ baseUrl: base }),
    ) as unknown as EchoClient;
    expect(await client.echo({ message: 'hi' })).toMatchObject({ response: 'echo: hi' });
    await expect(client.echo({ message: 'deny' })).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
  });

  it('delivers server-stream messages as they are sent, and a mid-stream status in trailers', async () => {
    const { base } = await start();
    const definition = await revive(ECHO_DESCRIPTOR_BASE64, 'example.StreamService');
    const client = createClient(
      definition as never,
      createGrpcTransport({ baseUrl: base }),
    ) as unknown as StreamClient;
    const received: string[] = [];
    for await (const message of client.serverStream({ prefix: 'ok' })) {
      received.push(message.message);
      releaseSecond?.();
    }
    expect(received).toEqual(['ok-0', 'ok-1']);

    const partial: string[] = [];
    const failing = (async () => {
      for await (const message of client.serverStream({ prefix: 'fail' })) {
        partial.push(message.message);
      }
    })();
    await expect(failing).rejects.toMatchObject({ code: Code.Aborted });
    expect(partial).toEqual(['fail-0']);
  });

  it('serves the bidirectional reflection service over native gRPC and over Connect', async () => {
    const { base } = await start();
    const reflection = await revive(
      EmbeddedDescriptors.reflectionBase64,
      'grpc.reflection.v1.ServerReflection',
    );
    for (const transport of [
      createGrpcTransport({ baseUrl: base }),
      createConnectTransport({ baseUrl: base, httpVersion: '2' }),
    ]) {
      const client = createClient(reflection as never, transport) as unknown as ReflectionClient;
      // The second request is sent only after the first answer arrived: this
      // completes only when the request body streams in while the reply flows.
      let answered!: () => void;
      const firstAnswer = new Promise<void>((resolve) => (answered = resolve));
      const requests = async function* (): AsyncGenerator<{
        messageRequest: { case: 'listServices'; value: string };
      }> {
        yield { messageRequest: { case: 'listServices', value: '' } };
        await firstAnswer;
        yield { messageRequest: { case: 'listServices', value: '' } };
      };
      const names: string[][] = [];
      for await (const response of client.serverReflectionInfo(requests())) {
        names.push((response.messageResponse.value.service ?? []).map((s) => s.name));
        answered();
      }
      expect(names).toHaveLength(2);
      expect(names[0]).toContain('example.EchoService');
      expect(names[0]).toContain('grpc.reflection.v1.ServerReflection');
    }
  });

  it('keeps HTTP/1.1 Connect working on the same port, and refuses native gRPC there', async () => {
    const { base } = await start();
    const connect = await fetch(`${base}/example.EchoService/Echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'h1' }),
    });
    expect(await connect.json()).toEqual({ response: 'echo: h1' });

    const native = await fetch(`${base}/example.EchoService/Echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/grpc' },
      body: new Uint8Array([0, 0, 0, 0, 0]),
    });
    expect(native.headers.get('grpc-status')).toBe('12');
  });

  it('keeps a Connect client typed client usable over HTTP/2', async () => {
    const { base } = await start();
    const echo = await revive(ECHO_DESCRIPTOR_BASE64, 'example.EchoService');
    const client: Client<never> = createClient(
      echo as never,
      createConnectTransport({ baseUrl: base, httpVersion: '2' }),
    );
    expect(await (client as unknown as EchoClient).echo({ message: 'c2' })).toMatchObject({
      response: 'echo: c2',
    });
  });
});
