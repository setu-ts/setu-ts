/**
 * Unit tests for the Server Reflection implementation.
 *
 * The load-bearing assertion in every case is the ONEOF WRAPPER: Protobuf-ES
 * represents `message_response` as `messageResponse: { case, value }`. A flat
 * `{ listServicesResponse: … }` object type-checks against a loose type and
 * serializes to an EMPTY message — the exact defect these tests pin.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  answerReflectionRequest,
  createReflectionService,
} from '../../src/reflection/grpc-reflection.ts';
import type { ReflectionRegistry } from '../../src/descriptors/descriptor-registry.ts';

const FILE_BYTES = new TextEncoder().encode('fd:pkg/svc.proto');

/** A registry standing in for the real index. */
function fakeRegistry(overrides: Partial<ReflectionRegistry> = {}): ReflectionRegistry {
  return {
    listServices: () => ['pkg.Svc', 'grpc.health.v1.Health'],
    getFileByName: (name) => (name === 'pkg/svc.proto' ? FILE_BYTES : undefined),
    getFileContainingSymbol: (symbol) => (symbol === 'pkg.Svc' ? FILE_BYTES : undefined),
    getExtensionNumbers: (typeName) => (typeName === 'pkg.Target' ? [1001, 1002] : undefined),
    ...overrides,
  };
}

/** Builds a request in the wrapped form Protobuf-ES delivers. */
function request(kind: string, value: unknown) {
  return { messageRequest: { case: kind as never, value } };
}

