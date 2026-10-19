/**
 * Auto-generated SDK client. Do not edit manually.
 */

import type { ClientResponse, IHttpClient, OperationRequestOptions } from '../../src/index.ts';
import { HttpClientError } from '../../src/index.ts';

export type User = {
  'id': string;
  'name': string;
  'email'?: string;
};
export type NotFound = {
  'code': string;
  'detail'?: string;
};

export type GetUserByIdError409Body = {
  'conflictingId': string;
};

export interface ListUsersArgs {
  page?: number;
  limit?: number;
  xAPIKey?: string;
}

export type GetUserByIdError =
  | (HttpClientError<NotFound> & { readonly status: 404 })
  | (HttpClientError<GetUserByIdError409Body> & { readonly status: 409 });
export function isGetUserByIdError(e: unknown): e is GetUserByIdError {
  return e instanceof HttpClientError && (e.status === 404 || e.status === 409);
}

export interface Api {
  listUsers(
    opts?: ListUsersArgs,
    request?: OperationRequestOptions,
  ): Promise<ClientResponse<User[]>>;
  getUserById(id: string, request?: OperationRequestOptions): Promise<ClientResponse<User>>;
}

export function createApi(client: IHttpClient): Api {
  /** listUsers */
  function listUsers(
    opts?: ListUsersArgs,
    request?: OperationRequestOptions,
  ): Promise<ClientResponse<User[]>> {
    return client.request<User[]>({
      method: 'GET',
      path: 'users',
      query: { 'page': opts?.page, 'limit': opts?.limit },
      headers: (() => {
        const headers: Record<string, string> = {};
        if (opts?.xAPIKey !== undefined) {
          headers['X-API-Key'] = String(opts?.xAPIKey);
        }
        return headers;
      })(),
      ...(request?.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
      ...(request?.signal === undefined ? {} : { signal: request.signal }),
    });
  }

  /** getUserById */
  function getUserById(
    id: string,
    request?: OperationRequestOptions,
  ): Promise<ClientResponse<User>> {
    return client.request<User>({
      method: 'GET',
      path: `users/${encodeURIComponent(id)}`,
      ...(request?.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
      ...(request?.signal === undefined ? {} : { signal: request.signal }),
    });
  }

  return {
    listUsers,
    getUserById,
  };
}
