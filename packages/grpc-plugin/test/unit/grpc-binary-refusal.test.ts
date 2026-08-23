/**
 * Unit tests for the native gRPC-binary refusal (M70i §3.3): the exact-match
 * content-type table (gRPC-Web explicitly NOT native) and the Trailers-Only
 * `UNIMPLEMENTED` response shape.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  isNativeGrpcContentType,
  trailersOnlyUnimplemented,
} from '../../src/transports/grpc-binary-refusal.ts';

describe('isNativeGrpcContentType — exact match table', () => {
  it('recognizes the three native media types', () => {
    expect(isNativeGrpcContentType('application/grpc')).toBe(true);
    expect(isNativeGrpcContentType('application/grpc+proto')).toBe(true);
    expect(isNativeGrpcContentType('application/grpc+json')).toBe(true);
  });

  it('recognizes them with parameters and casing', () => {
    expect(isNativeGrpcContentType('application/grpc; charset=utf-8')).toBe(true);
    expect(isNativeGrpcContentType('APPLICATION/GRPC+PROTO')).toBe(true);
    expect(isNativeGrpcContentType('  application/grpc+json  ')).toBe(true);
    expect(isNativeGrpcContentType('application/grpc;')).toBe(true);
  });

  it('does NOT treat gRPC-Web as native — the working browser format', () => {
    // The regression the exact match exists for:
    // 'application/grpc-web+proto'.startsWith('application/grpc') is true.
    expect(isNativeGrpcContentType('application/grpc-web+proto')).toBe(false);
    expect(isNativeGrpcContentType('application/grpc-web+json')).toBe(false);
    expect(isNativeGrpcContentType('application/grpc-web')).toBe(false);
  });

  it('does NOT treat Connect or ordinary JSON as native', () => {
    expect(isNativeGrpcContentType('application/connect+json')).toBe(false);
    expect(isNativeGrpcContentType('application/connect+proto')).toBe(false);
    expect(isNativeGrpcContentType('application/json')).toBe(false);
    expect(isNativeGrpcContentType('application/proto')).toBe(false);
    expect(isNativeGrpcContentType('text/plain')).toBe(false);
  });

  it('is false for a missing content type', () => {
    expect(isNativeGrpcContentType(null)).toBe(false);
  });
});

describe('trailersOnlyUnimplemented — Trailers-Only response shape', () => {
  it('answers HTTP 200 with grpc-status 12 (UNIMPLEMENTED) and an empty body', async () => {
    const response = trailersOnlyUnimplemented();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/grpc');
    expect(response.headers.get('grpc-status')).toBe('12');
    expect(await response.text()).toBe('');
  });

  it('names Connect and gRPC-Web as the working formats in grpc-message', () => {
    const message = trailersOnlyUnimplemented().headers.get('grpc-message');
    expect(message).toContain('Connect');
    expect(message).toContain('gRPC-Web');
    expect(message).toContain('application/grpc-web');
  });
});
