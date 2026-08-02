/**
 * End-to-end reflection and health, through a REAL kernel application, the REAL
 * Connect runtime and the REAL adapter seam.
 *
 * Every assertion here is unconditional. An earlier revision guarded its checks
 * behind `if (parsed…)` and asserted only "not UNIMPLEMENTED", which passed
 * while the service returned an empty body — the defect this file exists to
 * catch.
 *
 * RPC is driven through `app.fetch`, never `inject()`: `inject()` synthesizes an
 * `IRequest` and calls the kernel handler directly, so it never reaches the
 * adapter seam the interceptor lives on.
 */

import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { GrpcPlugin } from '../../src/plugin/grpc-plugin.ts';
import { loadConnectModule } from '../../src/transports/connect-loader.ts';
import {
  CAPABILITIES,
  type GrpcServiceDefinition,
  type IGrpcService,
  type IHealthService,
} from '@hono-enterprise/common';
import { ECHO_DESCRIPTOR_BASE64 } from '../fixtures/echo-descriptors.ts';

const REFLECTION_PATH = '/grpc/grpc.reflection.v1.ServerReflection/ServerReflectionInfo';
const HEALTH_PATH = '/grpc/grpc.health.v1.Health/Check';

/** Frames a JSON payload into a Connect streaming envelope. */
function envelope(payload: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const framed = new Uint8Array(5 + body.length);
  new DataView(framed.buffer).setUint32(1, body.length);
  framed.set(body, 5);
  return framed;
}

/** Decodes every non-trailer envelope in a Connect streaming response. */
function unframe(bytes: Uint8Array): unknown[] {
  const messages: unknown[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 5 <= bytes.length) {
    const flags = view.getUint8(offset);
    const length = view.getUint32(offset + 1);
    const payload = bytes.slice(offset + 5, offset + 5 + length);
    // Bit 1 marks the end-of-stream trailer frame.
    if ((flags & 0b10) === 0) {
      messages.push(JSON.parse(new TextDecoder().decode(payload)));
    }
    offset += 5 + length;
  }
  return messages;
}

