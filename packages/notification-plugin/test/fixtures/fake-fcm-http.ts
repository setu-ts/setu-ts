/**
 * Fake `INotificationHttp` for the two-call FCM flow: an OAuth2 token exchange
 * followed by a `messages:send`. Records every call and answers each URL
 * independently, which the single-response shared fake cannot express.
 *
 * @module
 */

import type { INotificationHttp, NotificationHttpResponse } from '../../src/interfaces/index.ts';

/** One recorded request. */
export interface RecordedCall {
  readonly url: string;
  readonly body: string;
  readonly headers: Record<string, string>;
}

/** A canned response for a matched URL. */
export interface StubResponse {
  readonly ok?: boolean;
  readonly status?: number;
  readonly text?: string;
}

/** Recording fake with per-URL routing. */
export interface FakeFcmHttp extends INotificationHttp {
  /** Every call, in order. */
  readonly calls: RecordedCall[];
  /** Calls whose URL contains `fragment`. */
  callsMatching(fragment: string): RecordedCall[];
}

/**
 * Creates a fake HTTP seam answering the token endpoint and the send endpoint
 * separately.
 *
 * @param opts - Per-endpoint responses; each defaults to a success
 * @returns The recording fake
 * @since 0.1.0
 */
export function createFakeFcmHttp(opts?: {
  token?: StubResponse;
  send?: StubResponse;
}): FakeFcmHttp {
  const calls: RecordedCall[] = [];

  const answer = (
    stub: StubResponse | undefined,
    fallbackText: string,
  ): NotificationHttpResponse => ({
    ok: stub?.ok ?? true,
    status: stub?.status ?? 200,
    text: stub?.text ?? fallbackText,
  });

  return {
    calls,
    post(
      url: string,
      body: string,
      headers: Record<string, string>,
    ): Promise<NotificationHttpResponse> {
      calls.push({ url, body, headers });
      if (url.includes('oauth2.googleapis.com')) {
        return Promise.resolve(
          answer(opts?.token, JSON.stringify({ access_token: 'test-token', expires_in: 3600 })),
        );
      }
      return Promise.resolve(answer(opts?.send, '{}'));
    },
    callsMatching(fragment: string): RecordedCall[] {
      return calls.filter((call) => call.url.includes(fragment));
    },
  };
}
