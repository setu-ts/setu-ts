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
 * Forwards a local publish to peers on other replicas.
 *
 * Supplied by a {@linkcode ChannelRegistry} that was given a backplane. A
 * channel built without one publishes purely in-process, which is the behavior
 * every application had before the backplane existed.
 *
 * @param name - The channel the message was published to
 * @param msg - The message, exactly as handed to `publish`
 * @since 0.2.0
 */
export type ChannelPublisher = (name: string, msg: SseMessage) => void;

/**
 * A named broadcast channel — maintains connection membership and publishes
 * messages to every open member, skipping closed ones.
 *
 * @since 0.1.0
 */
export class SseChannelImpl implements SseChannel {
  #members = new Set<ISseConnection>();
  readonly #name: string;
  readonly #publish: ChannelPublisher | undefined;

  /**
   * @param name - The channel name, needed so a published message can name its
   *   channel on the wire
   * @param publish - Forwards publishes to other replicas. Omit for a channel
   *   that stays in-process.
   */
  constructor(name = '', publish?: ChannelPublisher) {
    this.#name = name;
    this.#publish = publish;
  }

  /** The channel name. */
  get name(): string {
    return this.#name;
  }

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
    this.publishLocal(msg);
    // Published after local delivery so a transport error can never cost local
    // members their message.
    this.#publish?.(this.#name, msg);
  }

  /**
   * Delivers to this replica's own members only, without forwarding to the
   * backplane.
   *
   * This is the delivery path for a message that ARRIVED from another replica:
   * re-publishing it would echo it around the cluster forever. Applications
   * call {@linkcode SseChannelImpl.publish}; only the plugin's backplane
   * subscriber calls this.
   *
   * @param msg - The message to deliver
   * @since 0.2.0
   */
  publishLocal(msg: SseMessage): void {
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
  readonly #publish: ChannelPublisher | undefined;

  /**
   * @param publish - Forwards every channel publish to other replicas. Omit for
   *   purely in-process channels, which is the behavior when no backplane
   *   capability is registered.
   */
  constructor(publish?: ChannelPublisher) {
    this.#publish = publish;
  }

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
      channel = new SseChannelImpl(name, this.#publish);
      this.#channels.set(name, channel);
    }
    return channel;
  }

  /**
   * Delivers a message that arrived from another replica to this replica's
   * local members.
   *
   * A channel is looked up but never CREATED here. A remote message naming a
   * channel nobody on this replica subscribes to has no local audience, and
   * creating one per arriving name would let a cluster-wide namespace grow this
   * replica's channel map without bound.
   *
   * @param name - The channel the message was addressed to
   * @param msg - The decoded message
   * @since 0.2.0
   */
  deliverRemote(name: string, msg: SseMessage): void {
    this.#channels.get(name)?.publishLocal(msg);
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
