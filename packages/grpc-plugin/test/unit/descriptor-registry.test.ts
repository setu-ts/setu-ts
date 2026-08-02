/**
 * Unit tests for the reflection registry: descriptor revival, transitive
 * dependency collection, the symbol index (including nested types and methods,
 * which Protobuf-ES's own lookup does NOT resolve), and extension numbering.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  buildReflectionRegistry,
  reviveServiceDescriptor,
} from '../../src/descriptors/descriptor-registry.ts';
import { GrpcDescriptorError } from '../../src/errors/grpc-errors.ts';
import {
  createFakeConnectRuntime,
  fakeExtension,
  fakeFile,
  fakeMessage,
  fakeService,
} from '../fixtures/fake-connect-runtime.ts';

const decode = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

describe('reviveServiceDescriptor', () => {
  it('returns the named service from a revived descriptor set', () => {
    const runtime = createFakeConnectRuntime({ services: [fakeService('pkg.Svc')] });
    const service = reviveServiceDescriptor(runtime, btoa('bytes'), 'pkg.Svc');
    expect(service.typeName).toBe('pkg.Svc');
    expect(runtime.revived).toEqual([btoa('bytes')]);
  });

  it('throws GrpcDescriptorError naming the service when the set does not declare it', () => {
    // A truncated or swapped embedded constant must fail loudly rather than
    // degrading into a router with no health/reflection service.
    const runtime = createFakeConnectRuntime({ services: [] });
    let thrown: unknown;
    try {
      reviveServiceDescriptor(runtime, btoa('bytes'), 'grpc.health.v1.Health');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GrpcDescriptorError);
    expect((thrown as Error).message).toContain('grpc.health.v1.Health');
  });

  it('propagates a decode failure from the runtime', () => {
    const runtime = createFakeConnectRuntime({ reviveThrows: true });
    expect(() => reviveServiceDescriptor(runtime, btoa('junk'), 'pkg.Svc')).toThrow();
  });
});

describe('buildReflectionRegistry', () => {
  it('lists the service names it was given, in order', () => {
    const runtime = createFakeConnectRuntime();
    const registry = buildReflectionRegistry(runtime, [], ['a.A', 'b.B']);
    expect(registry.listServices()).toEqual(['a.A', 'b.B']);
  });

  it('resolves a file by its suffixed proto name', () => {
    const runtime = createFakeConnectRuntime();
    const file = fakeFile('example/echo.proto');
    const registry = buildReflectionRegistry(runtime, [file], []);

    expect(decode(registry.getFileByName('example/echo.proto'))).toBe('fd:example/echo.proto');
    // `DescFile.name` (suffix stripped) is NOT the reflection key.
    expect(registry.getFileByName('example/echo')).toBeUndefined();
    expect(registry.getFileByName('nope.proto')).toBeUndefined();
  });

  it('collects transitive dependencies and indexes a shared one only once', () => {
    const runtime = createFakeConnectRuntime();
    const shared = fakeFile('common/shared.proto', {
      messages: [fakeMessage('common.Shared')],
    });
    const left = fakeFile('a/left.proto', {
      dependencies: [shared],
      services: [fakeService('a.Left', ['Do'])],
    });
    const right = fakeFile('b/right.proto', {
      dependencies: [shared],
      services: [fakeService('b.Right', ['Do'])],
    });

    const registry = buildReflectionRegistry(runtime, [left, right], []);

    expect(decode(registry.getFileByName('common/shared.proto'))).toBe('fd:common/shared.proto');
    expect(decode(registry.getFileContainingSymbol('common.Shared'))).toBe(
      'fd:common/shared.proto',
    );
    // Serialization is memoized: the shared file is serialized at most once
    // even though it was reached from two roots and queried twice.
    expect(runtime.serializedFiles.filter((n) => n === 'common/shared.proto')).toHaveLength(1);
  });

  it('tolerates an undefined file root and a dependency cycle', () => {
    const runtime = createFakeConnectRuntime();
    const a = fakeFile('a.proto', { messages: [fakeMessage('pkg.A')] });
    // Real descriptor graphs are acyclic, but the walk must not hang if one is not.
    (a.dependencies as unknown as unknown[]).push(a);

    const registry = buildReflectionRegistry(runtime, [undefined, a], []);
    expect(decode(registry.getFileContainingSymbol('pkg.A'))).toBe('fd:a.proto');
  });

  it('indexes messages, nested messages, nested enums and file enums', () => {
    const runtime = createFakeConnectRuntime();
    const file = fakeFile('pkg/types.proto', {
      messages: [
        fakeMessage('pkg.Outer', {
          messages: [
            fakeMessage('pkg.Outer.Inner', { enums: [{ typeName: 'pkg.Outer.Inner.E' }] }),
          ],
          enums: [{ typeName: 'pkg.Outer.E' }],
        }),
      ],
      enums: [{ typeName: 'pkg.TopEnum' }],
    });
    const registry = buildReflectionRegistry(runtime, [file], []);

    for (
      const symbol of [
        'pkg.Outer',
        'pkg.Outer.Inner',
        'pkg.Outer.Inner.E',
        'pkg.Outer.E',
        'pkg.TopEnum',
      ]
    ) {
      expect(decode(registry.getFileContainingSymbol(symbol))).toBe('fd:pkg/types.proto');
    }
  });

  it('indexes services AND their methods as symbols', () => {
    // `FileRegistry.get('pkg.Svc.Method')` returns undefined in Protobuf-ES,
    // but a method is a legal file_containing_symbol input.
    const runtime = createFakeConnectRuntime();
    const file = fakeFile('pkg/svc.proto', {
      services: [fakeService('pkg.Svc', ['Check', 'Watch'])],
    });
    const registry = buildReflectionRegistry(runtime, [file], []);

    expect(decode(registry.getFileContainingSymbol('pkg.Svc'))).toBe('fd:pkg/svc.proto');
    expect(decode(registry.getFileContainingSymbol('pkg.Svc.Check'))).toBe('fd:pkg/svc.proto');
    expect(decode(registry.getFileContainingSymbol('pkg.Svc.Watch'))).toBe('fd:pkg/svc.proto');
    expect(registry.getFileContainingSymbol('pkg.Svc.Absent')).toBeUndefined();
  });

  it('tolerates a service descriptor carrying no methods', () => {
    const runtime = createFakeConnectRuntime();
    const file = fakeFile('pkg/bare.proto', {
      services: [{ kind: 'service', typeName: 'pkg.Bare' }],
    });
    const registry = buildReflectionRegistry(runtime, [file], []);
    expect(decode(registry.getFileContainingSymbol('pkg.Bare'))).toBe('fd:pkg/bare.proto');
  });

  it('reports extension numbers per extended type, from file and nested extensions', () => {
    const runtime = createFakeConnectRuntime();
    const file = fakeFile('pkg/ext.proto', {
      messages: [
        fakeMessage('pkg.Holder', {
          extensions: [fakeExtension('pkg.Holder.nested', 'pkg.Target', 1001)],
        }),
      ],
      extensions: [
        fakeExtension('pkg.topLevel', 'pkg.Target', 1002),
        fakeExtension('pkg.other', 'pkg.Elsewhere', 2001),
      ],
    });
    const registry = buildReflectionRegistry(runtime, [file], []);

    expect(registry.getExtensionNumbers('pkg.Target')?.slice().sort()).toEqual([1001, 1002]);
    expect(registry.getExtensionNumbers('pkg.Elsewhere')).toEqual([2001]);
    // The extensions themselves are addressable symbols.
    expect(decode(registry.getFileContainingSymbol('pkg.topLevel'))).toBe('fd:pkg/ext.proto');
    expect(decode(registry.getFileContainingSymbol('pkg.Holder.nested'))).toBe('fd:pkg/ext.proto');
  });

  it('distinguishes a known type with no extensions from an unknown type', () => {
    const runtime = createFakeConnectRuntime();
    const file = fakeFile('pkg/plain.proto', { messages: [fakeMessage('pkg.Plain')] });
    const registry = buildReflectionRegistry(runtime, [file], []);

    expect(registry.getExtensionNumbers('pkg.Plain')).toEqual([]);
    expect(registry.getExtensionNumbers('pkg.Unknown')).toBeUndefined();
  });
});
