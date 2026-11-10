/**
 * M139b at the plugin: native replies with trailers, the two dispatch entry
 * points agreeing under a non-default configuration, `streamsRequest`, the
 * transport-aware refusal, and `readMaxBytes` validation.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';

import type { GrpcServiceDefinition } from '@setu-ts/common';

import { GrpcPlugin } from '../../src/plugin/grpc-plugin.ts';
import { GrpcService } from '../../src/services/grpc-service.ts';
import { nativeGrpcReply } from '../../src/transports/native-grpc-reply.ts';
import { callFromRequest, responseFromReply } from '../../src/transports/rpc-call.ts';

/** A fetch `Request` as the kernel's call. */
const rpc = (request: Request) => callFromRequest(request, false);
import type { GrpcPluginOptions } from '../../src/interfaces/index.ts';
import {
  createFakeConnectRuntime,
  type FakeConnectRuntime,
  fakeFile,
  fakeService,
} from '../fixtures/fake-connect-runtime.ts';

const encoder = new TextEncoder();

describe('nativeGrpcReply', () => {
  it('streams the body and resolves the trailer after the last chunk', async () => {
    const trailer = new Headers();
    let trailerSetBeforeEnd = false;
    async function* body(): AsyncGenerator<Uint8Array> {
      yield encoder.encode('a');
      yield encoder.encode('b');
      trailer.set('grpc-status', '0');
      trailerSetBeforeEnd = true;
    }
    const reply = nativeGrpcReply({
      status: 200,
      header: new Headers({ 'content-type': 'application/grpc+proto' }),
      body: body(),
      trailer,
    });
    expect(reply.streaming).toBe(true);
    expect(reply.headers.get('content-type')).toBe('application/grpc+proto');
    expect(await responseFromReply(reply).text()).toBe('ab');
    expect(trailerSetBeforeEnd).toBe(true);
    expect((await reply.trailers!).get('grpc-status')).toBe('0');
  });

  it('a bodyless, trailerless response gives an empty body and empty trailers', async () => {
    const reply = nativeGrpcReply({ status: 200 });
    expect(await responseFromReply(reply).text()).toBe('');
    expect([...(await reply.trailers!).keys()]).toEqual([]);
  });

  it('an iterator that throws errors the body and rejects the trailers', async () => {
    async function* body(): AsyncGenerator<Uint8Array> {
      yield encoder.encode('a');
      throw new Error('transport broke');
    }
    const reply = nativeGrpcReply({ status: 200, body: body() });
    await expect(responseFromReply(reply).text()).rejects.toThrow('transport broke');
    await expect(reply.trailers).rejects.toThrow('transport broke');
  });

  it('a cancelled body returns the iterator and rejects the trailers', async () => {
    let returned = false;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: false, value: encoder.encode('x') }),
        return: () => {
          returned = true;
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    };
    const reply = nativeGrpcReply({ status: 200, body });
    await (reply.body as ReadableStream<Uint8Array>).cancel('client left');
    expect(returned).toBe(true);
    await expect(reply.trailers).rejects.toBe('client left');
  });

  it('a cancelled body without an iterator still rejects the trailers', async () => {
    const reply = nativeGrpcReply({ status: 200 });
    await (reply.body as ReadableStream<Uint8Array>).cancel('gone');
    await expect(reply.trailers).rejects.toBe('gone');
  });
});

const HEALTH = 'grpc.health.v1.Health';
const REFLECTION = 'grpc.reflection.v1.ServerReflection';

function runtime(): FakeConnectRuntime {
  return createFakeConnectRuntime({
    services: [
      fakeService(HEALTH, ['Check'], fakeFile('h.proto')),
      fakeService(REFLECTION, ['Info'], fakeFile('r.proto')),
    ],
    requestPaths: ['/p.S/Unary', '/p.S/Server', '/p.S/Bidi'],
    methodKinds: {
      '/p.S/Unary': 'unary',
      '/p.S/Server': 'server_streaming',
      '/p.S/Bidi': 'bidi_streaming',
    },
  });
}

function service(options: GrpcPluginOptions = {}, connect = runtime()): GrpcService {
  return new GrpcService({
    connectRuntime: connect,
    embeddedDescriptors: { healthBase64: btoa('h'), reflectionBase64: btoa('r') },
    options,
    healthService: undefined,
    // resolveLogger omitted: no logging.
  });
}

const native = (url: string): Request =>
  new Request(url, { method: 'POST', headers: { 'content-type': 'application/grpc' } });