describe('answerReflectionRequest', () => {
  it('answers list_services with every registered service name', () => {
    const response = answerReflectionRequest(fakeRegistry(), request('listServices', ''));

    expect(response.messageResponse.case).toBe('listServicesResponse');
    expect(response.messageResponse.value).toEqual({
      service: [{ name: 'pkg.Svc' }, { name: 'grpc.health.v1.Health' }],
    });
  });

  it('wraps every answer in the messageResponse oneof rather than flattening it', () => {
    // A flat object would serialize to {} on the wire.
    const response = answerReflectionRequest(fakeRegistry(), request('listServices', ''));
    expect(Object.hasOwn(response, 'messageResponse')).toBe(true);
    expect(Object.hasOwn(response, 'listServicesResponse')).toBe(false);
    expect(response.messageResponse).toHaveProperty('case');
    expect(response.messageResponse).toHaveProperty('value');
  });

  it('echoes the original request on every response, as the spec requires', () => {
    const req = request('listServices', '');
    expect(answerReflectionRequest(fakeRegistry(), req).originalRequest).toBe(req);

    const missing = request('fileByFilename', 'nope.proto');
    expect(answerReflectionRequest(fakeRegistry(), missing).originalRequest).toBe(missing);
  });

  it('answers file_by_filename with the serialized FileDescriptorProto', () => {
    const response = answerReflectionRequest(
      fakeRegistry(),
      request('fileByFilename', 'pkg/svc.proto'),
    );
    expect(response.messageResponse.case).toBe('fileDescriptorResponse');
    expect(response.messageResponse.value).toEqual({ fileDescriptorProto: [FILE_BYTES] });
  });

  it('answers NOT_FOUND for an unknown filename', () => {
    const response = answerReflectionRequest(
      fakeRegistry(),
      request('fileByFilename', 'absent.proto'),
    );
    expect(response.messageResponse).toEqual({
      case: 'errorResponse',
      value: { errorCode: 5, errorMessage: 'file not found: absent.proto' },
    });
  });

  it('answers file_containing_symbol with the declaring file', () => {
    const response = answerReflectionRequest(
      fakeRegistry(),
      request('fileContainingSymbol', 'pkg.Svc'),
    );
    expect(response.messageResponse.case).toBe('fileDescriptorResponse');
    expect(response.messageResponse.value).toEqual({ fileDescriptorProto: [FILE_BYTES] });
  });

  it('answers NOT_FOUND for an unknown symbol', () => {
    const response = answerReflectionRequest(
      fakeRegistry(),
      request('fileContainingSymbol', 'no.Such'),
    );
    expect(response.messageResponse).toEqual({
      case: 'errorResponse',
      value: { errorCode: 5, errorMessage: 'symbol not found: no.Such' },
    });
  });

  it('answers all_extension_numbers_of_type with the type and its numbers', () => {
    const response = answerReflectionRequest(
      fakeRegistry(),
      request('allExtensionNumbersOfType', 'pkg.Target'),
    );
    expect(response.messageResponse).toEqual({
      case: 'allExtensionNumbersResponse',
      value: { baseTypeName: 'pkg.Target', extensionNumber: [1001, 1002] },
    });
  });

  it('answers an empty extension list for a known type with no extensions', () => {
    const registry = fakeRegistry({ getExtensionNumbers: () => [] });
    const response = answerReflectionRequest(
      registry,
      request('allExtensionNumbersOfType', 'pkg.Plain'),
    );
    expect(response.messageResponse).toEqual({
      case: 'allExtensionNumbersResponse',
      value: { baseTypeName: 'pkg.Plain', extensionNumber: [] },
    });
  });

  it('answers NOT_FOUND when the extended type itself is unknown', () => {
    const response = answerReflectionRequest(
      fakeRegistry(),
      request('allExtensionNumbersOfType', 'no.Such'),
    );
    expect(response.messageResponse).toEqual({
      case: 'errorResponse',
      value: { errorCode: 5, errorMessage: 'type not found: no.Such' },
    });
  });

  it('answers UNIMPLEMENTED for file_containing_extension', () => {
    const response = answerReflectionRequest(
      fakeRegistry(),
      request('fileContainingExtension', { containingType: 'pkg.Target', extensionNumber: 1001 }),
    );
    expect(response.messageResponse.case).toBe('errorResponse');
    const value = response.messageResponse.value as { errorCode: number; errorMessage: string };
    expect(value.errorCode).toBe(12);
    expect(value.errorMessage).toContain('pkg.Target');
  });

  it('tolerates a file_containing_extension request with no value', () => {
    const response = answerReflectionRequest(
      fakeRegistry(),
      request('fileContainingExtension', undefined),
    );
    expect(response.messageResponse.case).toBe('errorResponse');
  });

  it('answers UNIMPLEMENTED when no oneof arm is set', () => {
    expect(answerReflectionRequest(fakeRegistry(), {}).messageResponse).toEqual({
      case: 'errorResponse',
      value: { errorCode: 12, errorMessage: 'unsupported reflection request: (none set)' },
    });
  });

  it('answers UNIMPLEMENTED naming an unrecognized oneof arm', () => {
    // A newer reflection proto could add an arm this build does not know.
    const response = answerReflectionRequest(fakeRegistry(), request('somethingNew', 'x'));
    expect(response.messageResponse).toEqual({
      case: 'errorResponse',
      value: { errorCode: 12, errorMessage: 'unsupported reflection request: somethingNew' },
    });
  });

  it('coerces a missing oneof value to the empty string rather than "undefined"', () => {
    // Every string-valued arm must coerce identically; a bare String(undefined)
    // would put the literal text "undefined" on the wire.
    const byFilename = answerReflectionRequest(
      fakeRegistry(),
      request('fileByFilename', undefined),
    );
    expect((byFilename.messageResponse.value as { errorMessage: string }).errorMessage)
      .toBe('file not found: ');

    const bySymbol = answerReflectionRequest(
      fakeRegistry(),
      request('fileContainingSymbol', undefined),
    );
    expect((bySymbol.messageResponse.value as { errorMessage: string }).errorMessage)
      .toBe('symbol not found: ');

    const byType = answerReflectionRequest(
      fakeRegistry(),
      request('allExtensionNumbersOfType', undefined),
    );
    expect((byType.messageResponse.value as { errorMessage: string }).errorMessage)
      .toBe('type not found: ');
  });
});

describe('createReflectionService', () => {
  it('exposes serverReflectionInfo and answers each request in the stream', async () => {
    const service = createReflectionService(fakeRegistry());
    const handler = service.serverReflectionInfo as (
      requests: AsyncIterable<unknown>,
    ) => AsyncGenerator<{ messageResponse: { case: string } }>;

    async function* requests() {
      yield request('listServices', '');
      yield request('fileByFilename', 'pkg/svc.proto');
      yield request('fileContainingSymbol', 'no.Such');
    }

    const cases: string[] = [];
    for await (const response of handler(requests())) {
      cases.push(response.messageResponse.case);
    }

    // One response per request, in order — the bidi contract.
    expect(cases).toEqual([
      'listServicesResponse',
      'fileDescriptorResponse',
      'errorResponse',
    ]);
  });

  it('yields nothing for an empty request stream', async () => {
    const service = createReflectionService(fakeRegistry());
    const handler = service.serverReflectionInfo as (
      requests: AsyncIterable<unknown>,
    ) => AsyncGenerator<unknown>;

    async function* none() {}

    const responses: unknown[] = [];
    for await (const response of handler(none())) {
      responses.push(response);
    }
    expect(responses).toEqual([]);
  });
});
