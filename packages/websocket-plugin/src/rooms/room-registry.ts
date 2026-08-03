/**
 * Named broadcast rooms — the bidirectional analogue of the SSE plugin's
 * channels.
 *
 * @module
 * @since 0.1.0
 */

import type {
  IWebSocketConnection,
  RoomBroadcastOptions,
  WebSocketRoom,
} from '@hono-enterprise/common';

/**
 * Notified whenever a connection joins or leaves a {@linkcode Room}.
 *
 * A {@linkcode RoomRegistry} supplies one to every room it creates so it can
 * maintain a reverse `connection → rooms` index. Membership changes are the
 * only way that index can be kept accurate, because application code holds the
 * {@linkcode WebSocketRoom} directly (`ws.room('lobby').add(conn)`) and never
 * goes back through the registry to join.
 *
 * @since 0.2.0
 */
export interface RoomMembershipListener {
  /**
   * Called when a connection is added to a room it was not already in.
   *
   * @param conn - The joining connection
   */
  onJoin(conn: IWebSocketConnection): void;
  /**
   * Called when a connection is removed from a room it was in — whether by an
   * explicit {@linkcode Room.remove} or by being dropped mid-broadcast.
   *
   * @param conn - The leaving connection
   */
  onLeave(conn: IWebSocketConnection): void;
}

/**
 * Forwards a local broadcast to peers on other replicas.
 *
 * Supplied by a {@linkcode RoomRegistry} that was given a backplane. A room
 * built without one broadcasts purely in-process, which is the behavior every
 * application had before the backplane existed.
 *
 * @param name - The room the broadcast was addressed to
 * @param data - The payload, exactly as handed to `broadcast`
 * @since 0.2.0
 */
export type RoomPublisher = (
  name: string,
  data: string | Uint8Array,
  exceptId?: string,
) => void;

/**
 * Options for {@linkcode Room.broadcastLocal}.
 *
 * Extends the committed broadcast options with exclusion by connection ID,
 * which is how `except` survives a trip across the backplane: the excluded
 * connection object exists only on the originating replica, but its
 * `runtime.uuid()` ID is globally unique and travels on the frame.
 *
 * @since 0.2.0
 */
export interface LocalBroadcastOptions extends RoomBroadcastOptions {
  /** Skip the member with this connection ID. */
  readonly exceptId?: string;
}

/**
 * A named group of connections that can be addressed as one.
 *
 * @since 0.1.0
 */
export class Room implements WebSocketRoom {
  readonly #name: string;
  readonly #members = new Set<IWebSocketConnection>();
  readonly #listener: RoomMembershipListener | undefined;
  readonly #publish: RoomPublisher | undefined;

  /**
   * Creates a room.
   *
   * @param name - The room name
   * @param listener - Notified on every membership change. Supplied by a
   *   {@linkcode RoomRegistry}; omit for a standalone room.
   * @param publish - Forwards broadcasts to other replicas. Omit for a room
   *   that stays in-process.
   */
  constructor(name: string, listener?: RoomMembershipListener, publish?: RoomPublisher) {
    this.#name = name;
    this.#listener = listener;
    this.#publish = publish;
  }

  get name(): string {
    return this.#name;
  }

  get size(): number {
    let count = 0;
    for (const member of this.#members) {
      if (member.isOpen) {
        count++;
      }
    }
    return count;
  }

  /** Total membership including connections that have since closed. */
  get rawSize(): number {
    return this.#members.size;
  }

  add(conn: IWebSocketConnection): void {
    if (this.#members.has(conn)) {
      // Re-adding an existing member must not emit a second join, or the
      // registry's reverse index would count it twice.
      return;
    }
    this.#members.add(conn);
    this.#listener?.onJoin(conn);
  }

  remove(conn: IWebSocketConnection): void {
    this.#drop(conn);
  }

