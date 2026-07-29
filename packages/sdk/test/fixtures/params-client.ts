// deno-lint-ignore-file
/**
 * Auto-generated SDK client. Do not edit manually.
 */

import type { ClientResponse, IHttpClient } from '../../src/index.ts';

export type User = {
    'id': string;
    'age'?: number;
    'nickname'?: string | null;
};

export interface PingServiceArgs {
    xRetryCount?: number;
    xAPIKey?: string;
}

export interface SearchEverythingArgs {
    q?: string;
    xCustom?: string;
}

export interface CreateReportArgs {
    format: 'pdf' | 'csv';
    body: User;
}

export interface UpdateNoteArgs {
    body?: Record<string, unknown>;
}

export function createApi(client: IHttpClient) {

    /** pingService */
    function pingService(opts?: PingServiceArgs): Promise<ClientResponse<void>> {
        return client.request<void>({
            method: 'GET',
            path: 'ping',
            headers: (() => {
                const headers: Record<string, string> = {};
                if (opts?.xRetryCount !== undefined) headers['X-Retry-Count'] = String(opts?.xRetryCount);
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

    /** searchEverything */
    function searchEverything(opts?: SearchEverythingArgs): Promise<ClientResponse<string[]>> {
        return client.request<string[]>({
            method: 'GET',
            path: 'search',
            query: { 'q': opts?.q },
            headers: (() => {
                const headers: Record<string, string> = {};
                if (opts?.xCustom !== undefined) headers['X-Custom'] = String(opts?.xCustom);
                return headers;
            })(),
        });
    }

    /** downloadFileMetadata */
    function downloadFileMetadata(tenantId: string, fileId: string): Promise<ClientResponse<Record<string, unknown>>> {
        return client.request<Record<string, unknown>>({
            method: 'GET',
            path: `tenants/${encodeURIComponent(tenantId)}/files/${encodeURIComponent(fileId)}.json`,
        });
    }

    /** createReport */
    function createReport(opts: CreateReportArgs): Promise<ClientResponse<User>> {
        return client.request<User>({
            method: 'POST',
            path: 'reports',
            query: { 'format': opts.format },
            json: opts.body,
        });
    }

    /** updateNote */
    function updateNote(opts?: UpdateNoteArgs): Promise<ClientResponse<void>> {
        return client.request<void>({
            method: 'PATCH',
            path: 'notes',
            json: opts?.body,
        });
    }

    return {
        pingService,
        getUserById,
        searchEverything,
        downloadFileMetadata,
        createReport,
        updateNote,
    };
}
