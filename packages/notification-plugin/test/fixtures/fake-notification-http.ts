/**
 * Fake `INotificationHttp` recording the last `(url, body, headers)` call
 * with a controllable response.
 *
 * @module
 */

import type { INotificationHttp, NotificationHttpResponse } from '../../src/interfaces/index.ts';

/** Extended fake that includes recording helpers beyond the `INotificationHttp` interface. */
export interface FakeNotificationHttp extends INotificationHttp {
  /** Returns the last recorded `(url, body, headers)` call or `undefined`. */
  getLastCall(): { url: string; body: string; headers: Record<string, string> } | undefined;
  /** Resets the recorded call. */
  reset(): void;
}

/**
 * Creates a fake `INotificationHttp` that records calls.
 *
 * @param opts - Optional configuration
 * @returns The fake HTTP seam
 * @since 0.1.0
 */
export function createFakeNotificationHttp(opts?: {
  responseBody?: string;
  responseOk?: boolean;
  responseStatus?: number;
}): FakeNotificationHttp {
  let lastCall: { url: string; body: string; headers: Record<string, string> } | undefined;

  return {
    post(
      _url: string,
      _body: string,
      _headers: Record<string, string>,
    ): Promise<NotificationHttpResponse> {
      lastCall = { url: _url, body: _body, headers: _headers };
      const resp: NotificationHttpResponse = {
        ok: opts?.responseOk ?? true,
        status: opts?.responseStatus ?? 200,
        text: opts?.responseBody ?? 'ok',
      };
      return Promise.resolve(resp);
    },

    /** Returns the last recorded call or `undefined`. */
    getLastCall(): typeof lastCall {
      return lastCall;
    },

    /** Resets the recorded call. */
    reset(): void {
      lastCall = undefined;
    },
  };
}
