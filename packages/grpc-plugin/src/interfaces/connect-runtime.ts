/**
 * Structural facades and ports for the Connect-ES runtime.
 * These are NOT exported from `src/index.ts` — they form an internal port
 * that adapts the lazy-loaded Connect modules without introducing a hard
 * dependency on them in the plugin's type graph.
 *
 * @module
 */

export interface ConnectRuntime {
  /** Creates a fetch handler map from Connect router handlers. */
  createFetchHandler(
    handlers: Array<{ requestPath: string; handler: unknown }>,
    options?: { httpVersion?: string },
  ): Map<string, (request: Request) => Promise<Response>>;

  /** Adapts an imported module to ConnectRuntime using cached protobuf/wkt. */
  adaptConnectModule(mod: unknown): ConnectRuntime;

  /** Loads Connect modules via lazy import. */
  loadConnectModule(): Promise<ConnectRuntime>;

  /** Revives a FileDescriptorSet from base64. */
  reviveDescriptorSet(base64: string): unknown;

  /** Gets a service from a registry. */
  getService(registry: unknown, serviceName: string): unknown;
}

/** Simple FileRegistry-like structure. */
export interface FileRegistryLike {
  files: unknown[];
  getService(name: string): unknown | undefined;
  listServices(): string[];
}

/** Standalone adaptation function — takes all three modules explicitly.
 * Re-exported from connect-loader.ts.
 */
export function adaptConnectModule(
  _mod: unknown,
  _protobuf: unknown,
  _wkt: unknown,
): ConnectRuntime {
  // Implementation will be filled by connect-loader.ts
  throw new Error('Implementation in connect-loader.ts');
}
