/**
 * Auto-generated SDK client. Do not edit manually.
 * Followed redirect target bodies are not described here and are typed as unknown.
 */

import type { ClientResponse, IHttpClient, OperationRequestOptions } from '../../src/index.ts';
import { HttpClientError } from '../../src/index.ts';

export type FollowRedirectError = HttpClientError<unknown> & { readonly status: 303 };
export function isFollowRedirectError(e: unknown): e is FollowRedirectError {
  return e instanceof HttpClientError && (e.status === 303);
}

export interface Api {
  followRedirect(request?: OperationRequestOptions): Promise<ClientResponse<unknown>>;
}

export function createApi(client: IHttpClient): Api {
  /** followRedirect */
  function followRedirect(request?: OperationRequestOptions): Promise<ClientResponse<unknown>> {
    return client.request<unknown>({
      method: 'GET',
      path: 'redirect',
      ...(request?.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
      ...(request?.signal === undefined ? {} : { signal: request.signal }),
    });
  }

  return {
    followRedirect,
  };
}
