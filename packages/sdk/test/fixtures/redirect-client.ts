/**
 * Auto-generated SDK client. Do not edit manually.
 * Redirects are followed by the transport and are not observable as response arms.
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
