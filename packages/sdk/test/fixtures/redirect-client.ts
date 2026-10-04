/**
 * Auto-generated SDK client. Do not edit manually.
 * Followed redirect target bodies are not described here and are typed as unknown.
 */

import type { ClientResponse, IHttpClient } from '../../src/index.ts';

export interface Api {
  followRedirect(): Promise<ClientResponse<unknown>>;
}

export function createApi(client: IHttpClient): Api {
  /** followRedirect */
  function followRedirect(): Promise<ClientResponse<unknown>> {
    return client.request<unknown>({
      method: 'GET',
      path: 'redirect',
    });
  }

  return {
    followRedirect,
  };
}
