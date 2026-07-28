/**
 * Internal per-origin sliding-window rate limiter for the SDK HTTP client.
 *
 * Maintains a queue of request timestamps per origin and admits requests when
 * the window has capacity. When full, waits until the oldest timestamp expires.
 *
 * @internal
 */

import type { IClientTiming } from './contracts.ts';

/**
 * Create a per-origin rate limiter.
 *
 * @internal
 */
export function createRateLimiter(maxRequests: number, windowMs: number, timing: IClientTiming) {
  const timestamps: number[] = [];

  const acquire = async (signal?: AbortSignal): Promise<void> => {
    while (true) {
      // Check if aborted before waiting.
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      }

      const now = timing.now();

      // Evict expired timestamps.
      while (timestamps.length > 0 && now - timestamps[0]! >= windowMs) {
        timestamps.shift();
      }

      if (timestamps.length < maxRequests) {
        // Admit: record timestamp and proceed.
        timestamps.push(now);
        return;
      }

      // Window is full — wait until the oldest timestamp expires.
      const oldest = timestamps[0]!;
      const waitMs = windowMs - (now - oldest);

      if (waitMs > 0) {
        try {
          await timing.sleep(waitMs, signal);
        } catch {
          // If abort, re-check at the top of the loop (which throws).
          continue;
        }
      }
    }
  };

  return { acquire };
}
