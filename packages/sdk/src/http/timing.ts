/**
 * Default client timing implementation using web-standard APIs.
 *
 * `now()` delegates to `performance.now()` (monotonic). `sleep()` uses
 * `setTimeout` and honors an optional `AbortSignal`.
 *
 * @module
 */

import type { IClientTiming } from './contracts.ts';

/**
 * Factory returning the default `IClientTiming` backed by
 * `performance.now()` and `setTimeout`.
 *
 * @since 0.1.0
 */
export function createDefaultClientTiming(): IClientTiming {
  return {
    now(): number {
      return performance.now();
    },

    sleep(ms: number, signal?: AbortSignal): Promise<void> {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
          return;
        }

        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, ms);

        const onAbort = () => {
          cleanup();
          reject(signal!.reason ?? new DOMException('Aborted', 'AbortError'));
        };

        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        };

        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}
