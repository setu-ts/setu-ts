/**
 * Auto-generated SDK client. Do not edit manually.
 */

import type { ClientResponse, IHttpClient, OperationRequestOptions } from '../../src/index.ts';

export type GetItemsResponse200 = {
  'total'?: number;
};

export type GetItemsResponse200Body = {
  'id'?: string;
};

export interface OptsArgs {
  filter?: string;
}

export interface Api {
  _client(_client: string, request?: OperationRequestOptions): Promise<ClientResponse<void>>;
  opts(
    _opts: string,
    opts?: OptsArgs,
    request?: OperationRequestOptions,
  ): Promise<ClientResponse<void>>;
  _encodeURIComponent(
    _encodeURIComponent: string,
    request?: OperationRequestOptions,
  ): Promise<ClientResponse<void>>;
  request(_request: string, request?: OperationRequestOptions): Promise<ClientResponse<void>>;
  getItems(request?: OperationRequestOptions): Promise<ClientResponse<GetItemsResponse200Body>>;
}

export function createApi(client: IHttpClient): Api {
  /** client */
  function _client(
    _client: string,
    request?: OperationRequestOptions,
  ): Promise<ClientResponse<void>> {
    return client.request<void>({
      method: 'GET',
      path: `clients/${encodeURIComponent(_client)}`,
      ...(request?.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
      ...(request?.signal === undefined ? {} : { signal: request.signal }),
    });
  }

  /** opts */
  function opts(
    _opts: string,
    opts?: OptsArgs,
    request?: OperationRequestOptions,
  ): Promise<ClientResponse<void>> {
    return client.request<void>({
      method: 'GET',
      path: `options/${encodeURIComponent(_opts)}`,
      query: { 'filter': opts?.filter },
      ...(request?.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
      ...(request?.signal === undefined ? {} : { signal: request.signal }),
    });
  }

  /** encodeURIComponent */
  function _encodeURIComponent(
    _encodeURIComponent: string,
    request?: OperationRequestOptions,
  ): Promise<ClientResponse<void>> {
    return client.request<void>({
      method: 'GET',
      path: `encoded/${encodeURIComponent(_encodeURIComponent)}`,
      ...(request?.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
      ...(request?.signal === undefined ? {} : { signal: request.signal }),
    });
  }

  /** request */
  function request(
    _request: string,
    request?: OperationRequestOptions,
  ): Promise<ClientResponse<void>> {
    return client.request<void>({
      method: 'GET',
      path: `requests/${encodeURIComponent(_request)}`,
      ...(request?.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
      ...(request?.signal === undefined ? {} : { signal: request.signal }),
    });
  }

  /** get-items */
  function getItems(
    request?: OperationRequestOptions,
  ): Promise<ClientResponse<GetItemsResponse200Body>> {
    return client.request<GetItemsResponse200Body>({
      method: 'GET',
      path: 'items',
      ...(request?.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
      ...(request?.signal === undefined ? {} : { signal: request.signal }),
    });
  }

  return {
    _client,
    opts,
    _encodeURIComponent,
    request,
    getItems,
  };
}
