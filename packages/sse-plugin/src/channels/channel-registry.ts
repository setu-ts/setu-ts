/**
 * Named-channel registry for the SSE hub.
 *
 * Manages `SseChannel` instances (get-or-create, remove from all, clear) and
 * the membership-based broadcast logic. Internal — not exported from `src/index.ts`.
 *
 * @module
 * @since 0.1.0
 */

import type { ISseConnection, SseChannel, SseMessage } from '@hono-enterprise/common';

/**
 * A named broadcast channel — maintains connection membership and publishes
 * messages to every open member, skipping closed ones.
 *
 * @since 0.1.0
 */
export class SseChannelImpl implements SseChannel {
  #members = new Set<ISseConnection>();

  get size(): number {
    return this.#members.size;
  }

  add(conn: ISseConnection): void {
    this.#members.add(conn);
  }

  remove(conn: ISseConnection): void {
    this.#members.delete(conn);
  }

  publish(msg: SseMessage): void {
    for (const conn of this.#members) {
      if (conn.isOpen) {
        try {
          conn.send(msg);
        } catch {
          // Silently skip a member whose send threw; it will be pruned on next cleanup.
        }
      }
    }
  }
}

/** Backpressure cap: when backlog exceeds this, send becomes a no-op after close. */
export const SSE_MAX_BACKLOG_BYTES = 1 * 1024 * 1024; // 1 MiB

/** High-water mark for the ReadableStream (bytes). */
export const SSE_HWM_BYTES = 64 * 1024; // 64 KiB

/**
 * Registry mapping channel names to {@linkcode SseChannelImpl} instances.
 *
 * @since 0.1.0
 */
export class ChannelRegistry {
  #channels = new Map<string, SseChannelImpl>();

  /**
   * Returns or creates a named channel.
   *
   * @param name - Channel name
   * @returns The named channel
   * @since 0.1.0
   */
  get(name: string): SseChannelImpl {
    let channel = this.#channels.get(name);
    if (!channel) {
      channel = new SseChannelImpl();
      this.#channels.set(name, channel);
    }
    return channel;
  }

  /** Total number of registered channels. */
  get size(): number {
    return this.#channels.size;
  }

  /**
   * Removes a connection from every channel's membership.
   *
   * @param conn - The connection to remove
   * @since 0.1.0
   */
  removeFromAll(conn: ISseConnection): void {
    for (const channel of this.#channels.values()) {
      channel.remove(conn);
    }
  }

  /** Clears all channels. */
  clear(): void {
    this.#channels.clear();
  }
}
