/**
 * HTTP probe indicator.
 *
 * @module
 */
import type { HealthCheckResult, IHealthIndicator } from '@hono-enterprise/common';

/**
 * Options for creating an HTTP probe indicator.
 *
 * @since 0.20.0
 */
export interface HttpIndicatorOptions {
  /** The URL to probe. */
  readonly url: string;

  /**
   * Timeout in milliseconds for the request.
   *
   * Defaults to `5000` (5 seconds).
   */
  readonly timeoutMs?: number;

  /**
   * Injectable fetcher for testing.
   *
   * Defaults to `globalThis.fetch`.
   */
  readonly fetcher?: typeof fetch;
}

/**
 * Creates an HTTP probe indicator.
 * Creates an HTTP probe indicator.
 *
 * This indicator performs an HTTP GET request to the specified URL and
 * reports 'up' if the response status is 2xx or 3xx, 'down' otherwise.
 *
 * The `fetcher` option allows injecting a custom fetch implementation
 * for testing purposes.
 *
 * @param name - Indicator name
 * @param options - Configuration options
 * @returns An indicator that probes an HTTP endpoint
 *
 * @example
 * ```typescript
 * const indicator = createHttpIndicator('external-api', {
 *   url: 'https://api.example.com/health',
 *   timeoutMs: 3000,
 * });
 * app.register(HealthPlugin({
 *   indicators: [indicator],
 * }));
 * ```
 *
 * @since 0.20.0
 */
export function createHttpIndicator(
  name: string,
  options: HttpIndicatorOptions,
): IHealthIndicator {
  const url = options.url;
  const timeoutMs = options.timeoutMs ?? 5000;
  const fetcher = options.fetcher ?? globalThis.fetch;

  return {
    name,
    async check(): Promise<HealthCheckResult> {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const startTime = performance.now();
        const response = await fetcher(url, {
          signal: controller.signal,
          method: 'GET',
        });
        const latencyMs = performance.now() - startTime;

        clearTimeout(timeoutId);

        // 2xx and 3xx are considered up
        if (response.status >= 200 && response.status < 400) {
          return {
            status: 'up',
            data: {
              statusCode: response.status,
              latencyMs: Math.round(latencyMs),
            } as Readonly<Record<string, unknown>>,
          };
        }

        // Any other status is down
        return {
          status: 'down',
          data: {
            statusCode: response.status,
            error: `Unexpected status code: ${response.status}`,
          } as Readonly<Record<string, unknown>>,
        };
      } catch (error) {
        clearTimeout(timeoutId);

        const errorMessage = error instanceof Error ? error.message : String(error);

        // Check if it was a timeout
        if (error instanceof DOMException && error.name === 'AbortError') {
          return {
            status: 'down',
            data: {
              error: 'timeout',
            } as Readonly<Record<string, unknown>>,
          };
        }

        return {
          status: 'down',
          data: {
            error: errorMessage,
          } as Readonly<Record<string, unknown>>,
        };
      }
    },
  };
}
