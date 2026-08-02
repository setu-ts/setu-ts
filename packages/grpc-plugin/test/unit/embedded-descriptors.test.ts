/**
 * The embedded descriptor constants are a COMMITTED GENERATED ARTIFACT, so this
 * file is their drift gate: it decodes each constant with the real Protobuf-ES
 * runtime and asserts the exact service and method SET.
 *
 * Asserting the set rather than a subset is the point — it is what catches an
 * upstream proto gaining a method the health bridge has not considered.
 * `grpc.health.v1.Health` has already grown from two RPCs to three (`List` was
 * added), and regenerating against a newer upstream must fail here and force a
 * decision rather than silently widening the auto-`unimplemented` surface.
 *
 * Guarded like the other real-import tests: skipped when the packages are
 * absent, never silently passing on a fake.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  EmbeddedDescriptors,
  healthBase64,
  reflectionBase64,
} from '../../src/descriptors/embedded-descriptors.ts';
import { loadConnectModule } from '../../src/transports/connect-loader.ts';
import type { ConnectRuntime } from '../../src/interfaces/connect-runtime.ts';

/** Byte length of a base64 payload, so a truncation is caught precisely. */
function decodedLength(base64: string): number {
  return atob(base64).length;
}

let runtime: ConnectRuntime | undefined;
try {
  runtime = await loadConnectModule();
} catch {
  runtime = undefined;
}

describe('EmbeddedDescriptors — constants', () => {
  it('exposes both constants through the aggregate', () => {
    expect(EmbeddedDescriptors.healthBase64).toBe(healthBase64);
    expect(EmbeddedDescriptors.reflectionBase64).toBe(reflectionBase64);
  });

  it('are well-formed base64 of the recorded size', () => {
    for (const constant of [healthBase64, reflectionBase64]) {
      expect(/^[A-Za-z0-9+/]+={0,2}$/.test(constant)).toBe(true);
    }
    // The provenance JSDoc records these exact figures; a mismatch means the
    // constant was regenerated or truncated without updating its provenance.
    expect(healthBase64.length).toBe(1168);
    expect(decodedLength(healthBase64)).toBe(874);
    expect(reflectionBase64.length).toBe(2332);
    expect(decodedLength(reflectionBase64)).toBe(1747);
  });
});

describe('EmbeddedDescriptors — revived with the real runtime', { ignore: !runtime }, () => {
  /** Reads a service descriptor out of a constant. */
  function serviceFrom(base64: string, name: string) {
    const service = runtime!.getService(runtime!.reviveDescriptorSet(base64), name);
    if (service === undefined) {
      throw new Error(`descriptor set does not declare ${name}`);
    }
    return service;
  }

  it('healthBase64 declares grpc.health.v1.Health with EXACTLY Check, List and Watch', () => {
    const health = serviceFrom(healthBase64, 'grpc.health.v1.Health');
    expect(health.kind).toBe('service');
    expect(health.typeName).toBe('grpc.health.v1.Health');
    // The SET, not a subset: a fourth RPC upstream must fail this.
    expect((health.methods ?? []).map((m) => m.name).sort()).toEqual(['Check', 'List', 'Watch']);
  });

  it('reflectionBase64 declares ServerReflection with EXACTLY ServerReflectionInfo', () => {
    const reflection = serviceFrom(reflectionBase64, 'grpc.reflection.v1.ServerReflection');
    expect(reflection.kind).toBe('service');
    expect(reflection.typeName).toBe('grpc.reflection.v1.ServerReflection');
    expect((reflection.methods ?? []).map((m) => m.name)).toEqual(['ServerReflectionInfo']);
  });

  it('both descriptor sets are self-contained (no imports to resolve)', () => {
    // This is why the single-argument createFileRegistry overload suffices and
    // no well-known-type files have to be bundled.
    for (
      const [base64, name] of [
        [healthBase64, 'grpc.health.v1.Health'],
        [reflectionBase64, 'grpc.reflection.v1.ServerReflection'],
      ] as const
    ) {
      const file = serviceFrom(base64, name).file;
      expect(file).toBeDefined();
      expect(file!.dependencies).toEqual([]);
    }
  });

  it('carries the suffixed proto path reflection clients ask for', () => {
    const health = serviceFrom(healthBase64, 'grpc.health.v1.Health');
    expect(health.file!.proto.name).toBe('grpc/health/v1/health.proto');
    // Protobuf-ES strips the suffix on DescFile.name; conflating them breaks
    // file_by_filename lookups.
    expect(health.file!.name).toBe('grpc/health/v1/health');
  });

  it('re-serializes to non-empty FileDescriptorProto bytes', () => {
    const reflection = serviceFrom(reflectionBase64, 'grpc.reflection.v1.ServerReflection');
    expect(runtime!.serializeFileDescriptor(reflection.file!).byteLength).toBeGreaterThan(0);
  });
});
