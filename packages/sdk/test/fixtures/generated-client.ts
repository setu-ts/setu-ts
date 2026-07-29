/* eslint-disable */
/**
 * Auto-generated SDK client. Do not edit manually.
 */

import type { ClientResponse, IHttpClient } from '../../src/index.ts';

export type user = {
    'id': string;
    'name': string;
    'email'?: string;
};

export interface listusersArgs {
    page?: number;
    limit?: number;
    xApiKey?: string;
}


export function createApi(client: IHttpClient) {

    /** listUsers */
    function listusers(opts?: listusersArgs): Promise<ClientResponse<user[]>> {
        return client.request<user[]>({
            method: 'GET',
            path: 'users',
            query: { 'page': (opts?.page as number | undefined), 'limit': (opts?.limit as number | undefined) },
            headers: (() => {
                const headers: Record<string, string> = {};
                if (opts?.xApiKey !== undefined) headers['X-API-Key'] = opts?.xApiKey;
                return headers;
            })(),
        });
    }

    /** getUserById */
    function getuserbyid(id: string): Promise<ClientResponse<user>> {
        return client.request<user>({
            method: 'GET',
            path: 'users' + "/" + encodeURIComponent(id),
        });
    }

    return {
        listusers,
        getuserbyid,
    };
}
