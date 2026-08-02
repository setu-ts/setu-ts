/**
 * Contract tests for the gRPC types added in Milestone 49.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, createCapabilityToken } from '../../src/tokens.ts';
import type {
  GrpcServiceDefinition,
  GrpcServingStatus,
  RpcFetchHandler,
} from '../../src/services/grpc.ts';

describe('gRPC contract', () => {
  it('CAPABILITIES.GRPC equals "grpc" and survives the token grammar', () => {
    expect(CAPABILITIES.GRPC).toBe('grpc');
    // Colons are illegal in the committed grammar; one lowercase segment is not.
    expect(createCapabilityToken(CAPABILITIES.GRPC)).toBe('grpc');
  });

  it('GrpcServingStatus covers the four gRPC Health v1 enum states', () => {
    const values: GrpcServingStatus[] = ['unknown', 'serving', 'not-serving', 'service-unknown'];
    expect(values).toHaveLength(4);
    expect(new Set(values).size).toBe(4);
  });

  it('RpcFetchHandler accepts a Request and resolves Response | null', async () => {
    const handled: RpcFetchHandler = (request) => Promise.resolve(new Response(request.url));
    const fellThrough: RpcFetchHandler = () => Promise.resolve(null);

    expect((await handled(new Request('http://x/grpc/a.B/C')))?.status).toBe(200);
    expect(await fellThrough(new Request('http://x/users'))).toBeNull();
  });

  it('constrains on `method` (the record), not `methods` (the array)', () => {
    // A Protobuf-ES DescService exposes BOTH: `methods` is an ARRAY, which is
    // not assignable to Record<string, T>, and `method` is the record keyed by
    // local name. Constraining on `methods` would reject every real generated
    // descriptor and force callers into a cast.
    const definition: GrpcServiceDefinition = {
      typeName: 'test.Service',
      method: { check: { name: 'Check' } },
    };
    expect(definition.typeName).toBe('test.Service');
    expect(Object.keys(definition.method)).toEqual(['check']);
  });

  it('accepts a descriptor-shaped object carrying both `method` and `methods`', () => {
    // The shape a real DescService presents. It must satisfy the constraint
    // with no cast; excess properties are fine through a typed binding.
    const descriptorLike = {
      kind: 'service' as const,
      typeName: 'example.EchoService',
      method: { echo: { name: 'Echo' } },
      methods: [{ name: 'Echo' }],
    };
    const definition: GrpcServiceDefinition = descriptorLike;
    expect(definition.method).toBe(descriptorLike.method);
  });

  it('accepts a null-prototype method record', () => {
    const obj: GrpcServiceDefinition = {
      typeName: 'foo.Bar',
      method: Object.create(null),
    };
    expect(obj.typeName).toContain('.');
  });
});
