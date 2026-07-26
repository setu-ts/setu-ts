/**
 * Subdomain-based tenant resolver.
 *
 * @module
 */
import type { IRequest, ITenant, ITenantResolver } from '@hono-enterprise/common';
import { none, type Option, some } from '@hono-enterprise/common';
import type { SubdomainResolverOptions } from '../interfaces/index.ts';

/**
 * Extracts the tenant label from a host, honouring an optional base domain.
 *
 * This is the decidable core of {@linkcode SubdomainResolver.resolve}, split
 * out so every branch is unit-testable without constructing a request.
 *
 * When `baseDomain` is configured it **constrains** resolution: only hosts that
 * are a strict subdomain of it yield a tenant. A host outside the base domain
 * (`evil.com`), or the apex itself (`example.com`), yields `null` — otherwise a
 * request to an unrelated domain would silently resolve a tenant.
 *
 * When `baseDomain` is absent, the first label of a multi-label host is the
 * tenant; a single-label host (`localhost`) yields `null`.
 *
 * @internal
 */
export function extractSubdomainTenant(
  host: string,
  baseDomain?: string,
): string | null {
  if (!host) return null;
  // Hosts may carry a port (`acme.example.com:8080`) — it is never part of the
  // domain comparison.
  const hostname = host.split(':')[0] ?? '';
  if (!hostname) return null;

  if (baseDomain !== undefined && baseDomain !== '') {
    const suffix = `.${baseDomain}`;
    // The apex domain itself carries no tenant, and neither does any host that
    // is not under the configured base domain.
    if (!hostname.endsWith(suffix)) return null;
    const label = hostname.slice(0, -suffix.length);
    if (!label) return null;
    // `a.b.example.com` → take the left-most label as the tenant.
    return label.split('.')[0] || null;
  }

  const parts = hostname.split('.');
  if (parts.length < 2) return null; // e.g. 'localhost'
  return parts[0] || null;
}

/**
 * Resolves the tenant id from the first subdomain label of `request.url`.
 *
 * @example
 * ```typescript
 * const resolver = new SubdomainResolver({ baseDomain: 'example.com' });
 * const result = await resolver.resolve(request); // url: https://acme.example.com
 * // => some({ id: 'acme' })
 * ```
 */
export class SubdomainResolver implements ITenantResolver {
  private readonly baseDomain: string | undefined;

  constructor(options?: SubdomainResolverOptions) {
    this.baseDomain = options?.baseDomain;
  }

  /**
   * Resolve the tenant id from the request's subdomain.
   *
   * @param request - The incoming request
   * @returns `Some` with the tenant, or `None` when the host carries no tenant
   */
  resolve(request: IRequest): Promise<Option<ITenant>> {
    let host: string;
    try {
      host = new URL(request.url).host;
    } catch {
      return Promise.resolve(none());
    }

    const label = extractSubdomainTenant(host, this.baseDomain);
    return Promise.resolve(label === null ? none() : some({ id: label }));
  }
}
