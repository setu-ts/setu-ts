/**
 * gRPC server-streaming e2e test — serves a real server-streaming RPC through
 * the setRpcHandler? seam end-to-end using the real Connect transport and
 * asserts the decoded streamed messages (not just status 200).
 *
 * Exercises the full path: plugin registration → Connect loading → service
 * registration → streaming request handling → correct body serialization.
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
 * Revives the example.StreamService DescService via the real Connect runtime.
 */
async function reviveStreamService(): Promise<GrpcServiceDefinition> {
  const runtime = await loadConnectModule();
  const registry = runtime.reviveDescriptorSet(ECHO_DESCRIPTOR_BASE64);
  return runtime.getService(registry, 'example.StreamService') as GrpcServiceDefinition;
}

/** A server-streaming impl that yields 3 items with predictable content. */
const streamImpl = {
  serverStream: async function* (req: { prefix: string }) {
    const prefix = req?.prefix ?? 'item';
    for (let i = 0; i < 3; i++) {
      yield { message: `${prefix}-${i}` };
    }
  },
};

/**
 * Encodes a message in Connect envelope format:
 * 1-byte compression flag (0 = none) + 4-byte big-endian length + payload
 */
function encodeConnectEnvelope(message: string): Uint8Array {
  const payload = new TextEncoder().encode(message);
  const envelope = new Uint8Array(5 + payload.length);
  // Compression flag = 0 (no compression)
  envelope[0] = 0;
  // Length as 4-byte big-endian
  envelope[1] = (payload.length >> 24) & 0xff;
  envelope[2] = (payload.length >> 16) & 0xff;
  envelope[3] = (payload.length >> 8) & 0xff;
  envelope[4] = payload.length & 0xff;
  // Payload
  envelope.set(payload, 5);
  return envelope;
}

/**
 * Parses Connect-ES framed messages from a Uint8Array.
 * Connect uses: 1-byte compression flag + 4-byte big-endian length + payload
 */
function parseConnectMessages(data: Uint8Array): string[] {
  const messages: string[] = [];
  let offset = 0;

  while (offset + 5 <= data.length) {
    // Skip compression flag byte
    const flags = data[offset];
    // Read 4-byte big-endian length
    const length = (data[offset + 1] << 24) |
      (data[offset + 2] << 16) |
      (data[offset + 3] << 8) |
      data[offset + 4];

    if (offset + 5 + length > data.length) break;

    const payload = data.slice(offset + 5, offset + 5 + length);
    const text = new TextDecoder().decode(payload);

    // Only collect non-error frames (flags === 0)
    if (flags === 0) {
      messages.push(text);
    }

    offset += 5 + length;
  }

  return messages;
}

describe('gRPC Server Streaming E2E', () => {
  it('serves a real Connect server-streaming RPC with correct decoded content', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), GrpcPlugin()] });
    await app.start({ port: 0 });

    const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
    expect(grpc).toBeDefined();
    expect(grpc.available).toBeTruthy();

    const streamService = await reviveStreamService();
    grpc.addService(streamService, streamImpl);

    // Server-streaming over Connect uses POST with application/connect+json
    // The request body must be enveloped: 1-byte flag + 4-byte length + JSON payload
    const requestBody = JSON.stringify({ prefix: 'item' });
    const envelopedRequest = encodeConnectEnvelope(requestBody);

    const rpcRequest = new Request('http://localhost:0/grpc/example.StreamService/ServerStream', {
      method: 'POST',
      headers: { 'content-type': 'application/connect+json' },
      body: envelopedRequest as unknown as BodyInit,
    });
    const rpcResponse = await app.fetch(rpcRequest);
    expect(rpcResponse.status).toBe(200);

    // Read the streaming response body as raw bytes
    const data = await rpcResponse.arrayBuffer();
    const uint8 = new Uint8Array(data);

    // Parse Connect-ES framed messages
    const messages: { message: string }[] = [];
    const rawMessages = parseConnectMessages(uint8);

    for (const raw of rawMessages) {
      try {
        // Try parsing as { response: { message: ... } }
        const parsed = JSON.parse(raw) as { response?: { message?: string } };
        if (parsed.response?.message) {
          messages.push({ message: parsed.response.message });
        } else {
          // Try direct message format
          const direct = JSON.parse(raw) as { message?: string };
          if (direct.message) {
            messages.push({ message: direct.message });
          }
        }
      } catch {
        // Ignore JSON parse errors
      }
    }

    // ASSERT: the client receives the expected message count (3)
    expect(messages.length).toBe(3);

    // ASSERT: each message's decoded content equals the expected literal
    expect(messages[0]).toEqual({ message: 'item-0' });
    expect(messages[1]).toEqual({ message: 'item-1' });
    expect(messages[2]).toEqual({ message: 'item-2' });

    // ASSERT: the stream completes with success status (no error thrown above)
    expect(rpcResponse.ok).toBeTruthy();

    await app.stop();
  });

  it('returns a stream when the impl yields items', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), GrpcPlugin()] });
    await app.start({ port: 0 });

    const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
    grpc.addService(await reviveStreamService(), {
      serverStream: async function* (req: { prefix: string }) {
        const prefix = req?.prefix ?? 'test';
        // Yield exactly one item
        yield { message: `${prefix}-done` };
      },
    });

    const requestBody = JSON.stringify({ prefix: 'test' });
    const envelopedRequest = encodeConnectEnvelope(requestBody);

    const rpcRequest = new Request('http://localhost:0/grpc/example.StreamService/ServerStream', {
      method: 'POST',
      headers: { 'content-type': 'application/connect+json' },
      body: envelopedRequest as unknown as BodyInit,
    });
    const rpcResponse = await app.fetch(rpcRequest);
    expect(rpcResponse.status).toBe(200);

    const data = await rpcResponse.arrayBuffer();
    const uint8 = new Uint8Array(data);
    const rawMessages = parseConnectMessages(uint8);

    // ASSERT: stream yields exactly 1 message
    expect(rawMessages.length).toBe(1);

    await app.stop();
  });
});
