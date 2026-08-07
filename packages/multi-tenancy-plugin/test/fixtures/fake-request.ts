/**
 * Fake IRequest for testing.
 */
export function createFakeRequest(overrides?: {
  method?: string;
  url?: string;
  path?: string;
  headers?: Record<string, string>;
  tenant?: { id: string; name?: string; metadata?: Record<string, unknown> };
}): import('@setu-ts/common').IRequest {
  let storedTenant: { id: string; name?: string; metadata?: Record<string, unknown> } | undefined;
  let storedUser: import('@setu-ts/common').IPrincipal | undefined;
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
    // Writable fields — genuinely readable back, as on the real `IRequest`:
    // a no-op setter here would let a middleware bug that never writes the
    // field pass its own test.
    get user(): import('@setu-ts/common').IPrincipal | undefined {
      return storedUser;
    },
    set user(v: import('@setu-ts/common').IPrincipal | undefined) {
      storedUser = v;
    },
    get tenant(): { id: string; name?: string; metadata?: Record<string, unknown> } | undefined {
      return storedTenant ?? overrides?.tenant;
    },
    set tenant(v: { id: string; name?: string; metadata?: Record<string, unknown> } | undefined) {
      storedTenant = v;
    },
  } as unknown as import('@setu-ts/common').IRequest;
}
