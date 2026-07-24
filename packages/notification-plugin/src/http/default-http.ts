/**
 * Default `INotificationHttp` backed by web-standard `fetch`.
 *
 * @module
 */

import type { INotificationHttp, NotificationHttpResponse } from '../interfaces/index.ts';

/**
 * Creates the default fetch-backed {@linkcode INotificationHttp}.
 *
 * @param fetchImpl - The fetch function to use (defaults to global `fetch`)
 * @returns The notification HTTP adapter
 * @since 0.1.0
 */
export function createDefaultNotificationHttp(
  fetchImpl: typeof fetch = fetch,
): INotificationHttp {
  return {
    async post(
      url: string,
      body: string,
      headers: Record<string, string>,
    ): Promise<NotificationHttpResponse> {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body,
      });
      const text = await response.text();
      return { ok: response.ok, status: response.status, text };
    },
  };
}
