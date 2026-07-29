// deno-lint-ignore-file
/**
 * Auto-generated SDK client. Do not edit manually.
 */

import type { ClientResponse, IHttpClient } from '../../src/index.ts';

export type User = {
    'id': string;
    'name': string;
    'email'?: string;
};

export interface ListUsersArgs {
    page?: number;
    limit?: number;
    xAPIKey?: string;
}

export function createApi(client: IHttpClient) {

    /** listUsers */
    function listUsers(opts?: ListUsersArgs): Promise<ClientResponse<User[]>> {
        return client.request<User[]>({
            method: 'GET',
            path: 'users',
            query: { 'page': opts?.page, 'limit': opts?.limit },
            headers: (() => {
                const headers: Record<string, string> = {};
                if (opts?.xAPIKey !== undefined) headers['X-API-Key'] = String(opts?.xAPIKey);
                return headers;
            })(),
        });
    }

    /** getUserById */
    function getUserById(id: string): Promise<ClientResponse<User>> {
        return client.request<User>({
            method: 'GET',
            path: `users/${encodeURIComponent(id)}`,
        });
    }

    return {
        listUsers,
        getUserById,
    };
}
