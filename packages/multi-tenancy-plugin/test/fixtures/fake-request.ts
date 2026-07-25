/**
 * Fake IRequest for testing.
 */
export function createFakeRequest(overrides?: {
  method?: string;
  url?: string;
  path?: string;
  headers?: Record<string, string>;
  tenant?: { id: string; name?: string; metadata?: Record<string, unknown> };
}): import('@hono-enterprise/common').IRequest {
  const baseHeaders = new Headers(overrides?.headers ?? {});
  return {
    method: overrides?.method ?? 'GET',
    url: overrides?.url ?? 'https://example.com/',
    path: overrides?.path ?? '/',
    headers: baseHeaders,
    get signal(): AbortSignal | undefined {
      return undefined;
    },
    set signal(_v) {/* no-op */},
    json<T = unknown>(): Promise<T> {
      return Promise.resolve({} as T);
    },
    text(): Promise<string> {
      return Promise.resolve('');
    },
    bytes(): Promise<Uint8Array> {
      return Promise.resolve(new Uint8Array());
    },
    // Writable fields — must use Object.defineProperty or cast.
    get user(): import('@hono-enterprise/common').IPrincipal | undefined {
      return undefined;
    },
    set user(_v: import('@hono-enterprise/common').IPrincipal | undefined) {/* no-op */},
    get tenant(): { id: string; name?: string; metadata?: Record<string, unknown> } | undefined {
      return overrides?.tenant;
    },
    set tenant(v: { id: string; name?: string; metadata?: Record<string, unknown> } | undefined) {
      (this as any).___tenant = v;
    },
  } as unknown as import('@hono-enterprise/common').IRequest;
}
