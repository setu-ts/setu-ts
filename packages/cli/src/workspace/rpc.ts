/**
 * How a workspace member is called: plain HTTP, or HTTP plus Connect/gRPC.
 *
 * Chosen PER MEMBER, unlike the broker (`transport.ts`). Every member already
 * serves HTTP and is reachable through the discovery map; a gRPC member
 * co-serves Connect/gRPC on the same port, so a workspace mixing the two styles
 * still reaches every service. That is the opposite of a broker, where two
 * members on different buses silently cannot exchange anything — and the reason
 * the two choices are recorded in different places (M138).
 *
 * @module
 */

import type { Wiring } from '../templates/registry.ts';
import type { GeneratedFile } from '../utils/file-writer.ts';
import {
  PROTO_DEV_DEPENDENCIES,
  PROTO_IMPORTS,
  PROTO_SCRIPT_COMMAND,
  PROTO_TASK,
  PROTO_TASK_COMMAND,
  protoToolchainFiles,
} from './proto-toolchain.ts';

/** The RPC styles `setu generate app --rpc` accepts. */
export const RPC_STYLES = ['http', 'grpc'] as const;

/** An RPC style accepted by `--rpc`. */
export type RpcStyle = (typeof RPC_STYLES)[number];

/** What an RPC style contributes to the one member that chose it. */
export interface RpcSpec {
  /** The `--rpc` value that selects it. */
  readonly name: RpcStyle;
  /** One line for `--help` and the member's README. */
  readonly description: string;
  /**
   * The plugin the member registers for this style. Omitted → none (`http`, which
   * every template already serves). Its `pkg` is also the dependency it needs.
   */
  readonly plugin?: Wiring;
  /**
   * Client packages the member needs: optional peers of the plugin, which no
   * package manager installs for the consumer (`client-dependencies.ts`).
   */
  readonly clients?: readonly string[];
  /**
   * Extra source files the member gets.
   *
   * A function of the member's name, because the files it produces are named
   * after the service: a proto package is `<member>.v1`, and a fixed one would
   * put two members' messages in the same namespace.
   *
   * @param member - The member's kebab-case name
   * @param onDeno - Whether the member is a Deno project; the files differ
   * @returns Files relative to the member root
   */
  readonly memberFiles?: (member: string, onDeno: boolean) => readonly GeneratedFile[];
  /** Tasks merged into the member's `deno.json`, for what those files need. */
  readonly memberTasks?: Readonly<Record<string, string>>;
  /**
   * Import-map entries merged into the member's `deno.json`.
   *
   * Needed because {@linkcode RpcSpec.memberFiles} can produce source that
   * imports something the framework does not: the Protobuf-ES descriptors the gRPC
   * toolchain generates import `@bufbuild/protobuf/codegenv2`, and without the
   * mapping the member cannot compile the file its own task just wrote — measured,
   * as `Import "@bufbuild/protobuf/codegenv2" not a dependency and not in import
   * map`.
   */
  readonly memberImports?: Readonly<Record<string, string>>;
  /** Scripts merged into an npm-target member's `package.json`. */
  readonly memberScripts?: Readonly<Record<string, string>>;
  /** devDependencies merged into an npm-target member's `package.json`. */
  readonly memberDevDependencies?: Readonly<Record<string, string>>;
}

/** The style a member gets when `--rpc` is not given, and what an absent manifest field means. */
export const DEFAULT_RPC: RpcStyle = 'http';

const RPC_SPECS: Readonly<Record<RpcStyle, RpcSpec>> = {
  ['http']: {
    name: 'http',
    description: 'Callers reach the member over HTTP, resolved through the discovery map',
  },
  ['grpc']: {
    name: 'grpc',
    clients: ['@connectrpc/connect', '@bufbuild/protobuf'],
    // Mounted rather than root-owned: the stable prefix lets a full-stack
    // member exempt RPCs from form CSRF without exempting its own POST routes.
    // Verified by probe, not assumed: this `GrpcPlugin()` answers
    // `POST /grpc/grpc.health.v1.Health/Check` with `200 {"status":"SERVING"}`,
    // so a member is callable over Connect the moment it boots — no proto
    // toolchain, no generated descriptors. Serving YOUR OWN protos still needs
    // descriptors from buf/protoc handed to `grpc.addService`, which the CLI
    // emits a toolchain for rather than generating itself.
    description: 'The member co-serves Connect/gRPC on its own port, alongside HTTP',
    plugin: { pkg: 'grpc-plugin', symbol: 'GrpcPlugin', args: "{ basePath: '/grpc' }" },
    // The health service needs none of this — the plugin carries that descriptor
    // itself. Serving the member's OWN protos needs a compiler, so the toolchain
    // ships instead of the descriptors.
    memberFiles: (member, onDeno) =>
      protoToolchainFiles(`${member.replaceAll('-', '_')}.v1`, onDeno),
    memberTasks: { [PROTO_TASK]: PROTO_TASK_COMMAND },
    memberImports: PROTO_IMPORTS,
    memberScripts: { [PROTO_TASK]: PROTO_SCRIPT_COMMAND },
    memberDevDependencies: PROTO_DEV_DEPENDENCIES,
  },
};

/**
 * Looks up an RPC style by an UNTRUSTED string — a flag value, or a manifest field.
 *
 * @param name - The `--rpc` value
 * @returns Its spec, or undefined when no such style exists
 */
export function getRpc(name: string): RpcSpec | undefined {
  return Object.hasOwn(RPC_SPECS, name) ? RPC_SPECS[name as RpcStyle] : undefined;
}

/**
 * Resolves an already-validated RPC style to its spec.
 *
 * @param name - A validated style; `undefined` (an absent manifest field) is `http`
 * @returns Its spec
 */
export function rpcSpec(name: RpcStyle | undefined): RpcSpec {
  return RPC_SPECS[name ?? DEFAULT_RPC];
}

/**
 * The name a user is most likely to reach for that this framework does not
 * have, mapped to what they actually want.
 *
 * There is no raw-TCP transport here: every inter-service path is HTTP over TCP
 * or a broker client over TCP. Refusing with this explanation beats accepting
 * `tcp` and quietly giving them HTTP under another name.
 */
export const RPC_ALIASES: Readonly<Record<string, RpcStyle>> = { tcp: 'http' };
