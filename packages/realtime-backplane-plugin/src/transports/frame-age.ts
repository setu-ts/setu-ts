/** Wire-only timestamps and opt-in frame age filtering. @module */
import type { IRealtimeHandlerErrorReporter, RealtimeFrame } from '@setu-ts/common';

/** Existing handler reporter with an optional transport diagnostic sink. @since 0.14.0 */
export type BackplaneReporter = IRealtimeHandlerErrorReporter & {
  /**
   * Reports value-free frame transport diagnostics.
   * @param message - Fixed warning with numeric age and drop counts only
   * @returns Nothing
   * @throws Never; sink failures are swallowed
   * @since 0.14.0
   */
  readonly warn?: (message: string) => void;
};

/** Shared, clock-injected wire framing policy. Internal to the package. @since 0.14.0 */
export class FrameAge {
  readonly #max: number;
  readonly #now: (() => number) | undefined;
  readonly #warn: ((message: string) => void) | undefined;
  #dropped = 0;
  #oldest = 0;

  /**
   * @param max - Maximum age in milliseconds; zero disables filtering
   * @param now - Optional wall clock shared with the publisher's time base
   * @param warn - Optional warning sink
   * @returns The framing policy
   * @throws {RangeError} For a non-finite age outside the timer range
   * @since 0.14.0
   */
  constructor(max: number, now?: () => number, warn?: (message: string) => void) {
    if (!Number.isFinite(max) || max < 0 || max > 2147483647)
      throw new RangeError(
        'realtime-backplane maxFrameAgeMs must be a number from 0 to 2147483647',
      );
    this.#max = max;
    this.#now = now;
    this.#warn = warn;
    if (max > 0 && now === undefined)
      this.#write(
        'realtime-backplane maxFrameAgeMs requires a now clock; frames cannot be stamped or age-filtered',
      );
  }

  /**
   * Adds a timestamp without mutating the application frame.
   * @param frame - Outgoing frame
   * @returns The wire frame; unstamped when no clock is available
   * @throws When the supplied clock throws
   * @since 0.14.0
   */
  stamp(frame: RealtimeFrame): RealtimeFrame & { readonly sentAtMs?: number } {
    return this.#now === undefined ? frame : { ...frame, sentAtMs: this.#now() };
  }

  /**
   * Filters old frames and removes wire-only metadata before dispatch.
   * @param frame - Structurally validated incoming frame
   * @returns The clean frame, or null when older than the configured bound
   * @throws When the supplied clock throws
   * @since 0.14.0
   */
  receive(frame: RealtimeFrame & { readonly sentAtMs?: unknown }): RealtimeFrame | null {
    const { sentAtMs, ...clean } = frame;
    const age =
      this.#max > 0 &&
      this.#now !== undefined &&
      typeof sentAtMs === 'number' &&
      Number.isFinite(sentAtMs)
        ? this.#now() - sentAtMs
        : 0;
    if (age > this.#max) {
      this.#dropped++;
      this.#oldest = Math.max(this.#oldest, age);
      if (this.#dropped === 1)
        this.#write(
          `realtime-backplane dropping frames older than ${this.#max} ms; dropped ${this.#dropped}; the oldest was ${this.#oldest} ms; check the broker and the replicas' clocks`,
        );
      return null;
    }
    if (this.#dropped > 0) {
      this.#write(
        `realtime-backplane accepting frames again; dropped ${this.#dropped}; the oldest was ${this.#oldest} ms; check the broker and the replicas' clocks`,
      );
      this.#dropped = 0;
      this.#oldest = 0;
    }
    return clean;
  }

  /**
   * Reports an uncertain publication without claiming that it was lost.
   * @returns Nothing
   * @throws Never
   * @since 0.14.0
   */
  publishFailed(): void {
    this.#write(
      'realtime-backplane publish failed; the frame may still arrive late' +
        (this.#max > 0
          ? `; receivers configured with maxFrameAgeMs drop frames older than ${this.#max} ms`
          : ''),
    );
  }

  #write(message: string): void {
    try {
      this.#warn?.(message);
    } catch {
      /* Diagnostics cannot change delivery. */
    }
  }
}
