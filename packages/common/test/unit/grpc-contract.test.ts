import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '../../src/tokens.ts';
import type { GrpcServiceDefinition, GrpcServingStatus } from '../../src/services/grpc.ts';

// Make IGrpcService partial for testing - we can't instantiate the real interface
describe('gRPC contract', () => {
  it('CAPABILITIES.GRPC equals "grpc"', () => {
    expect(CAPABILITIES.GRPC).toBe('grpc');
  });

  it('GrpcServingStatus has valid values', () => {
    const values: GrpcServingStatus[] = ['unknown', 'serving', 'not-serving', 'service-unknown'];
    const expected = ['unknown', 'serving', 'not-serving', 'service-unknown'] as const;
    for (const v of values) {
      expect(expected.includes(v)).toBe(true);
    }
  });

  it('GrpcServiceDefinition structure is correct', () => {
    const definition: GrpcServiceDefinition = {
      typeName: 'test.Service',
      methods: {},
    };
    expect(definition.typeName).toBe('test.Service');
    expect(definition.methods).toEqual({});
  });

  it('hand-built object satisfies GrpcServiceDefinition', () => {
    const obj: GrpcServiceDefinition = {
      typeName: 'foo.Bar',
      methods: Object.create(null),
    };
    expect(obj.typeName).toContain('.');
  });
});
