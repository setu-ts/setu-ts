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
  ILogger,
  IRealtimeBackplane,
  IRequestContext,
  IRuntimeServices,
  ISseConnection,
  ISseService as IService,
  RealtimeFrame,
  SseChannel,
  SseMessage,
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
  readonly #registry: ChannelRegistry;
  readonly #heartbeatMs: number | undefined;
  readonly #retryMs: number | undefined;
  readonly #runtime: IRuntimeServices;
  /** The cross-replica transport, when one was registered. */
  readonly #backplane: IRealtimeBackplane | undefined;
  /** Optional logger used to report a failed cross-replica fan-out. */
  readonly #logger: ILogger | undefined;

  /**
   * @param options - Plugin options (heartbeatMs, retryMs); may be undefined
   * @param runtime - Runtime services (injected from plugin registration)
   * @param backplane - Optional cross-replica transport. When present, every
   *   channel publish is also sent to it; when absent, channels stay purely
   *   in-process, which is the behavior before the backplane existed.
   * @param logger - Optional logger used to report a failed fan-out
   * @since 0.1.0
   */
  constructor(
    options: SsePluginOptions | undefined,
    runtime: IRuntimeServices,
    backplane?: IRealtimeBackplane,
    logger?: ILogger,
  ) {
    this.#heartbeatMs = options?.heartbeatMs;
    this.#retryMs = options?.retryMs;
    this.#runtime = runtime;
    this.#backplane = backplane;
    this.#logger = logger;
    this.#registry = new ChannelRegistry(
      backplane === undefined ? undefined : (name, msg): void => {
        const frame: RealtimeFrame = {
          kind: 'sse-channel',
          origin: backplane.origin,
          name,
          // An SseMessage is already JSON-serializable, so its JSON encoding is
          // the wire form; no base64 is involved on this path.
          data: JSON.stringify(msg),
        };
        // Fire-and-forget: a transport failure must never make a local publish
        // throw for the application that issued it. It is reported rather than
        // swallowed, because the degradation — local-only delivery — is
        // otherwise completely invisible to an operator.
        void backplane.publish(frame).catch((error: unknown) => {
          this.#logger?.warn('sse: backplane publish failed', {
            channel: name,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
    );
  }

  /**
   * Delivers a message that arrived from another replica to this replica's
   * local channel members.
   *
   * Called only by the plugin's backplane subscription. It uses the registry's
   * local-only delivery path, so an arriving message is never re-published —
   * which would echo it around the cluster forever.
   *
   * Frames of another kind, and frames this instance published itself, are
   * ignored: one backplane topic carries both SSE channels and WebSocket rooms,
   * and a channel may legitimately share a name with a room.
   *
   * @param frame - The arriving frame
   * @since 0.2.0
   */
  deliverRemoteFrame(frame: RealtimeFrame): void {
    if (frame.kind !== 'sse-channel' || frame.origin === this.#backplane?.origin) {
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(frame.data);
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null || !('data' in msg)) {
      return;
    }
    this.#registry.deliverRemote(frame.name, msg as SseMessage);
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
