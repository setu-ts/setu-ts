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
 * A named group of connections that can be addressed as one.
 *
 * @since 0.1.0
 */
export class Room implements WebSocketRoom {
  readonly #name: string;
  readonly #members = new Set<IWebSocketConnection>();

  /**
   * Creates a room.
   *
   * @param name - The room name
   */
  constructor(name: string) {
    this.#name = name;
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
    this.#members.add(conn);
  }

  remove(conn: IWebSocketConnection): void {
    this.#members.delete(conn);
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
        this.#members.delete(member);
        continue;
      }
      member.send(data);
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
    let room = this.#rooms.get(name);
    if (room === undefined) {
      room = new Room(name);
      this.#rooms.set(name, room);
    }
    return room;
  }

  /**
   * Removes a connection from every room it belongs to, then discards any room
   * left empty.
   *
   * @param conn - The connection to evict
   */
  evict(conn: IWebSocketConnection): void {
    for (const [name, room] of this.#rooms) {
      room.remove(conn);
      if (room.rawSize === 0) {
        this.#rooms.delete(name);
      }
    }
  }

  /** Discards every room. */
  clear(): void {
    this.#rooms.clear();
  }
}
