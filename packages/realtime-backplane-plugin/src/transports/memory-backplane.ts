/**
 * In-process backplane transport.
 *
 * @module
 * @since 0.2.0
 */

import type {
  IRealtimeBackplane,
  RealtimeFrame,
  RealtimeFrameHandler,
} from '@hono-enterprise/common';

/**
 * A process-wide bus. Named buses stay isolated from one another, so
 * concurrent tests (and two independent applications hosted in one process) do
 * not bleed into each other.
 */
const BUSES = new Map<string, Set<MemoryBackplane>>();

/**
 * A real single-process backplane.
 *
 * This is the default transport, and deliberately not a no-op: an application
 * that registers the plugin without configuring a transport gets working
 * fan-out between backplanes in the same process. What it does not do is
 * cross a process boundary — for that, configure `'messaging'` or `'redis'`.
 *
 * @example
 * ```typescript
 * const a = new MemoryBackplane('node-a');
 * const b = new MemoryBackplane('node-b');
 * await a.connect();
 * await b.connect();
 * await b.subscribe((frame) => console.log(frame.name));
 * await a.publish({ kind: 'ws-room', origin: a.origin, name: 'lobby', data: 'hi' });
 * ```
 * @since 0.2.0
 */
export class MemoryBackplane implements IRealtimeBackplane {
  readonly origin: string;
  readonly #bus: string;
  readonly #handlers = new Set<RealtimeFrameHandler>();
  #connected = false;

  /**
   * @param origin - This instance's identity
   * @param bus - The process-wide bus name to join
   */
  constructor(origin: string, bus = 'default') {
    this.origin = origin;
    this.#bus = bus;
  }

  connect(): Promise<void> {
    if (this.#connected) {
      return Promise.resolve();
    }
    this.#connected = true;
    let members = BUSES.get(this.#bus);
    if (members === undefined) {
      members = new Set<MemoryBackplane>();
      BUSES.set(this.#bus, members);
    }
    members.add(this);
    return Promise.resolve();
  }

  publish(frame: RealtimeFrame): Promise<void> {
    const members = BUSES.get(this.#bus);
    if (members === undefined) {
      return Promise.resolve();
    }
    for (const member of members) {
      // A local broadcast has already reached local members directly, so the
      // publisher never redelivers to itself.
      if (member === this) {
        continue;
      }
      member.#deliver(frame);
    }
    return Promise.resolve();
  }

  subscribe(handler: RealtimeFrameHandler): Promise<() => void> {
    this.#handlers.add(handler);
    return Promise.resolve(() => {
      this.#handlers.delete(handler);
    });
  }

  close(): Promise<void> {
    this.#handlers.clear();
    this.#connected = false;
    const members = BUSES.get(this.#bus);
    if (members !== undefined) {
      members.delete(this);
      if (members.size === 0) {
        // Reclaimed so an unbounded key space of test bus names cannot leak.
        BUSES.delete(this.#bus);
      }
    }
    return Promise.resolve();
  }

  /**
   * Hands a frame to this instance's handlers, dropping any that carries this
   * instance's own origin.
   *
   * @param frame - The arriving frame
   */
  #deliver(frame: RealtimeFrame): void {
    if (frame.origin === this.origin) {
      return;
    }
    for (const handler of this.#handlers) {
      handler(frame);
    }
  }
}
