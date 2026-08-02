/**
 * The one place a {@linkcode ServiceInstance} becomes a URL.
 *
 * @module
 */
import type { ServiceInstance } from '@hono-enterprise/common';

/**
 * Formats an instance as an absolute URL.
 *
 * IPv6 literals are bracketed: Kubernetes `endpoints[].addresses[]` are
 * canonical IP strings, which are IPv6 in a dual-stack or IPv6-only cluster,
 * and `AAAA` records have the same property. An unbracketed IPv6 host produces
 * a URL `fetch` rejects outright.
 *
 * @param instance - The chosen instance
 * @param path - Path appended to the origin, with or without a leading slash
 * @returns The absolute URL
 * @since 0.2.0
 */
export function instanceUrl(instance: ServiceInstance, path?: string): string {
  const scheme = instance.secure === true ? 'https' : 'http';
  const host = instance.host.includes(':') ? `[${instance.host}]` : instance.host;
  const origin = `${scheme}://${host}:${instance.port}`;

  if (path === undefined || path === '') {
    return origin;
  }
  return path.startsWith('/') ? `${origin}${path}` : `${origin}/${path}`;
}