describe('GrpcService — M139b', () => {
  it('handleRequest and handleRpc agree under a non-default configuration', async () => {
    const grpc = service({ basePath: '/rpc', readMaxBytes: 1024 });
    for (const path of ['/rpc/p.S/Unary', '/rpc/p.S/Server', '/rpc/p.S/Nope']) {
      const viaRequest = await grpc.handleRequest(
        new Request(`http://x${path}`, { method: 'POST' }),
      );
      const viaRpc = await grpc.handleRpc(
        await rpc(new Request(`http://x${path}`, { method: 'POST' })),
        {
          trailers: false,
        },
      );
      expect(viaRpc.status).toBe(viaRequest.status);
      expect(await responseFromReply(viaRpc).text()).toBe(await viaRequest.text());
      expect([...viaRpc.headers]).toEqual([...viaRequest.headers]);
    }
  });

  it('reports streaming replies exactly for response-streaming procedures', async () => {
    const grpc = service();
    const unary = await grpc.handleRpc(
      await rpc(new Request('http://x/p.S/Unary', { method: 'POST' })),
      {
        trailers: false,
      },
    );
    const server = await grpc.handleRpc(
      await rpc(new Request('http://x/p.S/Server', { method: 'POST' })),
      {
        trailers: false,
      },
    );
    expect(unary.streaming).toBe(false);
    expect(server.streaming).toBe(true);
  });

  it('serves native gRPC with trailers when the transport carries them, refuses otherwise', async () => {
    const grpc = service();
    expect(grpc.refuses(native('http://x/p.S/Unary'), { trailers: true })).toBeNull();
    expect(
      grpc.refuses(native('http://x/p.S/Unary'), { trailers: false })?.headers.get('grpc-status'),
    ).toBe('12');
    expect(grpc.refuses(native('http://x/p.S/Unary'))?.headers.get('grpc-status')).toBe('12');
    const reply = await grpc.handleRpc(await rpc(native('http://x/p.S/Unary')), { trailers: true });
    expect(await responseFromReply(reply).text()).toBe('universal:/p.S/Unary');
    expect((await reply.trailers!).get('grpc-status')).toBe('0');
  });

  it('streamsRequest is true only for client- and bidi-streaming procedures, and never once closed', () => {
    const grpc = service();
    expect(grpc.streamsRequest(new Request('http://x/p.S/Bidi'))).toBe(true);
    expect(grpc.streamsRequest(new Request('http://x/p.S/Unary'))).toBe(false);
    expect(grpc.streamsRequest(new Request('http://x/unknown'))).toBe(false);
    grpc.close();
    expect(grpc.streamsRequest(new Request('http://x/p.S/Bidi'))).toBe(false);
  });

  it('a closed service answers its own procedures 503 through both entry points', async () => {
    const grpc = service();
    grpc.close();
    const reply = await grpc.handleRpc(
      await rpc(new Request('http://x/p.S/Unary', { method: 'POST' })),
      {
        trailers: true,
      },
    );
    expect(reply.status).toBe(503);
    expect(reply.streaming).toBe(false);
    expect((await grpc.handleRequest(new Request('http://x/p.S/Unary'))).status).toBe(503);
    expect(await grpc.createFetchHandler()(new Request('http://x/elsewhere'))).toBeNull();
  });

  it('forwards the default 4 MiB readMaxBytes, or the configured one', () => {
    const defaults = runtime();
    service({}, defaults).streamsRequest(new Request('http://x/p.S/Unary'));
    expect(defaults.routerOptions[0]!['readMaxBytes']).toBe(4 * 1024 * 1024);
    const configured = runtime();
    service({ readMaxBytes: 1024 }, configured).streamsRequest(new Request('http://x/p.S/Unary'));
    expect(configured.routerOptions[0]!['readMaxBytes']).toBe(1024);
  });
});

describe('GrpcPlugin readMaxBytes validation', () => {
  it.each([0, -1, 1.5, Number.NaN, 0x1_0000_0000])('refuses %s at construction', (value) => {
    expect(() => GrpcPlugin({ readMaxBytes: value })).toThrow(TypeError);
  });

  it.each([1, 1024, 0xffffffff])('accepts %s', (value) => {
    expect(() => GrpcPlugin({ readMaxBytes: value })).not.toThrow();
  });

  it('keeps the descriptor type usable for addService', () => {
    const definition = fakeService(
      'a.B',
      ['C'],
      fakeFile('a.proto'),
    ) as unknown as GrpcServiceDefinition;
    const grpc = service();
    expect(() => grpc.addService(definition)).not.toThrow();
  });
});
