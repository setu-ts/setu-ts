/**
 * SseService — implements `ISseService` under `CAPABILITIES.SSE`.
 *
 * Owns the live connection set, the {@linkcode ChannelRegistry}, and passes an
 * `onClosed` callback into each connection so disconnect auto-prunes membership.
 *
 * @module
 * @since 0.1.0
 */

import type {
  IRequestContext,
  IRuntimeServices,
  ISseConnection,
  ISseService as IService,
  SseChannel,
} from '@hono-enterprise/common';
import type { SsePluginOptions } from '../interfaces/index.ts';
import { SseConnection } from '../connection/sse-connection.ts';
import { ChannelRegistry } from '../channels/channel-registry.ts';

/**
 * Implements {@linkcode IService}.
 *
 * @since 0.1.0
 */
export class SseService implements IService {
  #connections = new Set<SseConnection>();
  #registry = new ChannelRegistry();
  readonly #heartbeatMs: number | undefined;
  readonly #retryMs: number | undefined;
  readonly #runtime: IRuntimeServices;

  /**
   * @param options - Plugin options (heartbeatMs, retryMs)
   * @param runtime - Runtime services (injected from plugin registration)
   * @since 0.1.0
   */
  constructor(options?: SsePluginOptions, runtime?: IRuntimeServices) {
    this.#heartbeatMs = options?.heartbeatMs;
    this.#retryMs = options?.retryMs;
    this.#runtime = runtime!;
  }

  /** Open a new SSE connection for the given request context. */
  open(ctx: IRequestContext): ISseConnection {
    const conn = new SseConnection(
      ctx,
      this.#runtime,
      this.#heartbeatMs,
      this.#retryMs,
      () => this.#onClosed(conn),
    );

    this.#connections.add(conn);
    return conn;
  }

  /** Return or create a named channel. */
  channel(name: string): SseChannel {
    return this.#registry.get(name);
  }

  /** Current number of open connections. */
  get connectionCount(): number {
    return this.#connections.size;
  }

  /** Internal callback invoked when a connection closes. */
  #onClosed(conn: SseConnection): void {
    this.#connections.delete(conn);
    this.#registry.removeFromAll(conn);
  }

  /**
   * Close all live connections (used during shutdown).
   *
   * @since 0.1.0
   */
  closeAll(): void {
    for (const conn of this.#connections) {
      conn.close();
    }
    this.#registry.clear();
  }
}
