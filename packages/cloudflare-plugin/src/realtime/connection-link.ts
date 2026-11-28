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
 * Bytes of frame data a link queues while it opens, counted as the UTF-8
 * length of `frame.data` (the encoded payload), the unit the hub's cap is
 * measured in. A frame that would take the queue past this is not queued:
 * `publish` returns `false` and the caller publishes it through the hub.
 */
export const LINK_QUEUE_BYTE_BUDGET = 1_048_576;

/** Delays before the first reopens of a lost link; later ones double from the last. */
export const LINK_REOPEN_DELAYS_MS: readonly number[] = [500, 1000, 2000];

/** The last of {@linkcode LINK_REOPEN_DELAYS_MS}, which later reopens double from. */
const LAST_FIXED_DELAY_MS = 2000;

/**
 * The longest wait between reopens. A link never stops reopening while its
 * connection is open, so this bounds how stale a recovered hub can find it.
 */
export const LINK_REOPEN_MAX_DELAY_MS = 30_000;

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
   * Keeps an early close's work alive after its connection's request ends
   * (the backplane's `waitUntil`): the flush of queued frames, or with none
   * queued the open in flight, whose socket is then closed. Absent, both run
   * unprotected, and on workerd the hub can keep that socket open.
   */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * A link: opened at construction, queues frames until open, delivers what
 * arrives, reopens a lost socket until its connection closes it, and closes
 * with its connection.
 *
 * @since 0.14.0
 */
export class ConnectionLink implements IRealtimeConnectionLink {
  readonly #options: ConnectionLinkOptions;
  /** Queued frames, each with the UTF-8 length of its data. */
  readonly #queue: { readonly frame: RealtimeFrame; readonly bytes: number }[] = [];
  /** The `bytes` of {@linkcode #queue}, summed. */
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
  /** Set once an outage passed the routine reopens and was warned about. */
  #outageReported = false;
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
    // Above the hub's cap no socket message can carry it either; the hub's
    // HTTP publish answers it with a 413 the caller reports. The serialized
    // frame is never shorter than its data, so this is checked before
    // serializing.
    if (frame.data.length > MAX_FRAME_BYTES) return false;
    const socket = this.#socket;
    if (socket === undefined) {
      // In an outage past the routine reopens a queued frame could reach
      // other replicas minutes late; the caller publishes through the hub.
      if (this.#outageReported) return false;
      // Within the budget a frame serializes far below the hub's cap, so a
      // queued frame needs no measuring beyond its data.
      // A full queue drops its oldest frame to take this one, so those bytes
      // are free for it.
      const full = this.#queue.length >= LINK_QUEUE_LIMIT;
      const freed = full ? (this.#queue[0]?.bytes ?? 0) : 0;
      const room = LINK_QUEUE_BYTE_BUDGET - this.#queuedBytes + freed;
      // A string is never shorter in UTF-8 bytes than in units, so a frame
      // already too long in units is refused without counting it.
      if (frame.data.length > room) return false;
      const size = utf8ByteLength(frame.data);
      if (size > room) return false;
      if (full) {
        this.#shift();
        if (!this.#overflowReported) {
          this.#overflowReported = true;
          this.#report('warn', 'cloudflare: backplane link queue full, oldest dropped', {
            limit: LINK_QUEUE_LIMIT,
          });
        }
      }
      this.#queue.push({ frame, bytes: size });
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
      this.#report('warn', 'cloudflare: backplane link closed with frames unsent', {
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
        this.#report('warn', 'cloudflare: backplane link closed with frames unsent', {
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
    if (this.#outageReported) {
      this.#outageReported = false;
      this.#report('info', 'cloudflare: backplane link restored');
    }
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
        socket.send(JSON.stringify(this.#queue[0]?.frame));
      } catch {
        break;
      }
      this.#shift();
    }
    return this.#queue.length;
  }

  /** Takes the oldest queued frame off the queue and its bytes off the budget. */
  #shift(): void {
    const entry = this.#queue.shift();
    if (entry !== undefined) this.#queuedBytes -= entry.bytes;
  }

  /** Empties the queue and its byte count. */
  #clearQueue(): void {
    this.#queue.length = 0;
    this.#queuedBytes = 0;
  }

  /**
   * Schedules the next reopen. A link reopens for as long as its connection is
   * open, backing off to {@linkcode LINK_REOPEN_MAX_DELAY_MS}. Once the routine
   * reopens have failed, the outage is warned about once (with how many queued
   * frames it dropped, never their content), and the link refuses frames
   * until it recovers.
   */
  #lost(): void {
    if (this.#flushing) {
      // The link closed before it opened and the open failed: what it had
      // queued cannot be sent. Said once, without frame content.
      this.#flushing = false;
      this.#report('warn', 'cloudflare: backplane link closed before its socket opened', {
        dropped: this.#queue.length,
      });
      this.#clearQueue();
      return;
    }
    if (this.#closed) return;
    if (this.#reopens >= LINK_REOPEN_DELAYS_MS.length && !this.#outageReported) {
      // What was queued is now stale; dropped rather than sent in a burst on
      // recovery, and new frames are refused until then.
      this.#outageReported = true;
      const dropped = this.#queue.length;
      this.#clearQueue();
      this.#report('warn', 'cloudflare: backplane link still reopening', { dropped });
    }
    const delay = reopenDelay(this.#reopens);
    this.#reopens++;
    // close() clears this timer, so it only fires on a link still open.
    this.#timer = this.#options.timers.setTimeout(() => {
      this.#timer = undefined;
      this.#open();
    }, delay);
  }

  /**
   * Logs a link event with its topic and connection, never frame content. A
   * logger that throws loses only the line: never a frame, a close or a reopen.
   */
  #report(
    level: 'warn' | 'info',
    message: string,
    extra?: Readonly<Partial<Record<'dropped' | 'limit', number>>>,
  ): void {
    try {
      this.#options.logger?.()?.[level](message, {
        topic: this.#options.topic,
        connection: this.#options.connectionId,
        ...extra,
      });
    } catch {
      // Only the log line is lost.
    }
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

/**
 * The wait before reopen number `attempt` (from 0): the fixed delays first,
 * then doubling from the last, capped at {@linkcode LINK_REOPEN_MAX_DELAY_MS}.
 */
function reopenDelay(attempt: number): number {
  const fixed = LINK_REOPEN_DELAYS_MS[attempt];
  if (fixed !== undefined) return fixed;
  const doublings = attempt - LINK_REOPEN_DELAYS_MS.length + 1;
  // Bounded so a link that has retried for days cannot overflow the product.
  return Math.min(LINK_REOPEN_MAX_DELAY_MS, LAST_FIXED_DELAY_MS * 2 ** Math.min(doublings, 32));
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
 * counting it.
 */
function exceedsHubCap(message: string): boolean {
  if (message.length * 3 <= MAX_FRAME_BYTES) return false;
  return utf8ByteLength(message) > MAX_FRAME_BYTES;
}

/**
 * The length of `text` once UTF-8 encoded, as `TextEncoder` encodes it (a lone
 * surrogate as U+FFFD, three bytes), counted without encoding.
 *
 * @param text - Any string
 * @returns Its UTF-8 byte length
 */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && isLowSurrogate(text.charCodeAt(i + 1))) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** Whether a UTF-16 unit is a low (trailing) surrogate; `NaN` past the end is not. */
function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}