  broadcast(data: string | Uint8Array, options?: RoomBroadcastOptions): void {
    this.broadcastLocal(data, options);
    // Published after local delivery so a transport error can never cost local
    // members their message. The excluded connection travels as its ID, which
    // is globally unique, so the exclusion is honored on every replica.
    this.#publish?.(this.#name, data, options?.except?.id);
  }

  /**
   * Sends a frame to this replica's own members only, without forwarding it to
   * the backplane.
   *
   * This is the delivery path for a frame that ARRIVED from another replica:
   * re-publishing it would echo it back around the cluster forever. Applications
   * call {@linkcode Room.broadcast}; only the plugin's backplane subscriber
   * calls this.
   *
   * Exclusion is honored two ways: `options.except` names a live connection
   * object (the local path), and `options.exceptId` names one by ID (the path a
   * frame arriving from another replica takes, since the excluded connection
   * object does not exist here).
   *
   * @param data - Text as `string`, binary as `Uint8Array`
   * @param options - Broadcast options, including exclusion by ID
   * @since 0.2.0
   */
  broadcastLocal(data: string | Uint8Array, options?: LocalBroadcastOptions): void {
    const except = options?.except;
    const exceptId = options?.exceptId;
    for (const member of this.#members) {
      if (member === except || (exceptId !== undefined && member.id === exceptId)) {
        continue;
      }
      if (!member.isOpen) {
        // A closed member can never receive again, so drop it here rather than
        // letting the set grow without bound as connections churn.
        this.#drop(member);
        continue;
      }
      try {
        member.send(data);
      } catch {
        // One unwritable peer must never abort the fan-out — the remaining
        // members would silently miss the message. Matches the notification
        // plugin's rule that one failing channel cannot stop the others. The
        // peer is dropped; its own close event does the rest of the cleanup.
        this.#drop(member);
      }
    }
  }

  /**
   * Removes a member and notifies the listener, but only if it really was one.
   * Every removal path funnels through here so the registry's reverse index
   * can never drift from the actual membership.
   *
   * @param conn - The connection to drop
   */
  #drop(conn: IWebSocketConnection): void {
    if (this.#members.delete(conn)) {
      this.#listener?.onLeave(conn);
    }
  }

  broadcastJson<T>(payload: T, options?: RoomBroadcastOptions): void {
    // Serialized once rather than per member.
    this.broadcast(JSON.stringify(payload), options);
  }
}

/**
 * Owns the set of live rooms, creating them on demand and dropping them once
 * empty.
 *
 * @since 0.1.0
 */
export class RoomRegistry {
  readonly #rooms = new Map<string, Room>();
  readonly #publish: RoomPublisher | undefined;

  /**
   * @param publish - Forwards every room broadcast to other replicas. Omit for
   *   purely in-process rooms, which is the behavior when no backplane
   *   capability is registered.
   * @param onMemberJoined - Invoked whenever a connection joins any room on
   *   this replica. Used to open the backplane transport on demand: a replica
   *   with a local member has to be able to RECEIVE, and subscribing does not
   *   open a transport.
   */
  constructor(publish?: RoomPublisher, onMemberJoined?: () => void) {
    this.#publish = publish;
    this.#onMemberJoined = onMemberJoined;
  }

  /** Notified on the first join of every connection. */
  readonly #onMemberJoined: (() => void) | undefined;

  /**
   * Reverse index: which rooms each connection currently belongs to.
   *
   * Without it, evicting a disconnecting peer means scanning every live room —
   * O(rooms) on every single close, which degrades as a server accumulates
   * rooms even though a typical connection belongs to one or two. Kept exact by
   * the {@linkcode RoomMembershipListener} each room is created with, so every
   * join, removal, and mid-broadcast drop updates it.
   */
  readonly #membership = new Map<IWebSocketConnection, Set<Room>>();
  /**
   * Rooms created by {@linkcode RoomRegistry.get} that nobody has joined yet.
   *
   * A room emptied by a departure is discarded the moment it empties, but one
   * that was never joined emits no membership event to hang that on — so
   * `ws.room(id)` used only to read `size` or to broadcast to an audience that
   * has already left would accumulate forever over an unbounded key space.
   * These are reclaimed on the next eviction, matching when the previous
   * whole-map sweep collected them, at a cost proportional to the abandoned
   * rooms rather than to every room on the server.
   */
  readonly #neverJoined = new Set<Room>();

