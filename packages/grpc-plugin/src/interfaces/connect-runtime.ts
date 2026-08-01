/**
 * Structural facades and ports for the Connect-ES runtime.
 * These are NOT exported from `src/index.ts` — they form an internal port
 * that adapts the lazy-loaded Connect modules without introducing a hard
 * dependency on them in the plugin's type graph.
 *
 * @module
 */

/**
 * Internal port that the Connect runtime loader produces.
 * The plugin never imports @connectrpc/connect or @bufbuild/protobuf directly.
 */
export interface ConnectRuntime {
  /** Creates a new ConnectRouter for registering services. */
  createConnectRouter(): {
    handlers: Array<{
      requestPath: string;
      handler: (request: Request) => Promise<Response>;
    }>;
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

  /** Revives a FileDescriptorSet from base64. */
  reviveDescriptorSet(base64: string): unknown;

  /** Gets a service from a registry. */
  getService(registry: unknown, serviceName: string): unknown;

  /** Creates a FileRegistry from a FileDescriptorSet message. */
  createRegistry(fdSet: unknown): unknown;
}
