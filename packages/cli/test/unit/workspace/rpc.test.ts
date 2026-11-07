import { describe, expect, it } from 'vitest';
import { getRpc, RPC_ALIASES, RPC_STYLES, rpcSpec } from '../../../src/workspace/rpc.ts';
import {
  PROTO_DEV_DEPENDENCIES,
  PROTO_IMPORTS,
  PROTO_SCRIPT_COMMAND,
  PROTO_TASK,
  PROTO_TASK_COMMAND,
  protoToolchainFiles,
} from '../../../src/workspace/proto-toolchain.ts';

describe('the RPC-style registry', () => {
  it('declares http and grpc, in that order, and resolves each', () => {
    expect([...RPC_STYLES]).toEqual(['http', 'grpc']);
    for (const name of RPC_STYLES) expect(getRpc(name)?.name).toBe(name);
  });

  it('reads an absent manifest field as http', () => {
    expect(rpcSpec(undefined).name).toBe('http');
  });

  it('misses on an unknown or inherited name', () => {
    for (const name of ['rest', 'tcp', 'constructor', '__proto__', 'toString']) {
      expect(getRpc(name)).toBeUndefined();
    }
  });

  // http is what every template already serves, so it contributes nothing.
  it('contributes nothing for http', () => {
    const http = rpcSpec('http');
    expect(http.plugin).toBeUndefined();
    expect(http.clients).toBeUndefined();
    expect(http.memberFiles).toBeUndefined();
  });

  // Moved from the pre-M138 `grpc` transport unchanged, so the scaffold a grpc
  // member gets is byte-identical to what a grpc workspace member got before.
  it('carries the gRPC plugin, its clients and the proto toolchain for grpc', () => {
    const grpc = rpcSpec('grpc');
    expect(grpc.plugin).toEqual({
      pkg: 'grpc-plugin',
      symbol: 'GrpcPlugin',
      args: "{ basePath: '/grpc' }",
    });
    expect(grpc.clients).toEqual(['@connectrpc/connect', '@bufbuild/protobuf']);
    for (const onDeno of [true, false]) {
      expect(grpc.memberFiles?.('order-service', onDeno)).toEqual(
        protoToolchainFiles('order_service.v1', onDeno),
      );
    }
    expect(grpc.memberTasks).toEqual({ [PROTO_TASK]: PROTO_TASK_COMMAND });
    expect(grpc.memberImports).toBe(PROTO_IMPORTS);
    expect(grpc.memberScripts).toEqual({ [PROTO_TASK]: PROTO_SCRIPT_COMMAND });
    expect(grpc.memberDevDependencies).toBe(PROTO_DEV_DEPENDENCIES);
  });

  it('maps tcp to http rather than inventing a transport', () => {
    expect(RPC_ALIASES['tcp']).toBe('http');
  });

  it('gives every style a description for the help text', () => {
    for (const name of RPC_STYLES) expect(rpcSpec(name).description.length).toBeGreaterThan(10);
  });
});