  /** Number of live rooms. */
  get size(): number {
    return this.#rooms.size;
  }

  /**
   * Returns the named room, creating it on first use.
   *
   * @param name - Room name
   * @returns The room
   */
  get(name: string): Room {
    const existing = this.#rooms.get(name);
    if (existing !== undefined) {
      return existing;
    }
    // `room` is referenced by the listener closures, which only ever run after
    // the constructor has returned.
    const room: Room = new Room(name, {
      onJoin: (conn: IWebSocketConnection): void => {
        this.#onMemberJoined?.();
        this.#neverJoined.delete(room);
        let joined = this.#membership.get(conn);
        if (joined === undefined) {
          joined = new Set<Room>();
          this.#membership.set(conn, joined);
        }
        joined.add(room);
      },
      onLeave: (conn: IWebSocketConnection): void => {
        const joined = this.#membership.get(conn);
        if (joined !== undefined) {
          joined.delete(room);
          if (joined.size === 0) {
            this.#membership.delete(conn);
          }
        }
        // Disposal lives here, not only in `evict`, so a room emptied by a
        // mid-broadcast drop is discarded too. The identity check matters: the
        // name may already have been rebound to a fresh room by a `get` that
        // ran after this one emptied.
        if (room.rawSize === 0 && this.#rooms.get(room.name) === room) {
          this.#rooms.delete(room.name);
        }
      },
    }, this.#publish);
    this.#rooms.set(name, room);
    this.#neverJoined.add(room);
    return room;
  }

  /**
   * Removes a connection from every room it belongs to, then discards any room
   * left empty.
   *
   * Costs O(rooms this connection is in) rather than O(all rooms), which for
   * the overwhelmingly common case — a peer in no rooms at all — is a single
   * failed map lookup.
   *
   * @param conn - The connection to evict
   */
  evict(conn: IWebSocketConnection): void {
    const joined = this.#membership.get(conn);
    if (joined !== undefined) {
      // Dropped up front so the `onLeave` each `remove` fires returns early
      // instead of mutating the set being iterated here. Discarding a room
      // left empty is `onLeave`'s job.
      this.#membership.delete(conn);
      for (const room of joined) {
        room.remove(conn);
      }
    }
    this.#reclaimNeverJoined();
  }

  /**
   * Delivers a frame that arrived from another replica to this replica's local
   * members.
   *
   * A room is looked up but never CREATED here. A remote frame naming a room
   * nobody on this replica has joined has no local audience, and creating one
   * per arriving name would let a cluster-wide namespace grow this replica's
   * room map without bound.
   *
   * @param name - The room the frame was addressed to
   * @param data - The decoded payload
   * @param exceptId - Connection ID the originating replica excluded, if any
   * @since 0.2.0
   */
  deliverRemote(name: string, data: string | Uint8Array, exceptId?: string): void {
    // `exactOptionalPropertyTypes` forbids handing through an explicit
    // `undefined`, so the absent case passes no options at all.
    this.#rooms.get(name)?.broadcastLocal(
      data,
      exceptId === undefined ? undefined : { exceptId },
    );
  }

  /** Discards every room. */
  clear(): void {
    this.#rooms.clear();
    this.#membership.clear();
    this.#neverJoined.clear();
  }

  /**
   * Discards rooms that were looked up but never joined.
   *
   * Every member of the set is, by construction, both empty and still the room
   * bound to its name: the only `add` path removes it from the set, `onLeave`
   * disposal can only fire for a room that had a member, and `clear` empties
   * `#rooms` and this set together. So each entry can be dropped by name
   * without re-checking either property.
   */
  #reclaimNeverJoined(): void {
    for (const room of this.#neverJoined) {
      this.#rooms.delete(room.name);
    }
    this.#neverJoined.clear();
  }
}
