// deno-lint-ignore-file no-unused-vars
/**
 * Subdomain-based tenant resolver.
 *
 * @module
 */
import type { ITenant, ITenantResolver } from '@hono-enterprise/common';
import { none, type Option, some } from '@hono-enterprise/common';
import type { SubdomainResolverOptions } from '../interfaces/index.ts';

/**
 * Resolves the tenant id from the first subdomain label of `request.url`.
 *
 * @example
 * ```typescript
 * const resolver = new SubdomainResolver({ baseDomain: 'example.com' });
 * const result = await resolver.resolve({ url: 'https://acme.example.com' });
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
   */
  async resolve(request: import('@hono-enterprise/common').IRequest): Promise<Option<ITenant>> {
    let host: string;
    try {
      host = new URL(request.url).host;
    } catch {
      return none();
    }

    // Strip base domain if configured.
    if (this.baseDomain && host.endsWith(`.${this.baseDomain}`)) {
      host = host.slice(0, -(this.baseDomain.length + 1));
    }

    // Split the remaining host and check if there's a subdomain label.
    const parts = host.split('.');
    // When we had a baseDomain strip, `host` is now just the subdomain (one part).
    // When no baseDomain was set, `host` has 2+ parts like 'acme.example.com'.
    if (parts.length === 0) return none();

    // With baseDomain stripped: single part IS the subdomain.
    // Without baseDomain: first part of multi-part host is the subdomain.
    // No subdomain when the first label equals the full host (single-label host).
    if (parts.length === 1 && !this.baseDomain) {
      return none(); // e.g. 'localhost'
    }

    const label = parts[0];
    if (!label) return none();

    return some({ id: label });
  }
}
