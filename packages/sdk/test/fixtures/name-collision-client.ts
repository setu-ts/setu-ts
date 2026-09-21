/**
 * Auto-generated SDK client. Do not edit manually.
 */

import type { ClientResponse, IHttpClient } from '../../src/index.ts';

export type GetItemsResponse200 = {
  'total'?: number;
};

export type GetItemsResponse200Body = {
  'id'?: string;
};

export interface Api {
  getItems(): Promise<ClientResponse<GetItemsResponse200Body>>;
}

export function createApi(client: IHttpClient): Api {
  /** get-items */
  function getItems(): Promise<ClientResponse<GetItemsResponse200Body>> {
    return client.request<GetItemsResponse200Body>({
      method: 'GET',
      path: 'items',
    });
  }

  return {
    getItems,
  };
}
