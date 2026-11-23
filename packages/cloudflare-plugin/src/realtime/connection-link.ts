/**
 * One client connection's link to the realtime hub Durable Object.
 *
 * workerd ties every I/O object to the request that created it. A link is
 * therefore opened from the request that accepted the client socket, and the
 * frames the hub sends it are delivered in that same request, the only place
 * the client socket may be written to.
 *
 * @module
 * @since 0.14.0
 */

import type {
  ILogger,
  IRealtimeConnectionLink,
  IRuntimeServices,
  RealtimeFrame,
  TimerHandle,
} from '@setu-ts/common';

import type { IServiceBinding } from '../bindings/facades.ts';
import type {
  DurableObjectMessageEvent,
  IDurableObjectClientSocket,
} from '../durable-objects/do-facades.ts';
import { asUpgradeResponse } from '../durable-objects/do-facades.ts';
import { isRealtimeFrame } from '../durable-objects/frame-guard.ts';

/** The synthetic URL a link is opened with. Only the path is meaningful. */
const LINK_URL = 'https://realtime-backplane.internal/link';

/** Frames queued while the link opens; beyond this the oldest is dropped. */
export const LINK_QUEUE_LIMIT = 64;

/** Delays before each reopen of a lost link. */
export const LINK_REOPEN_DELAYS_MS: readonly number[] = [500, 1000, 2000];

/**
 * What a {@linkcode ConnectionLink} needs.
 *
 * @since 0.14.0
 */
export interface ConnectionLinkOptions {
  /** Returns the hub's stub; called per open, from the owning request. */
  readonly hub: () => IServiceBinding;
  /** The Durable Object binding name, for error messages. */
  readonly binding: string;
  /** The topic, for the log line on a lost link. */
  readonly topic: string;
  /** The owning connection's id, for the log lines. */
  readonly connectionId: string;
  /** Receives every frame the hub sends, unfiltered. */
  readonly deliver: (frame: RealtimeFrame) => void;
  /** Timers for the reopen delays. */
  readonly timers: Pick<IRuntimeServices, 'setTimeout' | 'clearTimeout'>;
  /** Logger accessor, read when something is reported. */
  readonly logger?: () => ILogger | undefined;
}

/**
 * A link: opened at construction, queues frames until open, delivers what
 * arrives, reopens a lost socket up to three times, and closes with its
 * connection.
 *
 * @since 0.14.0
 */
export class ConnectionLink implements IRealtimeConnectionLink {
  readonly #options: ConnectionLinkOptions;
  readonly #queue: RealtimeFrame[] = [];
  #socket: IDurableObjectClientSocket | undefined;
  #closed = false;
  #reopens = 0;
  #timer: TimerHandle | undefined;
  #overflowReported = false;

  /**
   * Starts opening the link at once, from the caller's request.
   *
   * @param options - Hub, identity, delivery and timers
   */
  constructor(options: ConnectionLinkOptions) {
    this.#options = options;
    this.#open();
  }

  publish(frame: RealtimeFrame): boolean {
    if (this.#closed) return false;
    const socket = this.#socket;
    if (socket === undefined) {
      if (this.#queue.length >= LINK_QUEUE_LIMIT) {
        this.#queue.shift();
        if (!this.#overflowReported) {
          this.#overflowReported = true;
          this.#options.logger?.()?.warn('cloudflare: backplane link queue full, oldest dropped', {
            topic: this.#options.topic,
            connection: this.#options.connectionId,
            limit: LINK_QUEUE_LIMIT,
          });
        }
      }
      this.#queue.push(frame);
      return true;
    }
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      // A call from a request that does not own this socket throws in workerd;
      // the caller publishes through the hub instead.
      return false;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.length = 0;
    if (this.#timer !== undefined) {
      this.#options.timers.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket !== undefined) closeQuietly(socket);
  }

  /** One open attempt; failures and losses go through {@linkcode #lost}. */
  #open(): void {
    let pending: Promise<Response>;
    try {
      pending = this.#options.hub().fetch(LINK_URL, { headers: { Upgrade: 'websocket' } });
    } catch {
      this.#lost();
      return;
    }
    pending.then(
      (response) => {
        let socket: IDurableObjectClientSocket;
        try {
          socket = asUpgradeResponse(response, this.#options.binding).webSocket;
          socket.accept();
        } catch {
          this.#lost();
          return;
        }
        this.#attach(socket);
      },
      () => {
        this.#lost();
      },
    );
  }

  /** Publishes a live socket, or closes it when the link closed meanwhile. */
  #attach(socket: IDurableObjectClientSocket): void {
    if (this.#closed) {
      closeQuietly(socket);
      return;
    }
    socket.addEventListener('message', (event) => {
      this.#receive(event);
    });
    const dropped = (): void => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#lost();
    };
    socket.addEventListener('close', dropped);
    socket.addEventListener('error', dropped);
    this.#socket = socket;
    this.#reopens = 0;
    const queued = this.#queue.splice(0);
    for (const frame of queued) {
      try {
        socket.send(JSON.stringify(frame));
      } catch {
        // The socket went away while draining; the close listener reopens.
        break;
      }
    }
  }

  /** Schedules a reopen, or gives up after the last delay. */
  #lost(): void {
    if (this.#closed) return;
    const delay = LINK_REOPEN_DELAYS_MS[this.#reopens];
    if (delay === undefined) {
      this.#closed = true;
      this.#queue.length = 0;
      this.#options.logger?.()?.warn('cloudflare: backplane link lost', {
        topic: this.#options.topic,
        connection: this.#options.connectionId,
      });
      return;
    }
    this.#reopens++;
    // close() clears this timer, so it only fires on a link still open.
    this.#timer = this.#options.timers.setTimeout(() => {
      this.#timer = undefined;
      this.#open();
    }, delay);
  }

  /** Parses one arriving message; anything but a realtime frame is dropped. */
  #receive(event: DurableObjectMessageEvent): void {
    if (typeof event.data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!isRealtimeFrame(parsed)) return;
    try {
      this.#options.deliver(parsed);
    } catch {
      // A delivery failure belongs to the connection, not to the link.
    }
  }
}

/** Closes a socket without letting a failure escape. */
function closeQuietly(socket: IDurableObjectClientSocket): void {
  try {
    socket.close(1000, 'link closed');
  } catch {
    // Already closed.
  }
}
