/**
 * Loads `@connectrpc/connect-node`, the client transports (M139b §3.12).
 * Internal — not exported from the package barrel.
 *
 * Loaded on a client's first call, never at registration, so a member that
 * only serves gRPC does not need the package installed.
 *
 * @module
 */
import { OptionalDependencyUnavailableError } from '@setu-ts/common';

import { GrpcRuntimeLoadError } from '../errors/grpc-errors.ts';
import type { ClientTransportLike } from '../interfaces/connect-runtime.ts';

/** The package specifier, named in the load error. */
export const CONNECT_NODE_SPECIFIER = '@connectrpc/connect-node';

/** How to install it, named in the load error. */
const INSTALL_COMMAND =
  'deno add npm:@connectrpc/connect-node@^2.1.2 · npm i @connectrpc/connect-node · bun add @connectrpc/connect-node';

/** An HTTP/2 session shared by every call to one origin. */
export interface Http2SessionLike {
  /** Closes the session and fails the calls still on it. */
  abort(reason?: Error): void;
  /** connect-node's state: `'closed'` or `'error'` once it holds no connection. */
  state(): string;
}

/** What the client reads from `@connectrpc/connect-node`. */
export interface ConnectNodeModuleLike {
  createConnectTransport(options: Record<string, unknown>): ClientTransportLike;
  createGrpcTransport(options: Record<string, unknown>): ClientTransportLike;
  createGrpcWebTransport(options: Record<string, unknown>): ClientTransportLike;
  Http2SessionManager: new (
    url: string,
    pingOptions?: Record<string, unknown>,
    sessionOptions?: Record<string, unknown>,
  ) => Http2SessionLike;
}

/** Imports the module; injectable so a test can drive the failure. */
export type ConnectNodeImporter = () => Promise<unknown>;

/**
 * The real import, as a literal awaited inside its own `try` (M113d): a
 * bundler resolving bare `import()` literals at build time must see it guarded.
 *
 * @returns The module
 */
export async function importConnectNode(): Promise<unknown> {
  try {
    return await import('@connectrpc/connect-node');
  } catch (error) {
    throw new OptionalDependencyUnavailableError('@connectrpc/connect-node', {
      requiredBy: '@setu-ts/grpc-plugin',
      cause: error,
    });
  }
}

/**
 * Loads the client transports.
 *
 * @param importer - The import; the real one by default
 * @returns The module
 * @throws {GrpcRuntimeLoadError} When the package cannot be imported
 */
export async function loadConnectNode(
  importer: ConnectNodeImporter = importConnectNode,
): Promise<ConnectNodeModuleLike> {
  try {
    return (await importer()) as ConnectNodeModuleLike;
  } catch (cause) {
    throw new GrpcRuntimeLoadError(CONNECT_NODE_SPECIFIER, INSTALL_COMMAND, { cause });
  }
}
