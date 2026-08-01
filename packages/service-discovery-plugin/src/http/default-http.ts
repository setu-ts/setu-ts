/**
 * The default {@linkcode IDiscoveryHttp}, over web-standard `fetch`.
 *
 * Consul and the Kubernetes API server are plain HTTP JSON, so there is no
 * client library worth an `npm:` import and this package ships an empty
 * dependency graph. `fetch` is injectable so every provider test drives the
 * real seam without a socket.
 *
 * @module
 */
import type {
  DiscoveryHttpResponse,
  DiscoveryHttpStream,
  IDiscoveryHttp,
} from '../interfaces/index.ts';

/**
 * Creates the default HTTP seam.
 *
 * @param fetchImpl - The `fetch` implementation (defaults to the global)
 * @returns An {@linkcode IDiscoveryHttp} over `fetch`
 * @since 0.2.0
 */
export function createDefaultDiscoveryHttp(
  fetchImpl: typeof fetch = fetch,
): IDiscoveryHttp {
  return {
    async request(url: string, init?: RequestInit): Promise<DiscoveryHttpResponse> {
      const response = await fetchImpl(url, init);
      // Read unconditionally, including on a non-2xx: leaving the body
      // undrained keeps the connection from being reused.
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        text,
      };
    },

    async stream(url: string, init?: RequestInit): Promise<DiscoveryHttpStream> {
      const response = await fetchImpl(url, init);
      return {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        body: response.body,
      };
    },
  };
}
