/**
 * Room delivery for runtimes that tie every socket to the request that
 * accepted it (Cloudflare Workers).
 *
 * A room there never iterates its members: writing to a member from another
 * request throws in workerd. Each connection instead holds a link to the
 * backplane hub, opened in its own request; a broadcast is published once, and
 * every link delivers to its own connection, in that connection's request,
 * when the connection is a member of the room.
 *
 * @module
 * @since 0.14.0
 */

import type {
  ILogger,
  IRealtimeConnectionLink,
  IRealtimeLinkBackplane,
  IWebSocketConnection,
  RealtimeFrame,
  RoomBroadcastOptions,
} from '@setu-ts/common';
import { decodeFrameData, describeError, encodeFrameData } from '@setu-ts/common';

import type { Room } from './room-registry.ts';

/** Answers whether a connection is a member of a room, without creating it. */
export type MembershipCheck = (room: string, conn: IWebSocketConnection) => boolean;

/**
 * Request-bound room delivery: one link per connection, a publishing link
 * chosen per broadcast, and local delivery only to the caller's own connection.
 *
 * @since 0.14.0
 */
export class RequestBoundRooms {
  readonly #backplane: IRealtimeLinkBackplane;
  readonly #logger: ILogger | undefined;
  readonly #links = new Map<IWebSocketConnection, IRealtimeConnectionLink>();
  #current: IWebSocketConnection | undefined;
  #fallbackLogged = false;

  /**
   * @param backplane - A backplane that gives each connection its own link
   * @param logger - For the one debug line when a broadcast falls back to the hub
   */
  constructor(backplane: IRealtimeLinkBackplane, logger?: ILogger) {
    this.#backplane = backplane;
    this.#logger = logger;
  }

  /** Number of open links, for diagnostics and tests. */
  get linkCount(): number {
    return this.#links.size;
  }

  /**
   * Opens a connection's link. Called from the connection's own request (its
   * sink's `onOpen`), before the route's `onOpen` handler runs.
   *
   * @param conn - The connection
   * @param isMember - Membership check, read per arriving frame
   * @returns `false` when the link could not open; the caller closes the
   *   connection, since it would receive nothing from its rooms
   */
  open(conn: IWebSocketConnection, isMember: MembershipCheck): boolean {
    let link: IRealtimeConnectionLink;
    try {
      link = this.#backplane.openConnectionLink(conn.id, (frame) => {
        deliver(conn, frame, isMember);
      });
    } catch (error: unknown) {
      // Only a misbuilt backplane fails here (a hand-made
      // DurableObjectBackplane without `timers`); a connection left open would
      // receive nothing from its rooms, so the caller closes it.
      this.#logger?.warn('websocket: backplane link could not open', {
        error: describeError(error),
      });
      return false;
    }
    this.#links.set(conn, link);
    return true;
  }

  /**
   * Closes a connection's link, so the hub's socket count follows live
   * connections.
   *
   * @param conn - The connection
   */
  close(conn: IWebSocketConnection): void {
    const link = this.#links.get(conn);
    if (link === undefined) return;
    this.#links.delete(conn);
    link.close();
  }

  /** Closes every link; one that throws does not keep the rest open. */
  closeAll(): void {
    try {
      for (const link of this.#links.values()) {
        try {
          link.close();
        } catch (error: unknown) {
          try {
            this.#logger?.warn('websocket: backplane link failed to close', {
              error: describeError(error),
            });
          } catch {
            // A logger that throws must not leave the remaining links open.
          }
        }
      }
    } finally {
      this.#links.clear();
    }
  }

  /**
   * Runs `fn` with `conn` as the connection whose event is being dispatched,
   * so a broadcast made synchronously inside it publishes over that
   * connection's link.
   *
   * @param conn - The connection whose sink event is dispatching
   * @param fn - The synchronous part of the handler call
   */
  dispatching(conn: IWebSocketConnection, fn: () => void): void {
    const previous = this.#current;
    this.#current = conn;
    try {
      fn();
    } finally {
      this.#current = previous;
    }
  }

  /**
   * Broadcasts to a room. The publishing link is, in order: the connection
   * whose event is dispatching now; the `except` connection's (a handler
   * broadcasting after an `await`, still in its own request); otherwise the
   * hub's HTTP publish. The caller's own connection is delivered to locally
   * only when its link carried the frame, since the hub never sends a link's
   * frame back to it.
   *
   * @param room - The room
   * @param data - The payload
   * @param options - The caller's options
   */
  broadcast(room: Room, data: string | Uint8Array, options?: RoomBroadcastOptions): void {
    const except = options?.except;
    const payload = encodeFrameData(data);
    let frame: RealtimeFrame = {
      kind: 'ws-room',
      origin: this.#backplane.origin,
      name: room.name,
      data: payload.data,
      ...(payload.binary === true ? { binary: true } : {}),
      ...(except === undefined ? {} : { exceptId: except.id }),
    };

    let attempted = false;
    const current = this.#current;
    const currentLink = current === undefined ? undefined : this.#links.get(current);
    if (current !== undefined && currentLink !== undefined) {
      attempted = true;
      if (currentLink.publish(frame)) {
        if (current !== except && room.has(current) && current.isOpen) {
          sendQuietly(current, data);
        }
        return;
      }
      if (except === undefined && room.has(current) && current.isOpen) {
        // The link refused the frame (still opening with its queue full, or
        // the frame is above the hub's cap), so it goes through the hub, which
        // reaches only links already open. The sender gets it here, before
        // the transport as on every runtime, and is excluded from the hub's
        // copy so it never gets two.
        sendQuietly(current, data);
        frame = { ...frame, exceptId: current.id };
      }
    }
    if (except !== undefined && except !== current) {
      const exceptLink = this.#links.get(except);
      if (exceptLink !== undefined) {
        attempted = true;
        if (exceptLink.publish(frame)) return;
      }
    }
    if (attempted && !this.#fallbackLogged) {
      this.#fallbackLogged = true;
      this.#logger?.debug('websocket: broadcast published through the hub', { room: room.name });
    }
    void this.#backplane.publishViaHub(frame).catch((error: unknown) => {
      this.#logger?.warn('websocket: backplane publish failed', {
        room: room.name,
        error: describeError(error),
      });
    });
  }
}

/** Delivers one arriving frame to its link's own connection, when it should. */
function deliver(
  conn: IWebSocketConnection,
  frame: RealtimeFrame,
  isMember: MembershipCheck,
): void {
  if (frame.kind !== 'ws-room') return;
  if (frame.exceptId === conn.id) return;
  if (!conn.isOpen || !isMember(frame.name, conn)) return;
  let data: string | Uint8Array;
  try {
    data = decodeFrameData(frame);
  } catch {
    return;
  }
  sendQuietly(conn, data);
}

/** Sends without letting a closing socket's throw escape. */
function sendQuietly(conn: IWebSocketConnection, data: string | Uint8Array): void {
  try {
    conn.send(data);
  } catch {
    // The socket is closing; its close event removes it.
  }
}
