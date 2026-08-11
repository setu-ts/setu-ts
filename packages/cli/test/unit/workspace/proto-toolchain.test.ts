import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  PROTO_DIR,
  PROTO_IMPORTS,
  PROTO_OUT_DIR,
  PROTO_TASK_COMMAND,
  protoToolchainFiles,
} from '../../../src/workspace/proto-toolchain.ts';
import { transportSpec } from '../../../src/workspace/transport.ts';

describe('protoToolchainFiles', () => {
  const files = protoToolchainFiles('orders.v1');

  /**
   * Reads one emitted file.
   *
   * @param path - The path to read
   * @returns Its contents
   */
  function contentsOf(path: string): string {
    const file = files.find((candidate) => candidate.path === path);
    expect(file).toBeDefined();
    return file?.contents ?? '';
  }

  it('emits a proto, both buf manifests, and a README', () => {
    expect(files.map((f) => f.path).sort()).toEqual([
      'buf.gen.yaml',
      'buf.yaml',
      `${PROTO_DIR}/README.md`,
      `${PROTO_DIR}/orders/v1/orders.proto`,
    ]);
  });

  it('puts the proto in a package derived from the member name', () => {
    expect(contentsOf(`${PROTO_DIR}/orders/v1/orders.proto`)).toContain('package orders.v1;');
  });

  // THE load-bearing detail, and it was found by running it: buf resolves
  // `local: protoc-gen-es` on $PATH, and nothing installs a PATH binary, so
  // generation fails with `executable file not found in $PATH`. Declared as a
  // command it runs through Deno with no install at all.
  it('declares the codegen plugin as a command, not as a PATH name', () => {
    const config = contentsOf('buf.gen.yaml');
    expect(config).toContain(`local: ['deno', 'run', '-A', 'npm:@bufbuild/protoc-gen-es@^2']`);
    expect(config).not.toMatch(/^\s+- local: protoc-gen-es$/m);
  });

  // A remote plugin would compile the schema on a registry. That is a surprising
  // thing for a scaffold to arrange, so it is refused by construction.
  it('uses no remote plugin, so the schema never leaves the machine', () => {
    // The DIRECTIVE, not the substring: the file explains in a comment why the
    // remote form is not used, so a bare substring check fails on the explanation.
    expect(contentsOf('buf.gen.yaml')).not.toMatch(/^\s*(-\s*)?remote:/m);
  });

  // Mixing v1 and v2 keys between the two files is the most common way a buf setup
  // fails with a message about neither.
  it('declares the same buf config version in both manifests', () => {
    expect(contentsOf('buf.yaml')).toContain('version: v2');
    expect(contentsOf('buf.gen.yaml')).toContain('version: v2');
  });

  it('tells the reader how the descriptor reaches addService', () => {
    const readme = contentsOf(`${PROTO_DIR}/README.md`);
    expect(readme).toContain('grpc.addService(PingService');
    expect(readme).toContain(PROTO_OUT_DIR);
  });

  // Found by running the task and then USING what it wrote: the descriptor imports
  // `@bufbuild/protobuf/codegenv2`, and a bare specifier mapping does not cover a
  // subpath — so both entries are required or the member cannot compile the file
  // its own task just generated.
  it('maps both the bare specifier and its subpaths', () => {
    expect(PROTO_IMPORTS['@bufbuild/protobuf']).toBeDefined();
    expect(PROTO_IMPORTS['@bufbuild/protobuf/']).toBeDefined();
    expect(PROTO_IMPORTS['@bufbuild/protobuf/']).toContain('npm:/@bufbuild/protobuf');
  });

  // The compiler runs through Deno too, so a generated project needs neither buf
  // nor protoc installed.
  it('runs buf through Deno rather than a PATH binary', () => {
    expect(PROTO_TASK_COMMAND).toContain('npm:@bufbuild/buf');
    expect(PROTO_TASK_COMMAND).toContain('deno run');
  });
});

describe('the grpc transport arm', () => {
  it('contributes the toolchain, its task, and its imports', () => {
    const grpc = transportSpec('grpc');
    expect(grpc.memberFiles?.('orders').map((f) => f.path)).toContain('buf.gen.yaml');
    expect(grpc.memberTasks?.['proto:gen']).toBe(PROTO_TASK_COMMAND);
    expect(grpc.memberImports?.['@bufbuild/protobuf']).toBeDefined();
  });

  // The package must differ per member, or two services' messages land in one
  // namespace. A hyphenated member name is not a legal proto package component.
  it('derives a distinct, legal proto package per member', () => {
    const grpc = transportSpec('grpc');
    const first = grpc.memberFiles?.('orders') ?? [];
    const second = grpc.memberFiles?.('order-items') ?? [];
    expect(first.some((f) => f.contents.includes('package orders.v1;'))).toBe(true);
    expect(second.some((f) => f.contents.includes('package order_items.v1;'))).toBe(true);
  });

  it('is the only transport that contributes member files', () => {
    for (const name of ['http', 'memory', 'redis', 'pubsub', 'service-bus'] as const) {
      expect(transportSpec(name).memberFiles).toBeUndefined();
      expect(transportSpec(name).memberTasks).toBeUndefined();
      expect(transportSpec(name).memberImports).toBeUndefined();
    }
  });
});
