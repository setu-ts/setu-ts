/**
 * Named-channel registry for the SSE hub.
 *
 * Manages `SseChannel` instances (get-or-create, remove from all, clear) and
 * the membership-based broadcast logic. Internal — not exported from `src/index.ts`.
 *
 * @module
 * @since 0.1.0
 */

import type { ISseConnection, SseChannel, SseMessage } from '@setu-ts/common';

/** Membership resolver used by registry-backed handles. */
interface IChannelMembership {
  members(): ReadonlySet<ISseConnection> | undefined;
  add(conn: ISseConnection): void;
  remove(conn: ISseConnection): void;
}

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
  readonly #membership: IChannelMembership;
  readonly #name: string;
  readonly #publish: ChannelPublisher | undefined;

  /**
   * @param name - The channel name, needed so a published message can name its
   *   channel on the wire
   * @param publish - Forwards publishes to other replicas. Omit for a channel
   *   that stays in-process.
   * @param membership - Internal registry membership resolver; omitted for a standalone channel
   */
  constructor(name = '', publish?: ChannelPublisher, membership?: IChannelMembership) {
    this.#name = name;
    this.#publish = publish;
    const members = new Set<ISseConnection>();
    this.#membership = membership ?? {
      members: () => members,
      add: (conn): void => {
        members.add(conn);
      },
      remove: (conn): void => {
        members.delete(conn);
      },
    };
  }

  /** The channel name. */
  get name(): string {
    return this.#name;
  }

  get size(): number {
    return this.#membership.members()?.size ?? 0;
  }

  add(conn: ISseConnection): void {
    this.#membership.add(conn);
  }

  remove(conn: ISseConnection): void {
    this.#membership.remove(conn);
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
    const members = this.#membership.members();
    if (members === undefined) return;
    for (const conn of members) {
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
export const SSE_MAX_BACKLOG_BYTES: number = 1 * 1024 * 1024; // 1 MiB

/** High-water mark for the ReadableStream (bytes). */
export const SSE_HWM_BYTES: number = 64 * 1024; // 64 KiB

/**
 * Registry mapping channel names to {@linkcode SseChannelImpl} instances.
 *
 * @since 0.1.0
 */
export class ChannelRegistry {
  readonly #channels = new Map<string, { channel: SseChannelImpl; members: Set<ISseConnection> }>();
  #joined = new WeakMap<ISseConnection, Set<string>>();
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
   * Returns a handle resolving current membership by name. Empty handles are
   * not retained by the registry and remain usable after reclamation.
   *
   * @param name - Channel name
   * @returns The named channel
   * @since 0.1.0
   */
  get(name: string): SseChannelImpl {
    const existing = this.#channels.get(name);
    if (existing !== undefined) return existing.channel;
    const channel = new SseChannelImpl(name, this.#publish, {
      members: () => this.#channels.get(name)?.members,
      add: (conn) => this.#add(name, conn, channel),
      remove: (conn) => this.#remove(name, conn),
    });
    return channel;
  }

  /**
   * Returns a channel with members, without creating an entry. Empty channels
   * are reclaimed when their last member leaves.
   *
   * @param name - Channel name
   * @returns The channel, or `undefined` when it has no members
   * @since 0.4.0
   */
  peek(name: string): SseChannelImpl | undefined {
    return this.#channels.get(name)?.channel;
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
    this.#channels.get(name)?.channel.publishLocal(msg);
  }

  /** Total number of channels with members. */
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
    const names = this.#joined.get(conn);
    if (names === undefined) return;
    for (const name of names) this.#remove(name, conn);
  }

  /** Clears all channels. */
  clear(): void {
    this.#channels.clear();
    this.#joined = new WeakMap();
  }

  #add(name: string, conn: ISseConnection, channel: SseChannelImpl): void {
    let entry = this.#channels.get(name);
    if (entry === undefined) {
      entry = { channel, members: new Set() };
      this.#channels.set(name, entry);
    }
    entry.members.add(conn);
    let names = this.#joined.get(conn);
    if (names === undefined) {
      names = new Set();
      this.#joined.set(conn, names);
    }
    names.add(name);
  }

  #remove(name: string, conn: ISseConnection): void {
    const entry = this.#channels.get(name);
    if (entry === undefined) return;
    entry.members.delete(conn);
    if (entry.members.size === 0) this.#channels.delete(name);
    const names = this.#joined.get(conn);
    if (names === undefined) return;
    names.delete(name);
    if (names.size === 0) this.#joined.delete(conn);
  }
}