/** Sends one reflection request and returns the decoded responses. */
async function reflect(
  app: ReturnType<typeof createApplication>,
  request: Record<string, unknown>,
): Promise<Record<string, never>[]> {
  const response = await app.fetch(
    new Request(`http://localhost${REFLECTION_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/connect+json' },
      body: envelope(request) as unknown as BodyInit,
    }),
  );
  expect(response.status).toBe(200);
  return unframe(new Uint8Array(await response.arrayBuffer())) as Record<string, never>[];
}

describe('gRPC reflection and health E2E', () => {
  let app: ReturnType<typeof createApplication>;

  beforeEach(async () => {
    app = createApplication({ plugins: [RuntimePlugin(), GrpcPlugin()] });
    await app.start({ port: 0 });

    const runtime = await loadConnectModule();
    const echo = runtime.getService(
      runtime.reviveDescriptorSet(ECHO_DESCRIPTOR_BASE64),
      'example.EchoService',
    );
    app.services.get<IGrpcService>(CAPABILITIES.GRPC).addService(
      echo as unknown as GrpcServiceDefinition,
      {
        echo: (request: { message: string }) => ({ response: `echo: ${request.message}` }),
        ping: () => ({ pong: true }),
      },
    );
  });

  afterEach(async () => {
    await app.stop();
  });

  describe('list_services', () => {
    it('lists the application service and both built-ins', async () => {
      const [response] = await reflect(app, { listServices: '' });
      const names = (response.listServicesResponse as unknown as {
        service: { name: string }[];
      }).service.map((s) => s.name);

      expect(names).toContain('example.EchoService');
      expect(names).toContain('grpc.health.v1.Health');
      expect(names).toContain('grpc.reflection.v1.ServerReflection');
    });

    it('echoes the original request alongside the answer', async () => {
      const [response] = await reflect(app, { listServices: '' });
      expect(response.originalRequest).toEqual({ listServices: '' });
    });
  });

  describe('file_containing_symbol', () => {
    it('returns real FileDescriptorProto bytes for a registered service', async () => {
      const [response] = await reflect(app, { fileContainingSymbol: 'example.EchoService' });
      const files = (response.fileDescriptorResponse as unknown as {
        fileDescriptorProto: string[];
      }).fileDescriptorProto;

      expect(files).toHaveLength(1);
      // JSON encodes `bytes` as base64; a non-empty payload is the whole point.
      expect(files[0].length).toBeGreaterThan(0);
      const decoded = atob(files[0]);
      expect(decoded).toContain('echo.proto');
      expect(decoded).toContain('EchoService');
    });

    it('resolves a message symbol, not only a service', async () => {
      const [response] = await reflect(app, { fileContainingSymbol: 'example.EchoRequest' });
      expect(response.fileDescriptorResponse).toBeDefined();
    });

    it('answers NOT_FOUND for an unknown symbol', async () => {
      const [response] = await reflect(app, { fileContainingSymbol: 'no.Such.Symbol' });
      expect(response.errorResponse).toEqual({
        errorCode: 5,
        errorMessage: 'symbol not found: no.Such.Symbol',
      });
    });
  });

  describe('file_by_filename', () => {
    it('returns the descriptor for a known proto path', async () => {
      const [response] = await reflect(app, { fileByFilename: 'echo.proto' });
      const files = (response.fileDescriptorResponse as unknown as {
        fileDescriptorProto: string[];
      }).fileDescriptorProto;
      expect(atob(files[0])).toContain('EchoService');
    });

    it('answers NOT_FOUND for an unknown filename', async () => {
      const [response] = await reflect(app, { fileByFilename: 'absent.proto' });
      expect((response.errorResponse as unknown as { errorCode: number }).errorCode).toBe(5);
    });
  });

  describe('extensions', () => {
    it('answers an empty extension list for a known, extension-free type', async () => {
      const [response] = await reflect(app, { allExtensionNumbersOfType: 'example.EchoRequest' });
      expect(response.allExtensionNumbersResponse).toEqual({
        baseTypeName: 'example.EchoRequest',
      });
    });

    it('answers UNIMPLEMENTED for file_containing_extension', async () => {
      const [response] = await reflect(app, {
        fileContainingExtension: { containingType: 'example.EchoRequest', extensionNumber: 1001 },
      });
      expect((response.errorResponse as unknown as { errorCode: number }).errorCode).toBe(12);
    });
  });

  describe('Health/Check', () => {
    async function check(service: string): Promise<{ status?: string }> {
      const response = await app.fetch(
        new Request(`http://localhost${HEALTH_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ service }),
        }),
      );
      expect(response.status).toBe(200);
      return await response.json();
    }

    it('answers SERVING for the whole server with no health plugin', async () => {
      expect(await check('')).toEqual({ status: 'SERVING' });
    });

    it('answers SERVING for a service the server actually serves', async () => {
      expect(await check('example.EchoService')).toEqual({ status: 'SERVING' });
    });

    it('answers SERVICE_UNKNOWN for a service it does not serve', async () => {
      expect(await check('no.Such.Service')).toEqual({ status: 'SERVICE_UNKNOWN' });
    });
  });
});

describe('gRPC health bridged to a registered health capability', () => {
  let app: ReturnType<typeof createApplication>;
  let reported: 'up' | 'down';

  beforeEach(async () => {
    reported = 'up';
    const healthPlugin = {
      name: 'fake-health',
      version: '1.0.0',
      provides: [CAPABILITIES.HEALTH],
      register(ctx: { services: { register: (t: string, s: unknown) => void } }) {
        ctx.services.register(CAPABILITIES.HEALTH, {
          check: () => Promise.resolve({ status: reported, info: {}, details: {} }),
        } as unknown as IHealthService);
      },
    };

    app = createApplication({
      // deno-lint-ignore no-explicit-any
      plugins: [RuntimePlugin(), healthPlugin as any, GrpcPlugin()],
    });
    await app.start({ port: 0 });
  });

  afterEach(async () => {
    await app.stop();
  });

  async function checkServer(): Promise<{ status?: string }> {
    const response = await app.fetch(
      new Request(`http://localhost${HEALTH_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ service: '' }),
      }),
    );
    return await response.json();
  }

  it('reports SERVING while the application is up', async () => {
    expect(await checkServer()).toEqual({ status: 'SERVING' });
  });

  it('reports NOT_SERVING once the health report goes down', async () => {
    reported = 'down';
    expect(await checkServer()).toEqual({ status: 'NOT_SERVING' });
  });
});
