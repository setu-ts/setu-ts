/**
 * Structural facades and ports for the Connect-ES runtime.
 * These are NOT exported from `src/index.ts` — they form an internal port
 * that adapts the lazy-loaded Connect modules without introducing a hard
 * dependency on them in the plugin's type graph.
 *
 * @module
 */

export interface ConnectRuntime {
  /** Creates a ConnectRouter for registering services. */
  createConnectRouter(): {
    handlers: Array<{ requestPath: string; handler: unknown }>;
    service<T extends { typeName: string }>(
      service: T,
      implementation: Record<string, (...args: unknown[]) => unknown>,
      options?: Record<string, unknown>,
    ): void;
  };

  /**
   * Converts a universal handler function to a fetch handler.
   * The universal handler receives a UniversalServerRequest and returns a Promise<UniversalServerResponse>.
   */
  createFetchHandler(
    uHandler: (request: Record<string, unknown>) => Promise<Record<string, unknown>>,
    options?: { httpVersion?: string },
  ): (request: Request) => Promise<Response>;

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
