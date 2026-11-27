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
import { MAX_FRAME_BYTES } from '../durable-objects/realtime-backplane-object.ts';

/** The synthetic URL a link is opened with. Only the path is meaningful. */
const LINK_URL = 'https://realtime-backplane.internal/link';

/** Frames queued while the link opens; beyond this the oldest is dropped. */
export const LINK_QUEUE_LIMIT = 64;

/**
 * Bytes of frame data (`frame.data.length`, the encoded payload) a link queues
 * while it opens. A frame that would take the queue past this is not queued:
 * `publish` returns `false` and the caller publishes it through the hub.
 */
export const LINK_QUEUE_BYTE_BUDGET = 1_048_576;

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
  /**
   * Keeps an early close's flush alive after its connection's request ends
   * (the backplane's `waitUntil`). Absent, the flush runs unprotected.
   */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
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
  /** `frame.data.length` summed over {@linkcode #queue}. */
  #queuedBytes = 0;
  #socket: IDurableObjectClientSocket | undefined;
  #closed = false;
  /**
   * Set by `close()` while frames are still queued for a socket not yet open:
   * the link opens, sends them, then closes, so a connection that leaves
   * before its link opened does not lose what it already broadcast.
   */
  #flushing = false;
  /** The open in flight, so an early close can hand it to `waitUntil`. */
  #opening: Promise<void> | undefined;
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
    const size = frame.data.length;
    // Above the hub's cap no socket message can carry it either; the hub's
    // HTTP publish answers it with a 413 the caller reports. The serialized
    // frame is never shorter than its data, so this is checked before
    // serializing.
    if (size > MAX_FRAME_BYTES) return false;
    const socket = this.#socket;
    if (socket === undefined) {
      // Within the budget a frame serializes far below the hub's cap, so a
      // queued frame needs no measuring.
      // A full queue drops its oldest frame to take this one, so those bytes
      // are free for it.
      const full = this.#queue.length >= LINK_QUEUE_LIMIT;
      const freed = full ? (this.#queue[0]?.data.length ?? 0) : 0;
      if (this.#queuedBytes - freed + size > LINK_QUEUE_BYTE_BUDGET) return false;
      if (full) {
        this.#shift();
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
      this.#queuedBytes += size;
      return true;
    }
    const message = JSON.stringify(frame);
    // The cap is on the bytes of the whole serialized frame.
    if (exceedsHubCap(message)) return false;
    try {
      socket.send(message);
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
    if (this.#socket === undefined && this.#queue.length > 0 && this.#timer === undefined) {
      // Opening now: deliver nothing more, but send what was queued once open,
      // kept alive past this connection's request where the platform allows.
      this.#flushing = true;
      if (this.#opening !== undefined) keepAliveQuietly(this.#options.waitUntil, this.#opening);
      return;
    }
    if (this.#socket === undefined && this.#timer === undefined && this.#opening !== undefined) {
      // An open is in flight with nothing to send: `#attach` closes its socket
      // when it arrives. Kept alive past this connection's request, or a
      // request that has ended takes that close with it and the hub keeps the
      // socket open.
      keepAliveQuietly(this.#options.waitUntil, this.#opening);
    }
    if (this.#queue.length > 0) {
      // Closed while waiting to reopen: nothing can carry these any more.
      this.#options.logger?.()?.warn('cloudflare: backplane link closed with frames unsent', {
        topic: this.#options.topic,
        connection: this.#options.connectionId,
        dropped: this.#queue.length,
      });
    }
    this.#clearQueue();
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
    this.#opening = pending.then(
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
    if (this.#flushing) {
      this.#flushing = false;
      const unsent = this.#drain(socket);
      if (unsent > 0) {
        // Closing: nothing will reopen to carry these. Said once, without
        // frame content.
        this.#options.logger?.()?.warn('cloudflare: backplane link closed with frames unsent', {
          topic: this.#options.topic,
          connection: this.#options.connectionId,
          dropped: unsent,
        });
        this.#clearQueue();
      }
      closeQuietly(socket);
      return;
    }
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
    // A send that throws leaves the rest queued: the socket went away while
    // draining, and the close listener reopens to send them.
    this.#drain(socket);
  }

  /**
   * Sends queued frames in order, removing each only once its send returned,
   * so a failure keeps the frames not yet tried and never repeats one sent.
   *
   * @returns How many frames are still queued
   */
  #drain(socket: IDurableObjectClientSocket): number {
    while (this.#queue.length > 0) {
      try {
        socket.send(JSON.stringify(this.#queue[0]));
      } catch {
        break;
      }
      this.#shift();
    }
    return this.#queue.length;
  }

  /** Takes the oldest queued frame off the queue and its bytes off the budget. */
  #shift(): void {
    const frame = this.#queue.shift();
    if (frame !== undefined) this.#queuedBytes -= frame.data.length;
  }

  /** Empties the queue and its byte count. */
  #clearQueue(): void {
    this.#queue.length = 0;
    this.#queuedBytes = 0;
  }

  /** Schedules a reopen, or gives up after the last delay. */
  #lost(): void {
    if (this.#flushing) {
      // The link closed before it opened and the open failed: what it had
      // queued cannot be sent. Said once, without frame content.
      this.#flushing = false;
      this.#options.logger?.()?.warn('cloudflare: backplane link closed before its socket opened', {
        topic: this.#options.topic,
        connection: this.#options.connectionId,
        dropped: this.#queue.length,
      });
      this.#clearQueue();
      return;
    }
    if (this.#closed) return;
    const delay = LINK_REOPEN_DELAYS_MS[this.#reopens];
    if (delay === undefined) {
      this.#closed = true;
      this.#clearQueue();
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

/**
 * Hands a promise to the platform's `waitUntil`, if any. A host that throws
 * (called outside a request) loses only the extension, never the work.
 */
export function keepAliveQuietly(
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
  promise: Promise<unknown>,
): void {
  try {
    waitUntil?.(promise);
  } catch {
    // The work still runs; only the extension is lost.
  }
}

/**
 * Whether `message` is more than the hub's cap in UTF-8 bytes. Each UTF-16
 * unit encodes to at most three bytes, so a short message is answered without
 * encoding it.
 */
function exceedsHubCap(message: string): boolean {
  if (message.length * 3 <= MAX_FRAME_BYTES) return false;
  return new TextEncoder().encode(message).byteLength > MAX_FRAME_BYTES;
}
