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
 * A named group of connections that can be addressed as one.
 *
 * @since 0.1.0
 */
export class Room implements WebSocketRoom {
  readonly #name: string;
  readonly #members = new Set<IWebSocketConnection>();
  readonly #listener: RoomMembershipListener | undefined;

  /**
   * Creates a room.
   *
   * @param name - The room name
   * @param listener - Notified on every membership change. Supplied by a
   *   {@linkcode RoomRegistry}; omit for a standalone room.
   */
  constructor(name: string, listener?: RoomMembershipListener) {
    this.#name = name;
    this.#listener = listener;
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
    const except = options?.except;
    for (const member of this.#members) {
      if (member === except) {
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
    });
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
